/**
 * REAL-DATABASE integration test — the integrity guards that production money and scheduling depend on,
 * exercised under genuine concurrency (separate pooled connections, one autocommit statement each) and
 * asserted on the FINAL ROW STATE, not on an HTTP status.
 *
 * Why this exists: the Postgres server log of a fully GREEN e2e run contains every one of these
 * violations — `uq_payments_appointment_pending`, `UQ_queue_entries_appointment_live`,
 * `appointments_no_overlap`, `uq_txn_webhook_event`, the gateway-id unique index, foreign-key refusals.
 * They are the guards doing their job against the race LOSER, but a CI failure's service-container log
 * prints them next to the real error, so they read as the failure. This spec pins what each one must do,
 * so a guard that is dropped or weakened fails here — by name — instead of passing silently.
 *
 * Also proves, on a database built from the full migration chain:
 *   - seeding is repeatable (3 runs leave identical row counts and never throw a duplicate-key error)
 *   - a failed transaction leaves nothing behind
 *   - a referenced parent cannot be deleted (audit history outlives its actor) and deleting children
 *     first succeeds
 *
 * Throwaway database created from DATABASE_URL; dropped afterwards. Under CI / REQUIRE_TESTCONTAINERS a
 * missing database is a failure, not a skip (test/utils/require-infra.ts).
 *
 * Run: DATABASE_URL=postgres://... npx jest --config test/jest-integration.json test/integration/db-integrity-guards.int-spec.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { runSeeders } from '../../src/seed/index.seed';
import { infraUnavailable } from '../utils/require-infra';
import { PgFactory, type World } from './support/pg-factory';

const TEST_DB = process.env.INTEGRATION_TEST_DB_INTEGRITY ?? 'ziyarati_inttest_integrity';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource;
let factory: PgFactory;
let available = false;

beforeAll(async () => {
  if (!BASE) {
    infraUnavailable('A Postgres (DATABASE_URL)');
    return;
  }
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
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
    extra: { max: 12 }, // enough pooled connections for a genuinely concurrent burst
  });
  await ds.initialize();
  await ds.runMigrations();
  factory = new PgFactory(ds);
  await factory.load();
  available = true;
}, 300_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!BASE) return;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => undefined);
  await admin.end().catch(() => undefined);
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

interface Outcome {
  ok: boolean;
  code?: string;
  constraint?: string;
}

/** Runs the statement and reports success or the Postgres error code / constraint — never throws. */
async function attempt(sql: string, params: unknown[] = []): Promise<Outcome> {
  try {
    await ds.query(sql, params);
    return { ok: true };
  } catch (e) {
    const err = e as { driverError?: { code?: string; constraint?: string }; code?: string; constraint?: string };
    return {
      ok: false,
      code: err.driverError?.code ?? err.code,
      constraint: err.driverError?.constraint ?? err.constraint,
    };
  }
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await ds.query(sql, params))[0].n);

const winners = (outcomes: Outcome[]) => outcomes.filter((o) => o.ok).length;

/** A tenant with a branch, staff member and customer, ready for appointments. */
async function clinic(): Promise<World> {
  const w = factory.world();
  await w.make('tenants');
  await w.make('branches');
  await w.make('staff_profiles');
  await w.make('customers');
  return w;
}

async function appointment(
  w: World,
  startIso: string,
  endIso: string,
  status = 'CONFIRMED',
): Promise<string> {
  // Optional foreign keys are left NULL by the factory, and a NULL staff never conflicts — so name them.
  return w.make('appointments', {
    start_at: startIso,
    end_at: endIso,
    status,
    staffId: w.get('staff_profiles'),
    branchId: w.get('branches'),
    customerId: w.get('customers'),
  });
}

const BURST = 8;

