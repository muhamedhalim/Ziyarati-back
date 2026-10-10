import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';

import { FailsafeThrottlerStorage } from './failsafe-throttler-storage';
import { MetricsService } from '../metrics/metrics.service';

describe('FailsafeThrottlerStorage', () => {
  let metrics: MetricsService;
  let recordSpy: jest.SpyInstance;

  beforeEach(() => {
    metrics = new MetricsService();
    recordSpy = jest.spyOn(metrics, 'recordThrottlerStorageEvent');
  });

  it('returns the primary storage result unchanged when Redis is available', async () => {
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockResolvedValue({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics);

    const result = await storage.increment(
      'key',
      60_000,
      300,
      60_000,
      'default',
    );

    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(primary.increment).toHaveBeenCalledWith(
      'key',
      60_000,
      300,
      60_000,
      'default',
    );
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('degrades to the in-memory fallback and records a metric when the primary throws', async () => {
    const primary: ThrottlerStorage = {
      increment: jest
        .fn()
        .mockRejectedValue(
          new Error(
            "Stream isn't writeable and enableOfflineQueue options is false",
          ),
        ),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics);

    const result = await storage.increment(
      'key',
      60_000,
      300,
      60_000,
      'default',
    );

    expect(result.isBlocked).toBe(false);
    expect(result.totalHits).toBe(1);
    expect(recordSpy).toHaveBeenCalledWith('redis_unavailable');
  });

  it('still enforces a limit locally while Redis stays unavailable (degraded mode, not disabled)', async () => {
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics);

    let lastResult:
      | Awaited<ReturnType<FailsafeThrottlerStorage['increment']>>
      | undefined;
    for (let i = 0; i < 5; i++) {
      lastResult = await storage.increment(
        'same-key',
        60_000,
        3,
        60_000,
        'default',
      );
    }

    expect(lastResult?.isBlocked).toBe(true);
    expect(lastResult?.totalHits).toBeGreaterThan(3);
    expect(recordSpy).toHaveBeenCalledTimes(5);
  });

  it('resumes using Redis on the very next call once it recovers (no sticky fallback state)', async () => {
    const increment = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    const primary: ThrottlerStorage = { increment };
    const storage = new FailsafeThrottlerStorage(primary, metrics);

    const duringOutage = await storage.increment(
      'key',
      60_000,
      300,
      60_000,
      'default',
    );
    const afterRecovery = await storage.increment(
      'key',
      60_000,
      300,
      60_000,
      'default',
    );

    expect(duringOutage.isBlocked).toBe(false);
    expect(afterRecovery).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(increment).toHaveBeenCalledTimes(2);
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  // ── 009-auth-abuse-resistance additions (ZT-002) ─────────────────────────

  it('stays bounded under 100,000 distinct trackers while Redis is unavailable (SC-010) — no unbounded Map, no O(n²) timer-array blowup', async () => {
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics, 4096);

    // The OLD `ThrottlerStorageService` fallback this replaces allocates a
    // Map entry PLUS a setTimeout per hit, with an O(n) `filter` over a
    // shared timer array on every expiry — O(n²) across a burst. That
    // combination would make 100,000 distinct keys measurably slow (seconds
    // to tens of seconds) in addition to growing memory linearly with key
    // count. Completing in linear time, on top of BoundedLocalCounter's own
    // deterministic allocatedBytes proof (bounded-local-counter.spec.ts),
    // is itself evidence neither defect survived the replacement.
    //
    // The proof is the SCALING between two burst sizes, not an absolute wall
    // clock: an absolute 5 s bound passed alone (4.4 s) but failed on a loaded
    // CI runner running suites in parallel (5.4–5.9 s) without any code change.
    // A 10x larger burst must cost roughly 10x as much (linear); quadratic
    // growth would cost ~100x. The ratio is independent of machine speed.
    const burst = async (n: number, prefix: string): Promise<number> => {
      const startedAt = process.hrtime.bigint();
      for (let i = 0; i < n; i++) {
        await storage.increment(
          `${prefix}-${i}`,
          60_000,
          300,
          60_000,
          'default',
        );
      }
      return Number(process.hrtime.bigint() - startedAt) / 1e6;
    };
    const smallMs = await burst(10_000, 'small');
    const largeMs = await burst(100_000, 'large');
    // Linear ≈ 10x; allow 3x headroom for GC/JIT noise, still far below the ~100x of O(n²).
    expect(largeMs).toBeLessThan(Math.max(smallMs, 50) * 30);
    // Safety net for an outright hang or blow-up on any machine.
    expect(largeMs).toBeLessThan(25_000);
  }, 30_000);

  it('creates zero timers across a sustained outage, including many increments and distinct keys', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics, 256);

    for (let i = 0; i < 500; i++) {
      await storage.increment(`k-${i}`, 60_000, 300, 60_000, 'default');
    }

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('bounds log volume over a sustained simulated outage — one line on entry, not one per request', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics, 256);

    for (let i = 0; i < 200; i++) {
      await storage.increment(`k-${i}`, 60_000, 300, 60_000, 'default');
    }

    // 200 failing requests inside one summary interval must produce far
    // fewer than 200 log lines — the metric counter (recordSpy-equivalent)
    // still fires per request; only the LOG is rate-limited.
    expect(warnSpy.mock.calls.length).toBeLessThan(5);
    expect(recordSpy).toHaveBeenCalledTimes(200);
    warnSpy.mockRestore();
  });
});
