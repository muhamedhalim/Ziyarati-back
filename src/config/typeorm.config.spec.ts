import { typeOrmFactory } from './typeorm.config';
import { createMockConfigService } from '../../test/utils/mock-factories';

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
});