describe('appointments_no_overlap (double-booking guard)', () => {
  runIf('rejects an overlapping booking for the same staff, allows adjacent and cancelled ones', async () => {
    const w = await clinic();
    const staff = w.get('staff_profiles')!;
    await appointment(w, '2031-03-01T10:00:00Z', '2031-03-01T11:00:00Z');

    const overlap = await attempt(
      `INSERT INTO appointments (id, "tenantId", "branchId", "staffId", "customerId", start_at, end_at, status)
       VALUES ($1,$2,$3,$4,$5,'2031-03-01T10:30:00Z','2031-03-01T11:30:00Z','CONFIRMED')`,
      [randomUUID(), w.get('tenants'), w.get('branches'), staff, w.get('customers')],
    );
    expect(overlap).toMatchObject({ ok: false, code: '23P01', constraint: 'appointments_no_overlap' });

    // [start, end) — an appointment starting exactly when the previous ends is valid.
    await appointment(w, '2031-03-01T11:00:00Z', '2031-03-01T12:00:00Z');
    // A cancelled booking does not hold the slot.
    await appointment(w, '2031-03-01T10:00:00Z', '2031-03-01T11:00:00Z', 'CANCELLED');

    expect(await count(`SELECT count(*) n FROM appointments WHERE "staffId" = $1`, [staff])).toBe(3);
  });

  runIf('lets exactly one of a concurrent burst for the same slot win', async () => {
    const w = await clinic();
    const staff = w.get('staff_profiles')!;
    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        attempt(
          `INSERT INTO appointments (id, "tenantId", "branchId", "staffId", "customerId", start_at, end_at, status)
           VALUES ($1,$2,$3,$4,$5,'2031-04-01T14:00:00Z','2031-04-01T15:00:00Z','CONFIRMED')`,
          [randomUUID(), w.get('tenants'), w.get('branches'), staff, w.get('customers')],
        ),
      ),
    );
    expect(winners(outcomes)).toBe(1);
    expect(outcomes.filter((o) => !o.ok).every((o) => o.constraint === 'appointments_no_overlap')).toBe(true);
    expect(await count(`SELECT count(*) n FROM appointments WHERE "staffId" = $1`, [staff])).toBe(1);
  });
});

describe('payments', () => {
  runIf('allows one PENDING payment per appointment under a concurrent burst; the loser leaves no row', async () => {
    const w = await clinic();
    const appt = await appointment(w, '2031-05-01T09:00:00Z', '2031-05-01T10:00:00Z');
    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        attempt(
          `INSERT INTO payments (id, "tenantId", "appointmentId", amount, status) VALUES ($1,$2,$3,50,'PENDING')`,
          [randomUUID(), w.get('tenants'), appt],
        ),
      ),
    );
    expect(winners(outcomes)).toBe(1);
    expect(
      outcomes.filter((o) => !o.ok).every((o) => o.code === '23505' && o.constraint === 'uq_payments_appointment_pending'),
    ).toBe(true);
    expect(await count(`SELECT count(*) n FROM payments WHERE "appointmentId" = $1`, [appt])).toBe(1);

    // The guard covers PENDING only: once settled, a fresh attempt (e.g. a retry after failure) is valid.
    await ds.query(`UPDATE payments SET status = 'FAILED' WHERE "appointmentId" = $1`, [appt]);
    const retry = await attempt(
      `INSERT INTO payments (id, "tenantId", "appointmentId", amount, status) VALUES ($1,$2,$3,50,'PENDING')`,
      [randomUUID(), w.get('tenants'), appt],
    );
    expect(retry.ok).toBe(true);
    expect(await count(`SELECT count(*) n FROM payments WHERE "appointmentId" = $1`, [appt])).toBe(2);
  });

  runIf('keeps gateway_payment_id unique (concurrently) while allowing many payments without one', async () => {
    const w = await clinic();
    const gatewayId = `chg_${randomUUID()}`;
    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        attempt(
          `INSERT INTO payments (id, "tenantId", amount, status, gateway_payment_id) VALUES ($1,$2,10,'PAID',$3)`,
          [randomUUID(), w.get('tenants'), gatewayId],
        ),
      ),
    );
    expect(winners(outcomes)).toBe(1);
    expect(outcomes.filter((o) => !o.ok).every((o) => o.code === '23505')).toBe(true);
    expect(await count(`SELECT count(*) n FROM payments WHERE gateway_payment_id = $1`, [gatewayId])).toBe(1);

    // NULL gateway ids (manual / not-yet-charged payments) must not collide with each other.
    const nulls = await Promise.all(
      Array.from({ length: 3 }, () =>
        attempt(`INSERT INTO payments (id, "tenantId", amount, status) VALUES ($1,$2,10,'PAID')`, [
          randomUUID(),
          w.get('tenants'),
        ]),
      ),
    );
    expect(winners(nulls)).toBe(3);
  });

  runIf('records a gateway webhook event once however many times it is delivered', async () => {
    const eventId = `evt_${randomUUID()}`;
    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        attempt(
          `INSERT INTO transactions (id, gateway_transaction_id, type, amount, status) VALUES ($1,$2,'webhook',10,'received')`,
          [randomUUID(), eventId],
        ),
      ),
    );
    expect(winners(outcomes)).toBe(1);
    expect(outcomes.filter((o) => !o.ok).every((o) => o.constraint === 'uq_txn_webhook_event')).toBe(true);
    expect(await count(`SELECT count(*) n FROM transactions WHERE gateway_transaction_id = $1`, [eventId])).toBe(1);

    // The dedup is for webhook rows: other transaction types may legitimately share a gateway id.
    const other = await attempt(
      `INSERT INTO transactions (id, gateway_transaction_id, type, amount, status) VALUES ($1,$2,'charge',10,'ok')`,
      [randomUUID(), eventId],
    );
    expect(other.ok).toBe(true);
  });
});

