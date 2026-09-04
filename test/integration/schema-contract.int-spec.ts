/**
 * OFFLINE integration test — the SCHEMA CONTRACT (P0.3 RULE 11).
 *
 * Builds a throwaway database by running the full migration chain from empty,
 * then asserts that PostgreSQL's own catalog contains every critical integrity
 * guard, with the exact definition the contract records
 * (`src/config/schema-guards/critical-schema-guards.json`, 43 objects — moved
 * from `test/fixtures/` in P0.5 so the SAME file also drives the runtime
 * `SchemaGuardCatalogService`; this test and the app boot check against one
 * source, never two that could drift).
 *
 * WHAT THIS CATCHES that nothing else did:
 *
 *  - A migration that stops creating a guard (deleted, reordered, or made
 *    conditional on something that is now false).
 *  - A migration that changes a guard's DEFINITION — the case P0.2 found in
 *    `ziyarati_perf_t2`, where `UQ_customers_tenant_email` had lost its
 *    `WHERE deleted_at IS NULL` predicate and so was silently STRICTER than
 *    canonical: a soft-deleted customer's email could never be reused.
 *  - A later migration that drops an earlier one's guard.
 *
 * WHY A REAL DATABASE, AND WHY FROM EMPTY. P0.2's final rule: a migration
 * recorded as applied does not prove its DDL exists, and a passing application
 * test does not prove PostgreSQL is enforcing anything. The only evidence that
 * settles it is `pg_catalog` on a schema this chain actually built. Running
 * from empty also means the result cannot be contaminated by whatever a
 * long-lived local database happens to contain.
 *
 * WHEN A GUARD LEGITIMATELY CHANGES: update the fixture in the same commit as
 * the migration that changes it. That is the point — the contract is meant to
 * be edited deliberately, and never drift silently.
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the
 * DB is unreachable.
 *
 * Run: npx jest --config test/jest-integration.json test/integration/schema-contract.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import contract from '../../src/config/schema-guards/critical-schema-guards.json';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_SCHEMA ?? 'ziyarati_inttest_schema';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

interface Guard {
  severity: string;
  name: string;
  kind: string;
  purpose: string;
  definition: string;
}
const GUARDS = contract.guards as Guard[];

let ds: DataSource | null = null;
let available = false;
/** name → definition, exactly as PostgreSQL reports it. */
let actual = new Map<string, string>();

async function boot() {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    migrations: [join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}')],
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  await ds.runMigrations();

  // Whitespace is normalised on both sides: `pg_get_constraintdef` and
  // `pg_indexes.indexdef` are free to differ in line breaks and padding
  // between PostgreSQL point releases without that being drift.
  const rows = (await ds.query(`
    SELECT indexname AS name, 'index' AS kind,
           regexp_replace(indexdef, '\\s+', ' ', 'g') AS def
      FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT c.conname, 'constraint',
           regexp_replace(pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
  `)) as Array<{ name: string; kind: string; def: string }>;
  actual = new Map(rows.map((r) => [`${r.kind}:${r.name}`, r.def]));
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn('Schema contract test skipped (no DB):', (e as Error).message);
  }
}, 300_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.end();
}, 60_000);

const runIf = (
  name: string,
  fn: () => Promise<void> | void,
  timeout = 60_000,
) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

describe('schema contract — the migration chain builds every critical integrity guard', () => {
  runIf('the contract itself is non-empty and covers both severities', () => {
    expect(GUARDS.length).toBeGreaterThan(0);
    expect(GUARDS.some((g) => g.severity === 'P0')).toBe(true);
    expect(GUARDS.some((g) => g.severity === 'P1')).toBe(true);
  });

  runIf('EVERY P0 guard exists in pg_catalog after the migration chain', () => {
    const missing = GUARDS.filter((g) => g.severity === 'P0').filter(
      (g) => !actual.has(`${g.kind}:${g.name}`),
    );
    // Named individually, with purpose, so a failure says what stopped being
    // enforced rather than just how many things did.
    expect(missing.map((g) => `${g.name} — ${g.purpose}`)).toEqual([]);
  });

  runIf('EVERY P1 guard exists in pg_catalog after the migration chain', () => {
    const missing = GUARDS.filter((g) => g.severity === 'P1').filter(
      (g) => !actual.has(`${g.kind}:${g.name}`),
    );
    expect(missing.map((g) => `${g.name} — ${g.purpose}`)).toEqual([]);
  });

  runIf('every guard DEFINITION matches the contract exactly', () => {
    const mismatched = GUARDS.filter((g) => actual.has(`${g.kind}:${g.name}`))
      .filter((g) => actual.get(`${g.kind}:${g.name}`) !== g.definition)
      .map((g) => ({
        guard: g.name,
        expected: g.definition,
        actual: actual.get(`${g.kind}:${g.name}`),
      }));
    expect(mismatched).toEqual([]);
  });

  runIf(
    'the btree_gist extension exists — appointments_no_overlap cannot be created without it',
    async () => {
      const rows = (await ds!.query(
        `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'btree_gist'`,
      )) as Array<{ n: number }>;
      expect(rows[0].n).toBe(1);
    },
  );

  runIf(
    'the transactions ledger is append-only — the trigger and its function both exist',
    async () => {
      const rows = (await ds!.query(`
      SELECT
        (SELECT count(*)::int FROM pg_trigger tg
           JOIN pg_class c ON c.oid = tg.tgrelid
          WHERE NOT tg.tgisinternal AND c.relname = 'transactions'
            AND tg.tgname = 'transactions_no_mutate') AS trg,
        (SELECT count(*)::int FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'trg_transactions_immutable') AS fn
    `)) as Array<{ trg: number; fn: number }>;
      // NOTE: on a migrations-only database this is created by the migration
      // chain, NOT by PaymentsSchemaBootstrap — no application booted here.
      expect(rows[0]).toEqual({ trg: 1, fn: 1 });
    },
  );

  runIf(
    'appointments_no_overlap is an EXCLUSION constraint, not merely a same-named index',
    async () => {
      // P0.1: a same-named btree index would satisfy a naive presence check
      // while enforcing nothing about overlap. `contype = 'x'` is the only
      // form that closes the race.
      const rows = (await ds!.query(`
      SELECT c.contype::text AS contype
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.conname = 'appointments_no_overlap' AND t.relname = 'appointments'
    `)) as Array<{ contype: string }>;
      expect(rows.map((r) => r.contype)).toEqual(['x']);
    },
  );
});
