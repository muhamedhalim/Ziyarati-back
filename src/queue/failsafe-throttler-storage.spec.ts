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

    const result = await storage.increment('key', 60_000, 300, 60_000, 'default');

    expect(result).toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(primary.increment).toHaveBeenCalledWith('key', 60_000, 300, 60_000, 'default');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('degrades to the in-memory fallback and records a metric when the primary throws', async () => {
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(
        new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      ),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics);

    const result = await storage.increment('key', 60_000, 300, 60_000, 'default');

    expect(result.isBlocked).toBe(false);
    expect(result.totalHits).toBe(1);
    expect(recordSpy).toHaveBeenCalledWith('redis_unavailable');
  });

  it('still enforces a limit locally while Redis stays unavailable (degraded mode, not disabled)', async () => {
    const primary: ThrottlerStorage = {
      increment: jest.fn().mockRejectedValue(new Error('connection refused')),
    };
    const storage = new FailsafeThrottlerStorage(primary, metrics);

    let lastResult: Awaited<ReturnType<FailsafeThrottlerStorage['increment']>> | undefined;
    for (let i = 0; i < 5; i++) {
      lastResult = await storage.increment('same-key', 60_000, 3, 60_000, 'default');
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

    const duringOutage = await storage.increment('key', 60_000, 300, 60_000, 'default');
    const afterRecovery = await storage.increment('key', 60_000, 300, 60_000, 'default');

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
});
