import { typeOrmFactory, MetricsAwareTypeOrmLogger } from './typeorm.config';
import { createMockConfigService } from '../../test/utils/mock-factories';
import { MetricsService } from '../metrics/metrics.service';
import { TenantContextService } from '../core/tenant-context/tenant-context.service';

jest.mock('./run-migrations-with-lock', () => ({
  runMigrationsWithAdvisoryLock: jest.fn().mockResolvedValue(undefined),
}));

describe('typeOrmFactory', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    NODE_ENV: 'development',
  };

  // FND-047: node-postgres's own default `connectionTimeoutMillis` is 0 (wait
  // forever). Without an explicit bound here, ANY pool-oversubscription path —
  // this one or a future one — hangs indefinitely instead of failing clearly.
  // This is defense-in-depth alongside the real fix (UsageService's manager
  // threading) — see access-control/billing-mode/free-access-override specs.
  it('sets a finite, positive connectionTimeoutMillis by default', async () => {
    const config = createMockConfigService(baseEnv);
    const options = await typeOrmFactory(config as any);
    const extra = (options as { extra: Record<string, unknown> }).extra;
    expect(extra.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(Number.isFinite(extra.connectionTimeoutMillis)).toBe(true);
  });

  it('honors DB_POOL_CONNECTION_TIMEOUT when set', async () => {
    const config = createMockConfigService({ ...baseEnv, DB_POOL_CONNECTION_TIMEOUT: 5000 });
    const options = await typeOrmFactory(config as any);
    const extra = (options as { extra: Record<string, unknown> }).extra;
    expect(extra.connectionTimeoutMillis).toBe(5000);
  });

  it('never increases the pool max as part of this timeout addition (FND-047 — not the primary fix)', async () => {
    const config = createMockConfigService(baseEnv);
    const options = await typeOrmFactory(config as any);
    const extra = (options as { extra: Record<string, unknown> }).extra;
    expect(extra.max).toBe(15); // unchanged existing default
  });

  // ── 015-db-api-efficiency-audit — P10/T062/T063 (spec §21.2 gap) ──────────

  it('wires a MetricsAwareTypeOrmLogger (not the plain `logging` array) when a MetricsService is supplied', async () => {
    const config = createMockConfigService(baseEnv);
    const metrics = new MetricsService();
    const options = await typeOrmFactory(config as any, 'api', metrics);
    expect((options as { logger?: unknown }).logger).toBeInstanceOf(
      MetricsAwareTypeOrmLogger,
    );
    // TypeORM ignores `logging` once a custom `logger` object is supplied
    // (LoggerFactory.create) — asserting it is unset here documents that,
    // rather than leaving a dead option that looks load-bearing.
    expect((options as { logging?: unknown }).logging).toBeUndefined();
  });

  it('falls back to the plain `logging` array (no counter) when no MetricsService is supplied — existing callers unaffected', async () => {
    const config = createMockConfigService(baseEnv);
    const options = await typeOrmFactory(config as any);
    expect((options as { logger?: unknown }).logger).toBeUndefined();
    expect((options as { logging?: unknown }).logging).toEqual(['error']);
  });
});

describe('MetricsAwareTypeOrmLogger (T062/T063)', () => {
  function build() {
    const metrics = new MetricsService();
    const tenantContext = new TenantContextService();
    const logger = new MetricsAwareTypeOrmLogger(metrics, ['query', 'error', 'warn']);
    return { metrics, tenantContext, logger };
  }

  it('increments db_queries_total once per logQuery call', async () => {
    const { metrics, tenantContext, logger } = build();
    await tenantContext.run(async () => {
      tenantContext.setRoute('/appointments/:id');
      logger.logQuery('SELECT 1', []);
      logger.logQuery('SELECT 2', []);
    });
    const body = await metrics.render();
    const lines = body
      .split('\n')
      .filter((l) => l.startsWith('db_queries_total{'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('route="/appointments/:id"');
    expect(lines[0].trim().endsWith(' 2')).toBe(true);
  });

  it('labels queries fired outside any request context as route="unknown", never crashing', async () => {
    const { metrics, logger } = build();
    logger.logQuery('SELECT 1', []);
    const body = await metrics.render();
    expect(body).toContain('route="unknown"');
  });

  it('gives two different routes two different series', async () => {
    const { metrics, tenantContext, logger } = build();
    await tenantContext.run(async () => {
      tenantContext.setRoute('/appointments/:id');
      logger.logQuery('SELECT 1', []);
    });
    await tenantContext.run(async () => {
      tenantContext.setRoute('/crm/customers');
      logger.logQuery('SELECT 2', []);
    });
    const body = await metrics.render();
    expect(body).toContain('route="/appointments/:id"');
    expect(body).toContain('route="/crm/customers"');
  });

  it('NEVER passes query text or parameters to MetricsService — counter only', async () => {
    const metrics = new MetricsService();
    const recordSpy = jest.spyOn(metrics, 'recordDbQuery');
    const tenantContext = new TenantContextService();
    const logger = new MetricsAwareTypeOrmLogger(metrics, ['query', 'error', 'warn']);
    await tenantContext.run(async () => {
      tenantContext.setRoute('/crm/customers');
      logger.logQuery(
        `SELECT * FROM customers WHERE email = $1`,
        ['secret-patient@example.com'],
      );
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    // The ONLY argument ever passed is the route string — never the query,
    // never the parameters array, never anything derived from them.
    expect(recordSpy).toHaveBeenCalledWith('/crm/customers');
  });

  it('never puts a tenant id in the label — recordDbQuery only ever accepts a route string', () => {
    // Structural guard, not a runtime one: `MetricsService.recordDbQuery`'s
    // signature is `(route: string) => void` — there is no parameter shape
    // through which a tenant id could reach a label even by mistake.
    const metrics = new MetricsService();
    expect(metrics.recordDbQuery.length).toBe(1);
  });

  it('still writes query text to the console delegate when logging is enabled (behavior preserved)', () => {
    const metrics = new MetricsService();
    const logger = new MetricsAwareTypeOrmLogger(metrics, ['query', 'error', 'warn']);
    const delegate = (logger as unknown as { delegate: { logQuery: jest.Mock } }).delegate;
    const spy = jest.spyOn(delegate, 'logQuery');
    logger.logQuery('SELECT 1', []);
    expect(spy).toHaveBeenCalledWith('SELECT 1', [], undefined);
  });
});
