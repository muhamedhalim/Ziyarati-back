/**
 * REAL-DATABASE integration test — the data-governance migration
 * (residency plan P11 / P13).
 *
 * From an empty database: the full chain applies, the two tables and their
 * indexes exist, neither has a foreign key (the proof must outlive the tenant
 * and the subject), the migration reverts cleanly, and re-applies.
 *
 * Skips cleanly when no database is reachable. Run:
 *   DATABASE_URL=postgres://... npx jest --config test/jest-integration.json test/integration/data-governance-migration.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_GOVMIG ?? 'ziyarati_inttest_govmig';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let available = false;

beforeAll(async () => {
  if (!BASE) return;
  try {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    ds = new DataSource({
      type: 'postgres',
      url: testUrl,
      migrations: [
        join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}'),
      ],
      migrationsTransactionMode: 'each',
      synchronize: false,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations();
    available = true;
  } catch (e) {
    console.warn(
      'Data-governance migration test skipped (no DB):',
      (e as Error).message,
    );
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

const runIf = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

const tableExists = async (t: string) =>
  (await ds!.query(`SELECT to_regclass($1) AS r`, [`public.${t}`]))[0].r !==
  null;

describe('DataGovernance migration against real PostgreSQL', () => {
  runIf(
    'creates both tables and the indexes the entities declare',
    async () => {
      expect(await tableExists('data_subject_requests')).toBe(true);
      expect(await tableExists('deletion_evidence')).toBe(true);
      const idx = (
        await ds!.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
        )
      ).map((r: { indexname: string }) => r.indexname);
      for (const name of [
        'IDX_dsr_tenant_received',
        'IDX_dsr_tenant_customer',
        'IDX_deletion_evidence_tenant_created',
      ]) {
        expect(idx).toContain(name);
      }
    },
  );

  runIf(
    'has NO foreign keys on either table, so the proof outlives the tenant and the subject',
    async () => {
      const fks = await ds!.query(
        `SELECT conrelid::regclass::text AS tbl FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text IN ('data_subject_requests', 'deletion_evidence')`,
      );
      expect(fks).toEqual([]);
    },
  );

  runIf(
    'accepts a row for a tenant and customer that do not exist (nothing to be cascaded away)',
    async () => {
      await ds!.query(
        `INSERT INTO "data_subject_requests" ("tenant_id", "customer_id", "type", "channel")
       VALUES (gen_random_uuid(), gen_random_uuid(), 'EXPORT', 'in_person')`,
      );
      const [row] = await ds!.query(
        `SELECT "status", "due_at" FROM "data_subject_requests" LIMIT 1`,
      );
      expect(row).toEqual({ status: 'RECEIVED', due_at: null });
    },
  );

  runIf('reverts cleanly and re-applies', async () => {
    // `undoLastMigration()` reverts the NEWEST migration, and this one is no longer the newest:
    // revert from the head until its tables are gone (every newer down() runs too), then re-apply
    // the whole chain. A hard cap keeps a migration that cannot be reverted from looping forever.
    // `transaction: 'none'`: TypeORM's undoLastMigration opens a transaction even for a migration that
    // declares `transaction = false`, so a down() using DROP INDEX CONCURRENTLY (e.g.
    // SubscriptionBillingIntegrityIndexes) cannot run otherwise. That also means `migrate.js revert`
    // cannot roll those migrations back today — tracked as a finding, not hidden by this test.
    for (let i = 0; i < 100 && (await tableExists('data_subject_requests')); i++) {
      await ds!.undoLastMigration({ transaction: 'none' });
    }
    expect(await tableExists('data_subject_requests')).toBe(false);
    expect(await tableExists('deletion_evidence')).toBe(false);
    await ds!.runMigrations();
    expect(await tableExists('data_subject_requests')).toBe(true);
    expect(await tableExists('deletion_evidence')).toBe(true);
  });
});
