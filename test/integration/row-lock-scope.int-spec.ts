/**
 * CR-47 - a row lock taken through a tenant-filtered `findOne` must lock ONLY the requested row.
 *
 * `findOne({ where: { id, tenant: { id } }, lock: { mode: 'pessimistic_write' } })` LEFT JOINs `tenants`
 * to evaluate the filter, and a bare `FOR UPDATE` then locks the joined tenant row as well. Every payment,
 * refund and billing-upgrade lock in a clinic would then queue on that one `tenants` row (and block any
 * insert that takes a FOR KEY SHARE on it through a foreign key). The fix is `lock.tables`, which renders
 * `FOR UPDATE OF "<alias>"`.
 *
 * Real PostgreSQL, real migrations, two real connections. The negative control keeps the test honest: if
 * TypeORM ever stopped joining (or started scoping the lock itself) the control would fail and say so.
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the DB is unreachable locally,
 * but FAILS under CI so a missing database can never read as a pass (CR-13).
 *
 * Run: npx jest --config test/jest-integration.json test/integration/row-lock-scope.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { Payment } from '../../src/entities/Payments/Payment';
import { lockRequest } from '../../src/modules/billing-upgrades/billing-upgrade-lock.util';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_LOCKS ?? 'ziyarati_inttest_locks';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let probe: Client | null = null;
let available = false;

const tenantId = randomUUID();
const paymentId = randomUUID();
const requestId = randomUUID();

async function boot() {
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.query(`CREATE DATABASE ${TEST_DB}`);
  await a.end();
  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    entities: [
      join(process.cwd(), 'src', 'entities', '**', '!(*.spec).{ts,js}'),
    ],
    migrations: [join(process.cwd(), 'src', 'migrations', '!(*.spec).{ts,js}')],
    synchronize: false,
    // Several migrations set `transaction = false` (CREATE INDEX CONCURRENTLY); see workflow-claim.
    migrationsTransactionMode: 'each' as const,
  });
  await ds.initialize();
  await ds.runMigrations();
  await ds.query(
    `INSERT INTO tenants (id, name, slug, contact_email) VALUES ($1, 'lock-scope', $2, 'lock-scope@example.test')`,
    [tenantId, `lock-scope-${tenantId.slice(0, 8)}`],
  );
  await ds.query(
    `INSERT INTO payments (id, amount, "tenantId") VALUES ($1, 10, $2)`,
    [paymentId, tenantId],
  );
  await ds.query(
    `INSERT INTO billing_upgrade_requests (id, "tenantId", type) VALUES ($1, $2, 'test')`,
    [requestId, tenantId],
  );
  probe = new Client({ connectionString: testUrl });
  await probe.connect();
}

beforeAll(async () => {
  if (!BASE) {
    if (process.env.CI)
      throw new Error(
        'DATABASE_URL is required for the row-lock integration test in CI',
      );
    return;
  }
  try {
    await boot();
    available = true;
  } catch (e) {
    if (process.env.CI) throw e;
    console.warn(
      'Row-lock integration test skipped (no DB):',
      (e as Error).message,
    );
  }
});

afterAll(async () => {
  await probe?.end().catch(() => undefined);
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.end();
});

/** Can a second connection lock this row right now? (NOWAIT: a held lock raises 55P03 instead of waiting.) */
async function canLock(table: string, id: string): Promise<boolean> {
  await probe!.query('BEGIN');
  try {
    await probe!.query(
      `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`,
      [id],
    );
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === '55P03') return false;
    throw e;
  } finally {
    await probe!.query('ROLLBACK');
  }
}

describe('CR-47 - tenant-filtered row locks stay on the requested row', () => {
  it('lockRequest (billing upgrades) locks the request row but not the tenant row', async () => {
    if (!available) return;
    await ds!.transaction(async (manager) => {
      const locked = await lockRequest(manager, {
        id: requestId,
        tenant: { id: tenantId },
      });
      expect(locked?.id).toBe(requestId);
      expect(await canLock('billing_upgrade_requests', requestId)).toBe(false);
      expect(await canLock('tenants', tenantId)).toBe(true);
    });
  });

  it('a payment lock with `tables` locks the payment row but not the tenant row', async () => {
    if (!available) return;
    await ds!.transaction(async (manager) => {
      const payment = await manager.getRepository(Payment).findOne({
        where: { id: paymentId, tenant: { id: tenantId } },
        lock: { mode: 'pessimistic_write', tables: ['payments'] },
      });
      expect(payment?.id).toBe(paymentId);
      expect(await canLock('payments', paymentId)).toBe(false);
      expect(await canLock('tenants', tenantId)).toBe(true);
    });
  });

  it('negative control: without `tables` the same lookup DOES lock the tenant row', async () => {
    if (!available) return;
    await ds!.transaction(async (manager) => {
      await manager.getRepository(Payment).findOne({
        where: { id: paymentId, tenant: { id: tenantId } },
        lock: { mode: 'pessimistic_write' },
      });
      expect(await canLock('tenants', tenantId)).toBe(false);
    });
  });
});
