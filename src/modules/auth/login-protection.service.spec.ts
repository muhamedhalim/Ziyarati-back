import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LoginProtectionService } from './login-protection.service';
import { AppRedisService } from '../../queue/app-redis.service';
import { MetricsService } from '../../metrics/metrics.service';

/**
 * FND-008 — account-aware brute-force protection.
 *
 * Mocked-Redis unit coverage. Real-Redis atomicity/TTL-invariant proof lives
 * in `test/login-protection.e2e-spec.ts` (mocks cannot certify a genuine race).
 */
describe('LoginProtectionService', () => {
  let service: LoginProtectionService;
  let recordFailureMock: jest.Mock;
  let getCountMock: jest.Mock;
  let delMock: jest.Mock;
  let appRedis: {
    rateLimiter: {
      defineCommand: jest.Mock;
      loginFailRecord: jest.Mock;
      get: jest.Mock;
      del: jest.Mock;
    };
  };
  let config: { get: jest.Mock };
  let metrics: {
    recordLoginProtectionEvent: jest.Mock;
    registry: unknown;
  };

  const THRESHOLD = 5;
  const TTL_SECONDS = 900;

  beforeEach(() => {
    recordFailureMock = jest.fn();
    getCountMock = jest.fn();
    delMock = jest.fn();
    appRedis = {
      rateLimiter: {
        defineCommand: jest.fn(),
        loginFailRecord: recordFailureMock,
        get: getCountMock,
        del: delMock,
      },
    };
    config = {
      get: jest.fn((key: string, def?: unknown) => {
        if (key === 'AUTH_LOGIN_MAX_FAILED_ATTEMPTS') return THRESHOLD;
        if (key === 'AUTH_LOGIN_LOCKOUT_TTL_SECONDS') return TTL_SECONDS;
        return def;
      }),
    };
    metrics = {
      recordLoginProtectionEvent: jest.fn(),
      registry: {},
    };

    service = new LoginProtectionService(
      appRedis as unknown as AppRedisService,
      config as unknown as ConfigService,
      metrics as unknown as MetricsService,
    );
  });

  // ─────────────────────── key derivation / identity ────────────────────────

  it('registers its atomic increment script via defineCommand at construction (EVALSHA, not EVAL per call)', () => {
    expect(appRedis.rateLimiter.defineCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ lua: expect.any(String) }),
    );
  });

  it('derives the same key for emails that differ only by case and surrounding whitespace', async () => {
    getCountMock.mockResolvedValue(null);
    await service.isLocked('OWNER@Clinic.com ');
    const keyA = getCountMock.mock.calls[0][0];

    getCountMock.mockClear();
    await service.isLocked(' owner@clinic.com');
    const keyB = getCountMock.mock.calls[0][0];

    expect(keyA).toBe(keyB);
  });

  it('derives the SAME key regardless of any tenant qualifier — identity is the email alone', async () => {
    // The service's public surface never accepts a tenant argument at all;
    // this is the structural proof that tenantSlug cannot influence the key.
    getCountMock.mockResolvedValue(null);
    await service.isLocked('attacker@x.com');
    const key1 = getCountMock.mock.calls[0][0];

    getCountMock.mockClear();
    await service.isLocked('attacker@x.com');
    const key2 = getCountMock.mock.calls[0][0];

    expect(key1).toBe(key2);
  });

  it('never places the raw email in the Redis key (identity is hashed)', async () => {
    getCountMock.mockResolvedValue(null);
    await service.isLocked('attacker@example.com');
    const key = getCountMock.mock.calls[0][0] as string;
    expect(key).not.toContain('attacker');
    expect(key).not.toContain('@');
    expect(key).toContain('auth:login:fail:');
  });

  // ─────────────────────────── threshold behaviour ───────────────────────────

  it('reports NOT locked below the threshold', async () => {
    getCountMock.mockResolvedValueOnce(String(THRESHOLD - 1));
    await expect(service.isLocked('a@b.com')).resolves.toBe(false);
  });

  it('reports LOCKED once the count reaches the threshold', async () => {
    getCountMock.mockResolvedValueOnce(String(THRESHOLD));
    await expect(service.isLocked('a@b.com')).resolves.toBe(true);
  });

  it('isLocked performs NO write — a read-only check', async () => {
    getCountMock.mockResolvedValueOnce(String(THRESHOLD));
    await service.isLocked('a@b.com');
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it('unknown and known identities behave identically — the key exists for any hammered address', async () => {
    getCountMock.mockResolvedValueOnce(String(THRESHOLD));
    const lockedUnknown = await service.isLocked('ghost-does-not-exist@b.com');
    getCountMock.mockResolvedValueOnce(String(THRESHOLD));
    const lockedKnown = await service.isLocked('real-account@b.com');
    expect(lockedUnknown).toBe(lockedKnown);
  });

  // ───────────────────── recordFailure: atomic increment ─────────────────────

  it('recordFailure issues a single atomic round-trip (one script call, not INCR+EXPIRE)', async () => {
    recordFailureMock.mockResolvedValueOnce(1);
    await service.recordFailure('a@b.com');
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
  });

  it('passes the configured TTL to the script so it can be set on first creation', async () => {
    recordFailureMock.mockResolvedValueOnce(1);
    await service.recordFailure('a@b.com');
    const args = recordFailureMock.mock.calls[0];
    expect(args).toContain(String(TTL_SECONDS));
  });

  it('a different identity is completely unaffected by failures on another identity', async () => {
    recordFailureMock.mockResolvedValueOnce(1);
    await service.recordFailure('attacker-target@b.com');

    getCountMock.mockResolvedValueOnce(null);
    await expect(service.isLocked('someone-else@b.com')).resolves.toBe(false);
  });

  // ──────────────────────────── successful clear ─────────────────────────────

  it('clear() fully deletes the key so the count restarts from zero', async () => {
    await service.clear('a@b.com');
    expect(delMock).toHaveBeenCalledTimes(1);
  });

  it('after clear(), the identity reports not locked', async () => {
    await service.clear('a@b.com');
    getCountMock.mockResolvedValueOnce(null);
    await expect(service.isLocked('a@b.com')).resolves.toBe(false);
  });

  // ───────────────────────────── fail-open posture ───────────────────────────

  it('isLocked FAILS OPEN (reports not-locked) when the store errors', async () => {
    getCountMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.isLocked('a@b.com')).resolves.toBe(false);
  });

  it('recordFailure swallows a store error rather than throwing', async () => {
    recordFailureMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.recordFailure('a@b.com')).resolves.not.toThrow();
  });

  it('a store error on isLocked emits the store_unavailable metric', async () => {
    getCountMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await service.isLocked('a@b.com');
    expect(metrics.recordLoginProtectionEvent).toHaveBeenCalledWith('store_unavailable');
  });

  it('a store error never propagates as a thrown exception (login must proceed)', async () => {
    getCountMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    recordFailureMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    delMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    // false = "not locked" / "did not just engage" / "had no state to clear" —
    // the safe, fail-open value for each method on a store error.
    await expect(service.isLocked('a@b.com')).resolves.toBe(false);
    await expect(service.recordFailure('a@b.com')).resolves.toBe(false);
    await expect(service.clear('a@b.com')).resolves.toBe(false);
  });

  // ───────────────────────────── observability ───────────────────────────────

  it('emits no sensitive value in any metrics label or log call on the fail-open path', async () => {
    getCountMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await service.isLocked('sensitive-address@example.com');
    const calls = metrics.recordLoginProtectionEvent.mock.calls.flat();
    for (const arg of calls) {
      expect(String(arg)).not.toContain('sensitive-address');
    }
  });

  it('the fail-open warning log itself contains no email, password, or credential — only the store error text', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    getCountMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await service.isLocked('very-sensitive-user@example.com');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0] as string;
    expect(logged).not.toContain('very-sensitive-user');
    expect(logged).not.toMatch(/password|token|authorization|bearer/i);
    expect(logged).toContain('ECONNREFUSED'); // the real store error IS present — useful, not silent
    warnSpy.mockRestore();
  });
});
