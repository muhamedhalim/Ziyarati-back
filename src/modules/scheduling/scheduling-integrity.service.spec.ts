import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SchedulingIntegrityService } from './scheduling-integrity.service';
import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * P0.5 / P04-001. This service has checked `appointments_no_overlap` — the
 * only race-safe double-booking guard — since P0.1, but never reported the
 * result anywhere `GET /system/health/readiness` could see. These tests pin
 * that the check now feeds `SchemaGuardRegistry`, so the single most
 * important row of the P0.4 blind-spot finding is closed, without changing
 * any of the existing log-only, never-fatal behaviour.
 */
describe('SchedulingIntegrityService', () => {
  let registry: SchemaGuardRegistry;
  let dataSource: { query: jest.Mock };

  beforeEach(() => {
    registry = new SchemaGuardRegistry();
    dataSource = { query: jest.fn() };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function service() {
    return new SchedulingIntegrityService(
      dataSource as unknown as DataSource,
      registry,
    );
  }

  it('constraint present → registers as a required, ok guard', async () => {
    dataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);

    await service().onApplicationBootstrap();

    const summary = registry.summary();
    expect(summary.requiredChecked).toBe(1);
    expect(summary.requiredFailed).toBe(0);
    expect(summary.status).toBe('ok');
  });

  it('constraint MISSING → registers as a required, failed guard (degrades readiness)', async () => {
    dataSource.query.mockResolvedValueOnce([]); // no row — constraint absent

    await service().onApplicationBootstrap();

    const summary = registry.summary();
    expect(summary.requiredFailed).toBe(1);
    expect(summary.status).toBe('degraded');
  });

  it('the failure detail carried into the registry never appears in the public summary', async () => {
    dataSource.query.mockResolvedValueOnce([]);

    await service().onApplicationBootstrap();

    expect(JSON.stringify(registry.summary())).not.toMatch(
      /appointments_no_overlap|EXCLUSION|migration:run/i,
    );
  });

  it('the check itself failing (catalog unreachable) never registers anything — never a diagnostic that blocks boot', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service().onApplicationBootstrap()).resolves.toBeUndefined();
    expect(registry.summary().requiredChecked).toBe(0);
  });

  it('never throws, regardless of outcome (log-only by design)', async () => {
    dataSource.query.mockResolvedValueOnce([]);
    await expect(service().onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
