import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DbPoolMetricsService } from './db-pool-metrics.service';
import { MetricsService } from './metrics.service';

/**
 * P1.3. `pg_stat_activity` cannot see pool exhaustion (MS-002/P0 booking
 * remediation's own finding — the wait happens before a Postgres backend is
 * even acquired), so `pg-pool`'s own counters are the only place this is
 * observable. These tests pin: the gauges are actually set from the real
 * `driver.master` pool shape, the warn only fires on SUSTAINED waiting (not
 * a single blip), it resets when waiting clears, it respects a cooldown
 * once sustained, and a sampling failure never throws or crashes the timer.
 */
describe('DbPoolMetricsService', () => {
  let metrics: { setDbPoolStats: jest.Mock };
  let warn: jest.SpyInstance;

  const fakeConfig = (pollMs = 15000) => ({ get: () => pollMs }) as any;

  const fakeDataSource = (pool: unknown) =>
    ({ driver: { master: pool } }) as unknown as DataSource;

  beforeEach(() => {
    metrics = { setDbPoolStats: jest.fn() };
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function service(pool: unknown, pollMs = 15000) {
    return new DbPoolMetricsService(
      fakeDataSource(pool),
      metrics as unknown as MetricsService,
      fakeConfig(pollMs),
    );
  }

  it('samples pg-pool counters into the three gauges on each interval tick', () => {
    const svc = service({ totalCount: 15, idleCount: 10, waitingCount: 0 });
    svc.onModuleInit();

    jest.advanceTimersByTime(15000);

    expect(metrics.setDbPoolStats).toHaveBeenCalledWith({
      total: 15,
      idle: 10,
      waiting: 0,
    });
    svc.onModuleDestroy();
  });

  it('does NOT warn on a single sample with waiting > 0 (a blip, not sustained)', () => {
    const svc = service({ totalCount: 10, idleCount: 0, waitingCount: 3 });
    svc.onModuleInit();

    jest.advanceTimersByTime(15000); // 1 sample

    expect(warn).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('warns once waiting > 0 persists across 3 consecutive samples', () => {
    const svc = service({ totalCount: 10, idleCount: 0, waitingCount: 5 });
    svc.onModuleInit();

    jest.advanceTimersByTime(15000 * 3); // 3 samples

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('DB pool saturated');
    expect(warn.mock.calls[0][0]).toContain('5 caller(s) waiting');
    svc.onModuleDestroy();
  });

  it('resets the consecutive count as soon as a sample shows waiting = 0', () => {
    let waitingCount = 5;
    const pool = {
      totalCount: 10,
      idleCount: 0,
      get waitingCount() {
        return waitingCount;
      },
    };
    const svc = service(pool);
    svc.onModuleInit();

    jest.advanceTimersByTime(15000 * 2); // 2 consecutive waiting samples
    waitingCount = 0;
    jest.advanceTimersByTime(15000); // clears it
    waitingCount = 5;
    jest.advanceTimersByTime(15000 * 2); // only 2 more consecutive — still under 3

    expect(warn).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('does not repeat the warning every sample while sustained — respects the cooldown', () => {
    const svc = service({ totalCount: 10, idleCount: 0, waitingCount: 5 });
    svc.onModuleInit();

    jest.advanceTimersByTime(15000 * 10); // well past the 3-sample threshold, well within cooldown

    expect(warn).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('never throws when the pool is missing (e.g. driver not yet initialized)', () => {
    const svc = service(undefined);
    svc.onModuleInit();

    expect(() => jest.advanceTimersByTime(15000)).not.toThrow();
    expect(metrics.setDbPoolStats).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('never throws when reading the pool itself throws', () => {
    const throwingDataSource = {
      get driver() {
        throw new Error('driver not ready');
      },
    } as unknown as DataSource;
    const svc = new DbPoolMetricsService(
      throwingDataSource,
      metrics as unknown as MetricsService,
      fakeConfig(),
    );
    svc.onModuleInit();

    expect(() => jest.advanceTimersByTime(15000)).not.toThrow();
    svc.onModuleDestroy();
  });

  it('reads the configurable poll interval from ConfigService, not a hardcoded value', () => {
    const svc = service({ totalCount: 1, idleCount: 1, waitingCount: 0 }, 5000);
    svc.onModuleInit();

    jest.advanceTimersByTime(5000);
    expect(metrics.setDbPoolStats).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });
});
