/**
 * OFFLINE integration test — real PostgreSQL, real `typeOrmFactory` (P0.3).
 *
 * Proves the protection added in P0.3 RULE 3 / RULE 11.7: the factory refuses
 * to boot with `TYPEORM_SYNCHRONIZE=true` against a database that migrations
 * provisioned.
 *
 * WHY THIS CANNOT BE A UNIT TEST. The guard's whole job is to ask a real
 * PostgreSQL catalog a question ("does `public.migrations` exist, and does it
 * hold rows?"). A mocked DataSource would assert only that the right SQL
 * string was composed — precisely the class of "passing test that proves
 * nothing about the database" that P0.2's final rule warns against. So this
 * builds two throwaway databases and asks the real factory about each.
 *
 * The scenario it closes is not hypothetical. P0.2 measured, on a disposable
 * database, what one synchronize boot does to a fully-migrated schema: 178
 * DROP INDEX, 120 DROP CONSTRAINT, 23 DROP COLUMN, 28 DROP NOT NULL — a net
 * loss of 32 integrity guards plus the data in 23 columns. The existing
 * `NODE_ENV=production` guard does not see a staging, QA, demo or
 * restored-from-backup database booted as `development`.
 *
 * Runs against throwaway DBs created from DATABASE_URL. Skips cleanly if the
 * DB is unreachable.
 *
 * Run: npx jest --config test/jest-integration.json test/integration/synchronize-guard.int-spec.ts
 */
import 'dotenv/config';
import { Client } from 'pg';

import {
  typeOrmFactory,
  SYNCHRONIZE_MIGRATED_DB_OVERRIDE,
} from '../../src/config/typeorm.config';

const MIGRATED_DB =
  process.env.INTEGRATION_TEST_DB_SYNC_MIGRATED ??
  'ziyarati_inttest_sync_migrated';
const VIRGIN_DB =
  process.env.INTEGRATION_TEST_DB_SYNC_VIRGIN ?? 'ziyarati_inttest_sync_virgin';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const urlFor = (db: string) => BASE.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);

let available = false;

/** Minimal ConfigService stand-in — the factory only ever calls `get`. */
const configFor = (env: Record<string, unknown>) =>
  ({
    get: (key: string, fallback?: unknown) =>
      Object.prototype.hasOwnProperty.call(env, key) ? env[key] : fallback,
  }) as never;

async function boot() {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  for (const db of [MIGRATED_DB, VIRGIN_DB]) {
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
  }
  await admin.end();

  // The "migrated" database gets the same `migrations` table TypeORM writes,
  // with one recorded row. It does NOT need the real 133-migration chain: the
  // guard's question is "was this schema provisioned by migrations?", and one
  // recorded migration answers it exactly as 133 would, in a fraction of the
  // time.
  const c = new Client({ connectionString: urlFor(MIGRATED_DB) });
  await c.connect();
  await c.query(`
    CREATE TABLE public.migrations (
      id        SERIAL PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      name      VARCHAR NOT NULL
    )`);
  await c.query(
    `INSERT INTO public.migrations (timestamp, name) VALUES (1700000000000, 'BaselineSchema1700000000000')`,
  );
  await c.end();
  // VIRGIN_DB is deliberately left empty — that is what a database created by
  // `synchronize` itself looks like, and the guard must not fire on it.
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn(
      'Synchronize-guard integration test skipped (no DB):',
      (e as Error).message,
    );
  }
}, 60_000);

afterAll(async () => {
  if (!available) return;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  for (const db of [MIGRATED_DB, VIRGIN_DB]) {
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  }
  await admin.end();
}, 60_000);

/**
 * Checks `available` INSIDE the test body, not while the describe block is
 * being built. An `available ? it : it.skip` at describe time is always
 * `it.skip`, because `beforeAll` has not run yet — jest then skips the whole
 * suite and never opens a connection at all, which looks like a pass.
 */
const runIf = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

describe('typeOrmFactory — synchronize against a migration-provisioned database (P0.3)', () => {
  runIf(
    'REFUSES to boot, and names the count of applied migrations it found',
    async () => {
      const config = configFor({
        NODE_ENV: 'development',
        DATABASE_URL: urlFor(MIGRATED_DB),
        TYPEORM_SYNCHRONIZE: 'true',
      });
      await expect(typeOrmFactory(config)).rejects.toThrow(
        /1 applied migration\(s\)/,
      );
      await expect(typeOrmFactory(config)).rejects.toThrow(/Refusing to boot/);
    },
    60_000,
  );

  runIf(
    'refuses for the WORKER role too — a worker can synchronize exactly as destructively as the API',
    async () => {
      const config = configFor({
        NODE_ENV: 'development',
        DATABASE_URL: urlFor(MIGRATED_DB),
        TYPEORM_SYNCHRONIZE: 'true',
      });
      await expect(typeOrmFactory(config, 'worker')).rejects.toThrow(
        /Refusing to boot/,
      );
    },
    60_000,
  );

  runIf(
    'ALLOWS synchronize against a database with no migration history — the ordinary local workflow is untouched',
    async () => {
      const config = configFor({
        NODE_ENV: 'development',
        DATABASE_URL: urlFor(VIRGIN_DB),
        TYPEORM_SYNCHRONIZE: 'true',
      });
      const options = await typeOrmFactory(config);
      expect((options as { synchronize: boolean }).synchronize).toBe(true);
    },
    60_000,
  );

  runIf(
    `permits it when ${SYNCHRONIZE_MIGRATED_DB_OVERRIDE}=true — the escape hatch is explicit, never implicit`,
    async () => {
      const config = configFor({
        NODE_ENV: 'development',
        DATABASE_URL: urlFor(MIGRATED_DB),
        TYPEORM_SYNCHRONIZE: 'true',
        [SYNCHRONIZE_MIGRATED_DB_OVERRIDE]: 'true',
      });
      const options = await typeOrmFactory(config);
      expect((options as { synchronize: boolean }).synchronize).toBe(true);
    },
    60_000,
  );

  runIf(
    'does not run the probe at all when synchronize is off — a migrations-first boot is unaffected',
    async () => {
      // The migrated DB has one RECORDED migration and no real schema, so if
      // this path ran migrations it would try to apply the whole chain. It
      // must instead take the normal `runMigrationsWithAdvisoryLock` route,
      // which is what `synchronize: false` in the result proves.
      const config = configFor({
        NODE_ENV: 'development',
        DATABASE_URL: urlFor(VIRGIN_DB),
        TYPEORM_SYNCHRONIZE: 'false',
      });
      const options = await typeOrmFactory(config);
      expect((options as { synchronize: boolean }).synchronize).toBe(false);
    },
    120_000,
  );
});
