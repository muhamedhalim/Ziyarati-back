import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { AppRedisService } from '../../queue/app-redis.service';
import { cacheKeyPrefix } from '../../queue/queue.constants';
import { BoundedLocalCounter } from '../../queue/bounded-local-counter';
import { DegradedModeLogLimiter } from '../../queue/degraded-mode-log-limiter';
import { ErrorCode } from '../../common/errors';

declare module 'ioredis' {
  interface Redis {
    aiWsTurnRecord(key: string, ttlSeconds: string): Promise<number>;
  }
}

export type AiWsRateLimitTier = 'authenticated' | 'guest';

export interface AiWsRateLimitDecision {
  allowed: boolean;
  /** Present only when `allowed` is false — which existing ErrorCode to emit. */
  code?: ErrorCode.RATE_LIMITED | ErrorCode.SERVICE_UNAVAILABLE;
}

/**
 * AI-015/AI-028 (FR-051-FR-055, FR-078, D5, R2, Principle XXIII). Bounds how
 * many `ai:message` turns one identity may start within a sliding window —
 * the realtime transport had NO rate limit of any kind (`AI-015`'s finding).
 *
 * Modeled on {@link LoginProtectionService} for the healthy/degraded split,
 * with two deliberate differences dictated by what this control actually is:
 *
 *  - **Identity, never client-supplied**: the caller passes the resolved
 *    identity string (authenticated user id, else the guest subject from the
 *    handshake token, else the Socket.IO connection id) — this service never
 *    reads anything off the wire itself (FR-052). The key is
 *    `${cacheKeyPrefix()}ai:ws:turn:${sha256(identity)}` — one bucket per
 *    identity, never a shared global bucket (the audit's own reproduction of
 *    a shared-bucket design being defeated by concurrency).
 *  - **Fails CLOSED, not open** (Principle XXIII: "admission-control
 *    dependencies fail CLOSED with SERVICE_UNAVAILABLE" — unlike
 *    `LoginProtectionService`, which is carved out because blocking login
 *    entirely during a Redis outage would itself be the denial of service
 *    FR-019 forbids). This is a resource-admission control, not an
 *    availability-critical auth path, so the default posture is refusal.
 *    The bounded local counter is not a fail-open escape hatch — it is the
 *    FLOOR of continued protection during the outage: turns within the
 *    stricter local cap still proceed (so a transient blip does not kill the
 *    feature outright), but once even that stricter cap is exceeded, the
 *    turn is refused with `SERVICE_UNAVAILABLE` rather than `RATE_LIMITED`
 *    (signaling "the limiter itself is degraded," not "you hit the normal
 *    threshold").
 *
 * **Invalidation**: natural key expiry only. Unlike login protection there is
 * no "success" event for a turn that should reset the count — every turn,
 * successful or not, counts toward the window.
 *
 * **Not a subscription-style quota** (FR-054): guests have no subscription;
 * metering them via `UsageService` would be incoherent. This is a pure
 * connection/time-window admission control, entirely separate from —  and
 * does not alter — the guest discovery tenant's unlimited free-access
 * override (FR-078, `guest-session.service.ts:96-106`, untouched).
 */
@Injectable()
export class AiWsRateLimitService {
  private readonly logger = new Logger('AiWsRateLimitService');
  private readonly degradedLog = new DegradedModeLogLimiter(
    this.logger,
    'AI WS rate limiter',
  );

  // KEYS: [counterKey]
  // ARGV: [ttlSeconds]
  // Same atomic increment-and-conditional-expire shape as
  // LoginProtectionService.RECORD_FAILURE_SCRIPT — TTL is set ONLY on the
  // increment that creates the key, never refreshed on a later hit, so the
  // window is fixed from the identity's FIRST turn, not a sliding lockout
  // that never expires under sustained use.
  private static readonly RECORD_TURN_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  /** Bounded degraded-mode fallback — used ONLY when `appRedis.rateLimiter` errors. */
  private readonly fallback: BoundedLocalCounter;

