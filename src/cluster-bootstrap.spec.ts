import { estimateDbConnections } from './cluster-bootstrap';

/**
 * P1.1 (2026-09-04). Pins the capacity formula
 * `API_CLUSTER_WORKERS × API_DB_POOL_MAX × 2 + WORKER_DB_POOL_MAX`, its
 * fallback chain (role-specific var → DB_POOL_MAX → 15, mirroring
 * `typeorm.config.ts`'s own `poolMax`), and the two warning thresholds
 * (80% of a real DB_MAX_CONNECTIONS when supplied, else a fixed > 50 guess).
 */
describe('estimateDbConnections', () => {
  const base = {
    apiPoolMaxEnv: undefined,
    workerPoolMaxEnv: undefined,
    dbPoolMaxEnv: undefined,
    maxConnectionsEnv: undefined,
  };

  it('applies the formula with default pool sizes (15/15) — 1 worker: 1×15×2+15 = 45', () => {
    const result = estimateDbConnections({ ...base, numWorkers: 1 });
    expect(result.estimatedConnections).toBe(45);
  });

  it('scales with worker count — 4 workers, default pools: 4×15×2+15 = 135', () => {
    const result = estimateDbConnections({ ...base, numWorkers: 4 });
    expect(result.estimatedConnections).toBe(135);
  });

  it('role-specific pool vars override DB_POOL_MAX independently for API vs worker', () => {
    const result = estimateDbConnections({
      numWorkers: 2,
      apiPoolMaxEnv: '8',
      workerPoolMaxEnv: '20',
      dbPoolMaxEnv: '15',
      maxConnectionsEnv: undefined,
    });
    // 2 × 8 × 2 + 20 = 52 — proves API_DB_POOL_MAX and WORKER_DB_POOL_MAX
    // are read independently, not both falling back to DB_POOL_MAX.
    expect(result.estimatedConnections).toBe(52);
  });

  it('both pool vars fall back to DB_POOL_MAX when role-specific vars are unset', () => {
    const result = estimateDbConnections({
      numWorkers: 1,
      apiPoolMaxEnv: undefined,
      workerPoolMaxEnv: undefined,
      dbPoolMaxEnv: '10',
      maxConnectionsEnv: undefined,
    });
    // 1 × 10 × 2 + 10 = 30
    expect(result.estimatedConnections).toBe(30);
  });

  it('DB_POOL_MAX itself falls back to 15 when nothing at all is set', () => {
    const result = estimateDbConnections({ ...base, numWorkers: 1 });
    expect(result.summary).toContain('1 × 15 × 2');
    expect(result.summary).toContain('+ 15 (worker)');
  });

  it('warns above 80% of a real DB_MAX_CONNECTIONS when supplied', () => {
    const result = estimateDbConnections({
      numWorkers: 4,
      apiPoolMaxEnv: '15',
      workerPoolMaxEnv: '15',
      dbPoolMaxEnv: undefined,
      maxConnectionsEnv: '100', // estimate = 4*15*2+15 = 135 > 80
    });
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('above 80%');
    expect(result.summary).toContain('DB_MAX_CONNECTIONS=100');
    expect(result.summary).toContain('135%'); // 135/100 rounded
  });

  it('does NOT warn when comfortably under 80% of a real DB_MAX_CONNECTIONS', () => {
    const result = estimateDbConnections({
      numWorkers: 1,
      apiPoolMaxEnv: '5',
      workerPoolMaxEnv: '5',
      dbPoolMaxEnv: undefined,
      maxConnectionsEnv: '1000', // estimate = 1*5*2+5 = 15, well under 800
    });
    expect(result.warning).toBeUndefined();
  });

  it('falls back to the fixed >50 guess when DB_MAX_CONNECTIONS is not supplied', () => {
    const result = estimateDbConnections({ ...base, numWorkers: 4 }); // 135 > 50
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('is high');
    expect(result.summary).toContain('Set DB_MAX_CONNECTIONS');
  });

  it('does not warn under the fixed 50 guess when DB_MAX_CONNECTIONS is unset', () => {
    const result = estimateDbConnections({
      numWorkers: 1,
      apiPoolMaxEnv: '5',
      workerPoolMaxEnv: '5',
      dbPoolMaxEnv: undefined,
      maxConnectionsEnv: undefined,
    }); // 1*5*2+5 = 15, under 50
    expect(result.warning).toBeUndefined();
  });
});
