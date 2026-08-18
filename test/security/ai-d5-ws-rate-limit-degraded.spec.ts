/**
 * T115 (AI-015, FR-051, R2, Principle XXIII) — the WS rate limiter's
 * degraded mode when Redis is unavailable.
 *
 * A unit-level seam test against `AiWsRateLimitService` directly (mocked
 * `AppRedisService`), matching plan.md's own Layer 3 framing — this is not
 * an infrastructure e2e test; the property under test is the SERVICE's own
 * fail-closed decision logic, independent of any real Redis container.
 *
 * Constitution Principle XXIII: "admission-control dependencies fail CLOSED
 * with SERVICE_UNAVAILABLE" — the opposite default from a cache (which fails
 * open). Proves two things together, since either one alone would be wrong:
 *  1. Redis unavailable does NOT become an unlimited-spend window (AI-028's
 *     own concern) — a sustained outage still hits a real refusal.
 *  2. Redis unavailable does NOT become a total, immediate refusal either —
 *     the bounded local counter is a FLOOR of continued protection: turns
 *     within the stricter degraded threshold still proceed.
 */
import { ErrorCode } from '../../src/common/errors';
import {
  AiWsRateLimitService,
  type AiWsRateLimitTier,
} from '../../src/modules/ai-realtime/ai-ws-rate-limit.service';

describe('AI WS rate limiter — degraded mode when Redis is unavailable (T115)', () => {
  function buildService(opts: {
    authenticatedMaxTurns?: number;
    guestMaxTurns?: number;
    windowSeconds?: number;
    degradedFactor?: number;
    fallbackWidth?: number;
  } = {}) {
    const redisError = new Error('connection lost');
    const rateLimiterClient = {
      defineCommand: jest.fn(),
      aiWsTurnRecord: jest.fn().mockRejectedValue(redisError),
    };
    const appRedis = { rateLimiter: rateLimiterClient };
    const configValues: Record<string, number> = {
      AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS: opts.authenticatedMaxTurns ?? 30,
      AI_WS_RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS: opts.windowSeconds ?? 60,
      AI_WS_RATE_LIMIT_GUEST_MAX_TURNS: opts.guestMaxTurns ?? 15,
      AI_WS_RATE_LIMIT_GUEST_WINDOW_SECONDS: opts.windowSeconds ?? 60,
      AUTH_ABUSE_DEGRADED_FACTOR: opts.degradedFactor ?? 0.5,
      AUTH_ABUSE_FALLBACK_WIDTH: opts.fallbackWidth ?? 4096,
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => configValues[key] ?? fallback),
    };
    const service = new AiWsRateLimitService(
      appRedis as never,
      config as never,
    );
    return { service, rateLimiterClient };
  }

  it('registers the Lua script exactly once at construction (mirrors LoginProtectionService)', () => {
    const { rateLimiterClient } = buildService();
    expect(rateLimiterClient.defineCommand).toHaveBeenCalledTimes(1);
    expect(rateLimiterClient.defineCommand).toHaveBeenCalledWith(
      'aiWsTurnRecord',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it('a turn within the degraded floor still proceeds despite Redis being down (not a total outage refusal)', async () => {
    // degradedMaxTurns = ceil(30 * 0.5) = 15 for authenticated.
    const { service } = buildService({ authenticatedMaxTurns: 30, degradedFactor: 0.5 });

    const result = await service.checkAndRecord('user-1', 'authenticated');

    expect(result.allowed).toBe(true);
    expect(result.code).toBeUndefined();
  });

  it('fails CLOSED with SERVICE_UNAVAILABLE once the degraded floor itself is exceeded — never an unlimited-spend window', async () => {
    // degradedMaxTurns = ceil(4 * 0.5) = 2 — small on purpose, so the test
    // does not need dozens of calls to reach the degraded cap.
    const { service } = buildService({ authenticatedMaxTurns: 4, degradedFactor: 0.5 });
    const identity = 'user-flood';

    const first = await service.checkAndRecord(identity, 'authenticated');
    const second = await service.checkAndRecord(identity, 'authenticated');
    const third = await service.checkAndRecord(identity, 'authenticated');

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Third call exceeds the degraded cap of 2 — refused, fail-closed.
    expect(third.allowed).toBe(false);
    expect(third.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });

  it('the fail-closed refusal is SERVICE_UNAVAILABLE, never RATE_LIMITED — distinguishable from a normal healthy-path throttle', async () => {
    const { service } = buildService({ authenticatedMaxTurns: 2, degradedFactor: 0.5 });
    const identity = 'user-distinguish';

    await service.checkAndRecord(identity, 'authenticated'); // degradedMax = 1, this one proceeds
    const refused = await service.checkAndRecord(identity, 'authenticated');

    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(refused.code).not.toBe(ErrorCode.RATE_LIMITED);
  });

  it('the degraded threshold is stricter for guests than for authenticated principals, mirroring the healthy-path asymmetry', async () => {
    const { service } = buildService({
      authenticatedMaxTurns: 30, // degraded = 15
      guestMaxTurns: 4, // degraded = 2
      degradedFactor: 0.5,
    });

    // A guest identity hits its (lower) degraded cap after 2 calls.
    const guestId = 'guest-degraded';
    await service.checkAndRecord(guestId, 'guest');
    await service.checkAndRecord(guestId, 'guest');
    const guestRefused = await service.checkAndRecord(guestId, 'guest');
    expect(guestRefused.allowed).toBe(false);

    // The SAME call count for an authenticated identity (higher degraded
    // cap) still proceeds — proves the tier genuinely changes the outcome,
    // not just the healthy-path config.
    const staffId = 'staff-degraded';
    await service.checkAndRecord(staffId, 'authenticated');
    await service.checkAndRecord(staffId, 'authenticated');
    const staffResult = await service.checkAndRecord(staffId, 'authenticated');
    expect(staffResult.allowed).toBe(true);
  });

  it('distinct identities each get their own independent degraded counter — never a shared global bucket', async () => {
    const { service } = buildService({ authenticatedMaxTurns: 2, degradedFactor: 0.5 }); // degraded = 1

    const a = await service.checkAndRecord('identity-a', 'authenticated');
    const b = await service.checkAndRecord('identity-b', 'authenticated');

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true); // a fresh identity, not affected by identity-a's own count
  });

  it('recovers cleanly once Redis becomes available again — the degraded path does not permanently latch', async () => {
    const { service, rateLimiterClient } = buildService({ authenticatedMaxTurns: 30 });

    const degraded = await service.checkAndRecord('user-recover', 'authenticated');
    expect(degraded.allowed).toBe(true); // still within the degraded floor

    // Redis recovers — the healthy path is consulted again.
    rateLimiterClient.aiWsTurnRecord.mockResolvedValueOnce(1);
    const recovered = await service.checkAndRecord('user-recover', 'authenticated');

    expect(recovered.allowed).toBe(true);
    expect(recovered.code).toBeUndefined();
  });

  it.each<AiWsRateLimitTier>(['authenticated', 'guest'])(
    'applies the fail-closed floor for the %s tier specifically (not just a hardcoded default)',
    async (tier) => {
      const { service } = buildService({
        authenticatedMaxTurns: 2,
        guestMaxTurns: 2,
        degradedFactor: 0.5,
      });
      const identity = `identity-${tier}`;

      await service.checkAndRecord(identity, tier);
      const second = await service.checkAndRecord(identity, tier);

      expect(second.allowed).toBe(false);
      expect(second.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    },
  );
});
