import { ConfigService } from '@nestjs/config';

import { FixedWindowLimiterService } from './fixed-window-limiter.service';
import { AppRedisService } from './app-redis.service';
import { MetricsService } from '../metrics/metrics.service';

describe('FixedWindowLimiterService (ZT-002, ZT-006)', () => {
  let service: FixedWindowLimiterService;
  let incrMock: jest.Mock;
  let getMock: jest.Mock;
  let defineCommandMock: jest.Mock;
  let appRedis: { rateLimiter: Record<string, jest.Mock> };
  let config: ConfigService;
  let metrics: MetricsService;

  const DEGRADED_FACTOR = 0.5;
  const FALLBACK_WIDTH = 4096;

  beforeEach(() => {
    incrMock = jest.fn();
    getMock = jest.fn();
    defineCommandMock = jest.fn();
    appRedis = {
      rateLimiter: {
        defineCommand: defineCommandMock,
        fixedWindowIncr: incrMock,
        get: getMock,
      },
    };
    config = {
      get: jest.fn((key: string, def?: unknown) => {
        if (key === 'AUTH_ABUSE_DEGRADED_FACTOR') return DEGRADED_FACTOR;
        if (key === 'AUTH_ABUSE_FALLBACK_WIDTH') return FALLBACK_WIDTH;
        return def;
      }),
    } as unknown as ConfigService;
    metrics = new MetricsService();

    service = new FixedWindowLimiterService(
      appRedis as unknown as AppRedisService,
      config,
      metrics,
    );
  });

  it('registers its atomic increment script via defineCommand at construction', () => {
    expect(defineCommandMock).toHaveBeenCalledWith(
      'fixedWindowIncr',
      expect.objectContaining({ lua: expect.any(String) }),
    );
  });

  describe('healthy Redis path', () => {
    it('returns the Redis result: allowed while at/under the limit', async () => {
      incrMock.mockResolvedValueOnce(3);
      const decision = await service.consume('forgot', 'digest-a', 5, 900);
      expect(decision).toEqual({ allowed: true, degraded: false, count: 3 });
    });

    it('returns refused once the count exceeds the limit', async () => {
      incrMock.mockResolvedValueOnce(6);
      const decision = await service.consume('forgot', 'digest-a', 5, 900);
      expect(decision.allowed).toBe(false);
      expect(decision.degraded).toBe(false);
    });

    it('passes the window length (seconds) as the TTL argument', async () => {
      incrMock.mockResolvedValueOnce(1);
      await service.consume('register_endpoint', 'all', 1000, 3600);
      const [, ttlArg] = incrMock.mock.calls[0];
      expect(ttlArg).toBe('3600');
    });

    it('peek() reads without incrementing', async () => {
      getMock.mockResolvedValueOnce('4');
      const decision = await service.peek('reset_invalid', 'all', 100, 900);
      expect(decision).toEqual({ allowed: true, degraded: false, count: 4 });
      expect(incrMock).not.toHaveBeenCalled();
    });

    it('peek() reports refused once the read count reaches the limit', async () => {
      getMock.mockResolvedValueOnce('100');
      const decision = await service.peek('reset_invalid', 'all', 100, 900);
      expect(decision.allowed).toBe(false);
    });

    it('never places a raw subject in the Redis key — only the caller-supplied (already-hashed) digest', async () => {
      incrMock.mockResolvedValueOnce(1);
      await service.consume('forgot', 'deadbeef'.repeat(8), 5, 900);
      const [key] = incrMock.mock.calls[0];
      expect(key).toContain('auth:abuse:forgot:');
      expect(key).toContain('deadbeef'.repeat(8));
    });
  });

  describe('degraded fallback (Redis error)', () => {
    it('falls back to the local counter at ceil(limit × degradedFactor) — stricter than healthy mode', async () => {
      incrMock.mockRejectedValue(new Error('ECONNREFUSED'));
      // limit=5, factor=0.5 -> degradedLimit = ceil(2.5) = 3
      let last;
      for (let i = 0; i < 4; i++) {
        last = await service.consume('forgot', 'digest-b', 5, 900);
      }
      expect(last).toEqual(expect.objectContaining({ degraded: true }));
      expect(last!.allowed).toBe(false); // 4th hit exceeds degradedLimit=3
    });

    it('a fresh identity with no local history is allowed while degraded', async () => {
      incrMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const decision = await service.consume('forgot', 'fresh-digest', 5, 900);
      expect(decision.allowed).toBe(true);
      expect(decision.degraded).toBe(true);
    });

    it('degraded peek() does not increment the local counter', async () => {
      incrMock.mockRejectedValue(new Error('ECONNREFUSED'));
      getMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await service.peek('reset_invalid', 'all', 10, 900);
      const after = await service.peek('reset_invalid', 'all', 10, 900);
      expect(after.count).toBe(0);
    });

    it('a peek()-then-consume() pair at the degraded boundary admits exactly degradedLimit, not one extra (regression, T094)', async () => {
      incrMock.mockRejectedValue(new Error('ECONNREFUSED'));
      getMock.mockRejectedValue(new Error('ECONNREFUSED'));
      // limit=10, factor=0.5 -> degradedLimit = 5. Mirrors resetPassword()'s
      // own call shape: peek() gates entry, consume() only runs (and
      // increments) when the caller decides to record a failure.
      const admitted: boolean[] = [];
      for (let i = 0; i < 7; i++) {
        const gate = await service.peek('reset_invalid', 'all', 10, 900);
        admitted.push(gate.allowed);
        if (gate.allowed) {
          await service.consume('reset_invalid', 'all', 10, 900);
        }
      }
      expect(admitted.filter(Boolean)).toHaveLength(5); // exactly degradedLimit, never 6
    });

    it('independent scopes never share a degraded fallback bucket', async () => {
      incrMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await service.consume('forgot', 'same-digest', 100, 900);
      const registerDecision = await service.consume(
        'register_identity',
        'same-digest',
        100,
        3600,
      );
      expect(registerDecision.count).toBe(1); // not 2 — the two scopes are independent
    });

    it('records degraded_refused/degraded_allowed on the shared metric', async () => {
      const spy = jest.spyOn(metrics, 'recordAuthAbuseLimiterEvent');
      incrMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await service.consume('forgot', 'metric-digest', 5, 900);
      expect(spy).toHaveBeenCalledWith('forgot', 'degraded_allowed');
    });
  });

  describe('automatic Redis re-authority (FR-032, SC-011)', () => {
    it('every call tries Redis first — a prior degraded decision never overrides a later healthy one', async () => {
      incrMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const degraded = await service.consume('forgot', 'digest-c', 5, 900);
      expect(degraded.degraded).toBe(true);

      incrMock.mockResolvedValueOnce(1);
      const recovered = await service.consume('forgot', 'digest-c', 5, 900);
      expect(recovered.degraded).toBe(false);
      expect(incrMock).toHaveBeenCalledTimes(2); // Redis attempted on BOTH calls — no sticky circuit state
    });
  });
});
