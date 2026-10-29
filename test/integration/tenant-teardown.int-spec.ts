/**
 * REAL-DATABASE integration test — FK-ordered tenant teardown and idempotent seeding of the audit
 * fixtures.
 *
 * Regression for the deployment-pipeline Postgres errors:
 *   - `update or delete on table "customers" / "branches" / "whatsapp_accounts" / "tenants" violates
 *     foreign key constraint ... on table "conversations"` (a hand-ordered, error-swallowing teardown);
 *   - `duplicate key value violates unique constraint "UQ_whatsapp_contact_tenant_wa_id"`.
 *
 * Proves, against PostgreSQL itself and a database built from the full migration chain:
 *  - the old delete order really does hit foreign-key violations (so the test would fail on the old code);
 *  - `teardownTenants` removes everything a clinic owns, in one transaction, and touches no other clinic;
 *  - running it again (and re-seeding the same fixture run) is a no-op, never an error;
 *  - a failure part-way rolls the whole teardown back — no half-deleted clinic;
 *  - `(tenantId, wa_id)` is unique per tenant, the same number may exist in another tenant, NULL wa_ids
 *    never collide, and an `ON CONFLICT DO NOTHING` seed is repeatable.
 *
 * Run (needs a Postgres server; the throwaway database is created and dropped):
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx jest --config test/jest-integration.json test/integration/tenant-teardown.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { teardownTenants } from '../utils/tenant-teardown';
import { RUN, seedAuditClinics, teardownAuditClinics } from '../ai-audit/fixtures/audit-seed';
import { INFRA_REQUIRED, infraUnavailable } from '../utils/require-infra';
import { PgFactory, type World } from './support/pg-factory';

const TEST_DB = process.env.INTEGRATION_TEST_DB_TEARDOWN ?? 'ziyarati_inttest_teardown';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource;
let available = false;
let factory: PgFactory;

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await ds.query(sql, params))[0].n);
const rowsOf = (table: string, col: string, tenantId: string) =>
  count(`SELECT count(*)::int AS n FROM "${table}" WHERE "${col}" = $1`, [tenantId]);

beforeAll(async () => {
  if (!BASE) {
    infraUnavailable('Postgres (DATABASE_URL)');
    return;
  }
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    entities: [join(process.cwd(), 'src', 'entities', '**', '!(*.spec).ts')],
    migrations: [join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}')],
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  await ds.runMigrations();
  factory = new PgFactory(ds);
  await factory.load();
  available = true;
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
      if (!available) {
        if (INFRA_REQUIRED) throw new Error('database not available');
        return;
      }
      await fn();
    },
    timeout,
  );

interface Clinic {
  w: World;
  tenantId: string;
  customerId: string;
  branchId: string;
  accountId: string;
  conversationId: string;
  contactId: string;
}

/** A clinic with exactly the ownership chain the audit teardown used to break on. */
async function seedClinic(label: string): Promise<Clinic> {
  const w = factory.world({ connected: true });
  const tenantId = await w.make('tenants', { name: `Teardown ${label}`, slug: `td-${label}-${RUN}` });
  const branchId = await w.make('branches', {});
  const customerId = await w.make('customers', {});
  const accountId = await w.make('whatsapp_accounts', { branch_id: branchId });
  const conversationId = await w.make('conversations', {});
  const contactId = await w.make('whatsapp_contacts', { wa_id: `9665${label}${RUN}`.slice(0, 20) });
  return { w, tenantId, customerId, branchId, accountId, conversationId, contactId };
}

const tenantRows = async (c: Clinic) => ({
  tenants: await count(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [c.tenantId]),
  customers: await rowsOf('customers', 'tenantId', c.tenantId),
  branches: await rowsOf('branches', 'tenantId', c.tenantId),
  whatsapp_accounts: await rowsOf('whatsapp_accounts', 'tenantId', c.tenantId),
  conversations: await rowsOf('conversations', 'tenantId', c.tenantId),
  whatsapp_contacts: await rowsOf('whatsapp_contacts', 'tenantId', c.tenantId),
});