describe('queue_entries (live entry per appointment)', () => {
  runIf('creates exactly one live entry for concurrent check-ins; a finished entry frees the slot', async () => {
    const w = await clinic();
    const appt = await appointment(w, '2031-06-01T09:00:00Z', '2031-06-01T10:00:00Z');
    const insert = () =>
      attempt(
        `INSERT INTO queue_entries (id, "tenantId", "branchId", "appointmentId", "customerId", "staffId", business_date, state, arrived_at)
         VALUES ($1,$2,$3,$4,$5,$6,'2031-06-01','WAITING', now())`,
        [randomUUID(), w.get('tenants'), w.get('branches'), appt, w.get('customers'), w.get('staff_profiles')],
      );
    const outcomes = await Promise.all(Array.from({ length: BURST }, insert));
    expect(winners(outcomes)).toBe(1);
    expect(
      outcomes.filter((o) => !o.ok).every((o) => o.code === '23505' && o.constraint === 'UQ_queue_entries_appointment_live'),
    ).toBe(true);
    expect(await count(`SELECT count(*) n FROM queue_entries WHERE "appointmentId" = $1`, [appt])).toBe(1);

    await ds.query(`UPDATE queue_entries SET state = 'COMPLETED' WHERE "appointmentId" = $1`, [appt]);
    expect((await insert()).ok).toBe(true);
    expect(await count(`SELECT count(*) n FROM queue_entries WHERE "appointmentId" = $1`, [appt])).toBe(2);
  });
});

describe('transactions and foreign keys', () => {
  runIf('a failed transaction leaves nothing behind', async () => {
    const slug = `rollback-${randomUUID()}`;
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let failed = false;
    try {
      await qr.query(`INSERT INTO tenants (id, name, slug, contact_email) VALUES ($1,'Rollback Clinic',$2,$3)`, [
        randomUUID(),
        slug,
        `${slug}@example.test`,
      ]);
      // Second statement violates a unique index -> the whole transaction must be undone.
      await qr.query(`INSERT INTO tenants (id, name, slug, contact_email) VALUES ($1,'Duplicate',$2,$3)`, [
        randomUUID(),
        slug,
        `other-${slug}@example.test`,
      ]);
      await qr.commitTransaction();
    } catch {
      failed = true;
      await qr.rollbackTransaction();
    } finally {
      await qr.release();
    }
    expect(failed).toBe(true);
    expect(await count(`SELECT count(*) n FROM tenants WHERE slug = $1`, [slug])).toBe(0);
  });

  runIf('refuses to delete a user that audit history references, and children-first deletion succeeds', async () => {
    const w = factory.world();
    await w.make('tenants');
    const userId = await w.make('users');
    const auditId = await w.make('audit_logs', { userId });

    const blocked = await attempt(`DELETE FROM users WHERE id = $1`, [userId]);
    expect(blocked).toMatchObject({ ok: false, code: '23503' }); // NO ACTION on purpose: audit outlives its actor
    expect(await count(`SELECT count(*) n FROM users WHERE id = $1`, [userId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM audit_logs WHERE id = $1`, [auditId])).toBe(1);

    await ds.query(`DELETE FROM audit_logs WHERE id = $1`, [auditId]);
    expect((await attempt(`DELETE FROM users WHERE id = $1`, [userId])).ok).toBe(true);
    expect(await count(`SELECT count(*) n FROM users WHERE id = $1`, [userId])).toBe(0);
  });
});

describe('seeding', () => {
  const SEEDED = ['permissions', 'roles', 'role_permissions', 'users', 'user_roles'] as const;
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(SEEDED.map(async (t) => [t, await count(`SELECT count(*) n FROM "${t}"`)] as const)),
    );

  runIf('is repeatable: three runs leave identical row counts and never raise a duplicate-key error', async () => {
    await runSeeders(ds);
    const first = await snapshot();
    expect(first.permissions).toBeGreaterThan(0);
    expect(first.roles).toBeGreaterThan(0);
    expect(first.role_permissions).toBeGreaterThan(0);

    await expect(runSeeders(ds)).resolves.toBeUndefined();
    await expect(runSeeders(ds)).resolves.toBeUndefined();
    expect(await snapshot()).toEqual(first);
  });
});
