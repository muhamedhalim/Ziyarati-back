/**
 * CR-11 - two migrators can never run at once. Real PostgreSQL advisory lock, two independent
 * DataSources (two sessions), overlapping critical sections.
 *
 * Skips cleanly if the DB is unreachable locally; FAILS under CI so a missing database cannot read
 * as a pass.
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';

import { withMigrationAdvisoryLock } from '../../src/config/run-migrations-with-lock';

const BASE = process.env.DATABASE_URL ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('standalone migrator advisory lock (CR-11)', () => {
  let a: DataSource | null = null;
  let b: DataSource | null = null;
  let available = false;

  beforeAll(async () => {
    if (!BASE) {
      if (process.env.CI) throw new Error('DATABASE_URL is required for the migration-lock test in CI');
      return;
    }
    try {
      a = new DataSource({ type: 'postgres', url: BASE });
      b = new DataSource({ type: 'postgres', url: BASE });
      await Promise.all([a.initialize(), b.initialize()]);
      available = true;
    } catch (e) {
      if (process.env.CI) throw e;
      console.warn('migration-lock integration test skipped (no DB):', (e as Error).message);
    }
  }, 30_000);

  afterAll(async () => {
    await Promise.all([a, b].map((d) => (d?.isInitialized ? d.destroy() : undefined)));
  });

  it('serialises overlapping critical sections across sessions', async () => {
    if (!available) return;
    let active = 0;
    let maxActive = 0;
    const section = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(400);
      active--;
    };

    await Promise.all([
      withMigrationAdvisoryLock(a as DataSource, section),
      withMigrationAdvisoryLock(b as DataSource, section),
    ]);

    expect(maxActive).toBe(1);
  }, 30_000);

  it('releases the lock when the work throws, so the next migrator is not blocked forever', async () => {
    if (!available) return;
    await expect(
      withMigrationAdvisoryLock(a as DataSource, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const started = Date.now();
    await withMigrationAdvisoryLock(b as DataSource, async () => undefined);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);
});