describe('tenant teardown (real Postgres)', () => {
  runIf('the old delete order is really blocked by foreign keys (what the pipeline logged)', async () => {
    const c = await seedClinic('old');
    // customers <- conversations, branches <- whatsapp_accounts, whatsapp_accounts <- conversations,
    // tenants <- everything: each is a 23503, not something a retry loop quietly absorbs.
    await expect(ds.query(`DELETE FROM customers WHERE "tenantId" = $1`, [c.tenantId])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(ds.query(`DELETE FROM branches WHERE "tenantId" = $1`, [c.tenantId])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(ds.query(`DELETE FROM whatsapp_accounts WHERE "tenantId" = $1`, [c.tenantId])).rejects.toMatchObject({
      code: '23503',
    });
    await expect(ds.query(`DELETE FROM tenants WHERE id = $1`, [c.tenantId])).rejects.toMatchObject({ code: '23503' });

    await teardownTenants(ds, [c.tenantId]);
  });

  runIf('removes every row the clinic owns, in FK order, and leaves other clinics untouched', async () => {
    const a = await seedClinic('a');
    const b = await seedClinic('b');
    const bBefore = await tenantRows(b);
    expect(bBefore.conversations).toBeGreaterThan(0);
    expect(bBefore.whatsapp_contacts).toBeGreaterThan(0);

    const { deleted } = await teardownTenants(ds, [a.tenantId]);

    expect(await tenantRows(a)).toEqual({
      tenants: 0,
      customers: 0,
      branches: 0,
      whatsapp_accounts: 0,
      conversations: 0,
      whatsapp_contacts: 0,
    });
    expect(deleted.tenants).toBe(1);
    expect(deleted.conversations).toBeGreaterThan(0);
    expect(await tenantRows(b)).toEqual(bBefore); // tenant isolation: B is exactly as it was

    await teardownTenants(ds, [b.tenantId]);
  });

  runIf('is idempotent: tearing down an already-removed clinic deletes nothing and does not throw', async () => {
    const c = await seedClinic('idem');
    await teardownTenants(ds, [c.tenantId]);
    await expect(teardownTenants(ds, [c.tenantId])).resolves.toEqual({ deleted: {} });
    await expect(teardownTenants(ds, [])).resolves.toEqual({ deleted: {} });
  });

  runIf('removes a guest (other-tenant) AI conversation linked to a clinic conversation first', async () => {
    const clinic = await seedClinic('guest');
    const discovery = factory.world({ connected: true });
    const discoveryId = await discovery.make('tenants', { name: 'Discovery', slug: `td-disc-${RUN}` });
    const guestConv = await discovery.make('ai_conversations', { conversationId: clinic.conversationId });
    await ds.query(`UPDATE ai_conversations SET "conversationId" = $2 WHERE id = $1`, [guestConv, clinic.conversationId]);

    // Without the cross-tenant pre-step this is `tenants`/`conversations` blocked by ai_conversations.
    await teardownTenants(ds, [clinic.tenantId]);

    expect(await count(`SELECT count(*)::int AS n FROM ai_conversations WHERE id = $1`, [guestConv])).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [discoveryId])).toBe(1);
    await teardownTenants(ds, [discoveryId]);
  });

  runIf('rolls the WHOLE teardown back when a step fails (never a half-deleted clinic)', async () => {
    const c = await seedClinic('rb');
    const before = await tenantRows(c);
    await ds.query(`
      CREATE OR REPLACE FUNCTION td_block_tenant_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'td_block_tenant_delete'; END $$ LANGUAGE plpgsql`);
    await ds.query(`CREATE TRIGGER td_block BEFORE DELETE ON tenants FOR EACH ROW EXECUTE FUNCTION td_block_tenant_delete()`);
    try {
      await expect(teardownTenants(ds, [c.tenantId])).rejects.toThrow(/td_block_tenant_delete/);
      expect(await tenantRows(c)).toEqual(before); // children are back: the transaction rolled them up
    } finally {
      await ds.query(`DROP TRIGGER IF EXISTS td_block ON tenants`);
      await ds.query(`DROP FUNCTION IF EXISTS td_block_tenant_delete()`);
    }
    await teardownTenants(ds, [c.tenantId]);
  });

  runIf('seeding the audit clinics twice in one run, and tearing them down twice, never errors', async () => {
    const slugs = [`audit-full-${RUN}`, `audit-empty-${RUN}`, `audit-b-${RUN}`];
    const live = () => count(`SELECT count(*)::int AS n FROM tenants WHERE slug = ANY($1)`, [slugs]);

    const first = await seedAuditClinics(ds);
    // A conversation on the clinic's own WhatsApp account + patient: the chain the pipeline broke on.
    const w = factory.world({ connected: true });
    w.pin('tenants', first.full.tenantId);
    w.pin('branches', first.full.branchId);
    w.pin('customers', first.full.patientIds.x);
    w.pin('whatsapp_accounts', first.full.accountIds!.default);
    await w.make('conversations', {});
    await w.make('whatsapp_contacts', { wa_id: first.full.patientPhones!.x });
    expect(await live()).toBe(3);

    // Same RUN, no teardown in between: used to trip tenants.slug / phone_number_id uniqueness.
    const second = await seedAuditClinics(ds);
    expect(await live()).toBe(3);
    expect(second.full.tenantId).not.toBe(first.full.tenantId);
    expect(await count(`SELECT count(*)::int AS n FROM tenants WHERE id = $1`, [first.full.tenantId])).toBe(0);

    await teardownAuditClinics(ds, second);
    expect(await live()).toBe(0);
    await expect(teardownAuditClinics(ds, second)).resolves.toBeUndefined();
    expect(await live()).toBe(0);
  });

  runIf('whatsapp_contacts: (tenantId, wa_id) is unique per tenant; other tenants, NULL wa_ids and ON CONFLICT seeds are fine', async () => {
    const a = await seedClinic('ca');
    const b = await seedClinic('cb');
    const waId = `966599${RUN}`;
    const insert = (tenantId: string, wa: string | null) =>
      ds.query(`INSERT INTO whatsapp_contacts ("tenantId", wa_id) VALUES ($1, $2)`, [tenantId, wa]);

    await insert(a.tenantId, waId);
    await expect(insert(a.tenantId, waId)).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_whatsapp_contact_tenant_wa_id',
    });
    await insert(b.tenantId, waId); // the same number in ANOTHER tenant is a different contact
    await insert(a.tenantId, null);
    await insert(a.tenantId, null); // the index is partial: NULL wa_ids never collide

    // The idempotent seed pattern: repeatable, no error, no second row.
    const seed = () =>
      ds.query(
        `INSERT INTO whatsapp_contacts ("tenantId", wa_id) VALUES ($1, $2)
         ON CONFLICT ("tenantId", wa_id) WHERE wa_id IS NOT NULL DO NOTHING RETURNING id`,
        [a.tenantId, waId],
      );
    await expect(seed()).resolves.toHaveLength(0);
    await expect(seed()).resolves.toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM whatsapp_contacts WHERE "tenantId" = $1 AND wa_id = $2`, [a.tenantId, waId])).toBe(1);

    await teardownTenants(ds, [a.tenantId, b.tenantId]);
  });
});