  constructor(
    private readonly appRedis: AppRedisService,
    private readonly config: ConfigService,
  ) {
    this.appRedis.rateLimiter.defineCommand('aiWsTurnRecord', {
      numberOfKeys: 1,
      lua: AiWsRateLimitService.RECORD_TURN_SCRIPT,
    });
    // Sized against the STRICTER of the two windows (guest, by default) so
    // the fixed-memory table's window rotation matches whichever tier is
    // currently being checked closely enough in practice; both tiers share
    // this one process-local table (identity strings do not collide across
    // tiers — a real user id vs. a guest subject vs. a connection id are
    // drawn from disjoint id spaces).
    this.fallback = new BoundedLocalCounter({
      width: this.config.get<number>('AUTH_ABUSE_FALLBACK_WIDTH', 4096),
      depth: 3,
      windowMs: this.windowSeconds('guest') * 1000,
    });
  }

  /**
   * Checks AND records one turn attempt in a single call — this control has
   * no separate "peek" use case the way login protection's `isLocked` does
   * (nothing here needs to check status without also counting the attempt).
   */
  async checkAndRecord(
    identity: string,
    tier: AiWsRateLimitTier,
  ): Promise<AiWsRateLimitDecision> {
    const key = this.keyFor(identity);
    const ttl = this.windowSeconds(tier);
    const threshold = this.maxTurns(tier);
    try {
      const count = await this.appRedis.rateLimiter.aiWsTurnRecord(
        key,
        String(ttl),
      );
      this.degradedLog.recordSuccess();
      if (count > threshold) {
        return { allowed: false, code: ErrorCode.RATE_LIMITED };
      }
      return { allowed: true };
    } catch (err) {
      return this.degradedCheckAndRecord(key, tier, err);
    }
  }

  /**
   * The Redis key: namespaced via the existing `cacheKeyPrefix()` helper,
   * holding a SHA-256 hash of the identity rather than the raw id — same
   * rationale as `LoginProtectionService.keyFor` (Redis keys surface in
   * `MONITOR`/`SLOWLOG`/`--bigkeys`/RDB dumps).
   */
  private keyFor(identity: string): string {
    const hash = createHash('sha256').update(identity).digest('hex');
    return `${cacheKeyPrefix()}ai:ws:turn:${hash}`;
  }

  private maxTurns(tier: AiWsRateLimitTier): number {
    return tier === 'authenticated'
      ? this.config.get<number>('AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS', 30)
      : this.config.get<number>('AI_WS_RATE_LIMIT_GUEST_MAX_TURNS', 15);
  }

  private windowSeconds(tier: AiWsRateLimitTier): number {
    return tier === 'authenticated'
      ? this.config.get<number>(
          'AI_WS_RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS',
          60,
        )
      : this.config.get<number>('AI_WS_RATE_LIMIT_GUEST_WINDOW_SECONDS', 60);
  }

  /** Degraded-mode limit — always stricter than the healthy threshold (mirrors LoginProtectionService's degradedThreshold). */
  private degradedMaxTurns(tier: AiWsRateLimitTier): number {
    const factor = this.config.get<number>('AUTH_ABUSE_DEGRADED_FACTOR', 0.5);
    return Math.max(1, Math.ceil(this.maxTurns(tier) * factor));
  }

  /**
   * Fail CLOSED (Principle XXIII), not open: below the stricter local floor,
   * the turn still proceeds (bounded continued protection); at or above it,
   * the turn is refused with SERVICE_UNAVAILABLE — the limiter itself could
   * not be consulted, so this is NOT the normal RATE_LIMITED refusal.
   */
  private degradedCheckAndRecord(
    key: string,
    tier: AiWsRateLimitTier,
    err: unknown,
  ): AiWsRateLimitDecision {
    this.degradedLog.recordFailure((err as Error)?.message ?? String(err));
    const count = this.fallback.increment(key);
    if (count > this.degradedMaxTurns(tier)) {
      return { allowed: false, code: ErrorCode.SERVICE_UNAVAILABLE };
    }
    return { allowed: true };
  }
}
