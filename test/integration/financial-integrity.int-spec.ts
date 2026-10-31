/**
 * REAL-DATABASE integration test - the money invariants added by migration
 * `FinancialIntegrityChecks1730127000000` (financial audit FIN-X5), on a database built from the
 * full migration chain:
 *
 *   - a payment cannot be for zero / a negative amount
 *   - refunded_amount can neither go negative nor exceed the amount paid
 *   - a refund cannot be zero / negative
 *   - one payment cannot sit in two settlements
 *   - the migration REFUSES (and changes nothing) when existing data already violates an invariant,
 *     and succeeds once the data is fixed; and it is reversible
 *
 * Throwaway database created from DATABASE_URL; dropped afterwards. Under CI / REQUIRE_TESTCONTAINERS a
 * missing database is a failure, not a skip (test/utils/require-infra.ts).
 *
 * Run: DATABASE_URL=postgres://... npx jest --config test/jest-integration.json test/integration/financial-integrity.int-spec.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { infraUnavailable } from '../utils/require-infra';
import { PgFactory, type World } from './support/pg-factory';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_FINANCIAL ?? 'ziyarati_inttest_financial';
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
  await admin
    .query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    .catch(() => undefined);
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

async function attempt(sql: string, params: unknown[] = []): Promise<Outcome> {
  try {
    await ds.query(sql, params);
    return { ok: true };
  } catch (e) {
    const err = e as {
      driverError?: { code?: string; constraint?: string };
      code?: string;
      constraint?: string;
    };
    return {
      ok: false,
      code: err.driverError?.code ?? err.code,
      constraint: err.driverError?.constraint ?? err.constraint,
    };
  }
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await ds.query(sql, params))[0].n);

async function tenant(): Promise<World> {
  const w = factory.world();
  await w.make('tenants');
  return w;
}

const insertPayment = (w: World, amount: number, refunded = 0) =>
  attempt(
    `INSERT INTO payments (id, "tenantId", amount, refunded_amount, status, paid_at) VALUES ($1,$2,$3,$4,'PAID',now())`,
    [randomUUID(), w.get('tenants'), amount, refunded],
  );

const MIGRATION = 'FinancialIntegrityChecks1730127000000';

describe('financial integrity constraints (FIN-X5)', () => {
  runIf('refuses a zero or negative payment amount, accepts a positive one', async () => {
    const w = await tenant();
    for (const bad of [0, -5]) {
      const r = await insertPayment(w, bad);
      expect(r).toMatchObject({
        ok: false,
        code: '23514',
        constraint: 'CHK_payments_amount_positive',
      });
    }
    expect((await insertPayment(w, 10)).ok).toBe(true);
  });

  runIf('refuses a captured payment without paid_at (PAY-008)', async () => {
    const w = await tenant();
    for (const status of ['PAID', 'PARTIALLY_REFUNDED']) {
      expect(
        await attempt(
          `INSERT INTO payments (id, "tenantId", amount, status) VALUES ($1,$2,10,$3)`,
          [randomUUID(), w.get('tenants'), status],
        ),
      ).toMatchObject({ ok: false, code: '23514', constraint: 'CHK_payments_paid_has_paid_at' });
    }
    expect(
      (
        await attempt(
          `INSERT INTO payments (id, "tenantId", amount, status) VALUES ($1,$2,10,'PENDING')`,
          [randomUUID(), w.get('tenants')],
        )
      ).ok,
    ).toBe(true);
  });

  runIf('keeps refunded_amount within 0..amount', async () => {
    const w = await tenant();
    expect((await insertPayment(w, 100, 100)).ok).toBe(true); // fully refunded
    expect((await insertPayment(w, 100, 40)).ok).toBe(true);
    for (const refunded of [-1, 100.01]) {
      expect(await insertPayment(w, 100, refunded)).toMatchObject({
        ok: false,
        code: '23514',
        constraint: 'CHK_payments_refunded_within_amount',
      });
    }
  });

  runIf('refuses a payment update that would over-refund it', async () => {
    const w = await tenant();
    const id = randomUUID();
    await ds.query(
      `INSERT INTO payments (id, "tenantId", amount, status, paid_at) VALUES ($1,$2,50,'PAID',now())`,
      [id, w.get('tenants')],
    );
    const r = await attempt(
      `UPDATE payments SET refunded_amount = 60 WHERE id = $1`,
      [id],
    );
    expect(r).toMatchObject({
      ok: false,
      constraint: 'CHK_payments_refunded_within_amount',
    });
    expect(
      await count(
        `SELECT count(*) n FROM payments WHERE id = $1 AND refunded_amount = 0`,
        [id],
      ),
    ).toBe(1);
  });

  runIf('refuses a zero or negative refund', async () => {
    const w = await tenant();
    const paymentId = randomUUID();
    await ds.query(
      `INSERT INTO payments (id, "tenantId", amount, status, paid_at) VALUES ($1,$2,100,'PAID',now())`,
      [paymentId, w.get('tenants')],
    );
    const refund = (amount: number) =>
      attempt(
        `INSERT INTO refunds (id, "tenantId", "paymentId", amount) VALUES ($1,$2,$3,$4)`,
        [randomUUID(), w.get('tenants'), paymentId, amount],
      );
    for (const bad of [0, -1]) {
      expect(await refund(bad)).toMatchObject({
        ok: false,
        code: '23514',
        constraint: 'CHK_refunds_amount_positive',
      });
    }
    expect((await refund(25)).ok).toBe(true);
  });

  runIf('lets a payment sit in only ONE settlement', async () => {
    const w = await tenant();
    const paymentId = randomUUID();
    await ds.query(
      `INSERT INTO payments (id, "tenantId", amount, status, paid_at) VALUES ($1,$2,100,'PAID',now())`,
      [paymentId, w.get('tenants')],
    );
    const s1 = await w.make('settlements');
    const s2 = await w.make('settlements');
    const item = (settlement: string) =>
      attempt(
        `INSERT INTO settlement_items (settlement_id, payment_id, "settlementId", "paymentId") VALUES ($1,$2,$1,$2)`,
        [settlement, paymentId],
      );
    expect((await item(s1 as string)).ok).toBe(true);
    expect(await item(s2 as string)).toMatchObject({
      ok: false,
      code: '23505',
      constraint: 'UQ_settlement_items_payment',
    });
  });

  runIf('the migration refuses, changing nothing, when existing data violates an invariant - and succeeds once fixed', async () => {
    // Take this migration (and any added after it, newest first) back off, plant a violation,
    // then try to apply it again. It used to assume it was the LAST migration, which broke the
    // moment a later one was added.
    const applied = (): Promise<{ name: string }[]> =>
      ds.query(`SELECT name FROM migrations ORDER BY id DESC`);
    expect((await applied()).map((m) => m.name)).toContain(MIGRATION);
    for (
      let guard = 0;
      (await applied()).some((m) => m.name === MIGRATION);
      guard++
    ) {
      expect(guard).toBeLessThan(50);
      await ds.undoLastMigration({ transaction: 'each' });
    }
    expect(
      await count(
        `SELECT count(*) n FROM pg_constraint WHERE conname = 'CHK_payments_amount_positive'`,
      ),
    ).toBe(0);

    const w = await tenant();
    const badId = randomUUID();
    await ds.query(
      `INSERT INTO payments (id, "tenantId", amount, status, paid_at) VALUES ($1,$2,0,'PAID',now())`,
      [badId, w.get('tenants')],
    );

    await expect(ds.runMigrations({ transaction: 'each' })).rejects.toThrow(
      /NOT created.*1 payment\(s\) with amount <= 0/s,
    );
    expect(
      await count(
        `SELECT count(*) n FROM pg_constraint WHERE conname LIKE 'CHK_payments%' OR conname = 'CHK_refunds_amount_positive'`,
      ),
    ).toBe(0);
    expect(
      await count(`SELECT count(*) n FROM payments WHERE id = $1`, [badId]),
    ).toBe(1); // nothing was deleted or edited

    await ds.query(`UPDATE payments SET amount = 1 WHERE id = $1`, [badId]);
    await ds.runMigrations({ transaction: 'each' });
    expect(
      await count(
        `SELECT count(*) n FROM pg_constraint WHERE conname = 'CHK_payments_amount_positive'`,
      ),
    ).toBe(1);
    // running the chain again is a no-op
    await ds.runMigrations({ transaction: 'each' });
  }, 180_000);
});
