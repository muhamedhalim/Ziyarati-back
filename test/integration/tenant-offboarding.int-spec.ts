/**
 * REAL-DATABASE integration test — tenant offboarding (residency plan P11).
 *
 * The deletion plan is derived from the schema, so the proof has to be against
 * the schema as PostgreSQL really has it. This builds a throwaway database from
 * the full migration chain, seeds one row in EVERY tenant-owned table for two
 * clinics (parents auto-created through the real foreign keys), offboards one,
 * and checks row by row that every row of that clinic is gone and every row of
 * the other — and every shared lookup row — is still there.
 *
 * Also proves the guards: an active clinic is refused, the confirmation must
 * match, a dry run changes nothing, and a failure part-way undoes everything.
 *
 * Skips cleanly when no database is reachable. Run:
 *   DATABASE_URL=postgres://... npx jest --config test/jest-integration.json test/integration/tenant-offboarding.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { TenantOffboardingService } from '../../src/modules/data-governance/tenant-offboarding.service';
import {
  GLOBAL_TABLES,
  type TenantDeletionStep,
} from '../../src/modules/data-governance/tenant-offboarding.plan';
import { PgFactory, type World } from './support/pg-factory';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_OFFBOARD ?? 'ziyarati_inttest_offboard';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let available = false;
let factory: PgFactory;

const purged: string[] = [];
const storageFake = {
  purgeTenantPrefix: jest.fn(async (tenantId: string) => {
    purged.push(tenantId);
    return { versionsRemoved: 5 };
  }),
};

async function boot() {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  ds = new DataSource({
    type: 'postgres',
    url: testUrl,
    // The service reads `entityMetadatas` to build the plan, so the REAL entity set is loaded.
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
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn(
      'Tenant-offboarding integration test skipped (no DB):',
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

beforeEach(() => {
  purged.length = 0;
  storageFake.purgeTenantPrefix.mockClear();
});

const runIf = (name: string, fn: () => Promise<void>, timeout = 300_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

const service = () => new TenantOffboardingService(ds!, storageFake as never);

const present = async (table: string, id: string): Promise<boolean> =>
  Number(
    (
      await ds!.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "id" = $1`,
        [id],
      )
    )[0].n,
  ) === 1;

/** A well-ordered, non-overlapping appointment, so tables that auto-create one as a parent can seed. */
let apptSlot = 100;
async function seedAppointment(w: World): Promise<string> {
  const start = new Date(Date.UTC(2027, 0, 1, 9, 0) + ++apptSlot * 3_600_000);
  return w.make('appointments', {
    start_at: start,
    end_at: new Date(start.getTime() + 1_800_000),
  });
}

/**
 * Sales targets / bonuses are PLATFORM data keyed by a sales rep (a platform user, no tenant). Seeding
 * them against a clinic's user would be a synthetic artifact, not a case offboarding meets.
 */
const PLATFORM_SALES = new Set([
  'sales_targets',
  'sales_bonus_records',
  'sales_target_revisions',
]);

interface Seeded {
  a: World;
  b: World;
  tenantA: string;
  tenantB: string;
  /** Tables for which seeding a row failed (a CHECK the placeholder violates) — must stay small. */
  unseeded: string[];
}

async function seedBoth(): Promise<Seeded> {
  // `connected`: optional foreign keys are filled too, so the rows form the real ownership chains.
  const a = factory.world({ connected: true });
  const b = factory.world({ connected: true });
  const tenantA = await a.make('tenants', {
    name: 'Clinic Alpha Confidential',
    is_active: false,
  });
  const tenantB = await b.make('tenants', {
    name: 'Clinic Beta',
    is_active: false,
  });
  // Tables whose CHECK / unique constraints reject a generic placeholder row get real values.
  const specific: Record<string, Record<string, unknown>> = {
    sales_activities: { prospect_name: 'Prospect', type: 'visit' },
    sales_clinic_assignments: { kind: 'acquired' },
    waitlist_entries: { state: 'CANCELLED' },
  };
  // Parents that constrain their children are created first, with valid values.
  const day = (n: number) => new Date(Date.UTC(2026, 10, n, 9, 0));
  await a.make('appointments', {
    start_at: day(1),
    end_at: new Date(day(1).getTime() + 1_800_000),
  });
  await b.make('appointments', {
    start_at: day(2),
    end_at: new Date(day(2).getTime() + 1_800_000),
  });
  let slot = 10;
  const unseeded: string[] = [];
  const reasons: Record<string, string> = {};
  const plan = await service().getPlan();
  for (const step of plan) {
    if (step.table === 'tenants' || PLATFORM_SALES.has(step.table)) continue;
    for (const w of [a, b]) {
      try {
        // An appointment needs its own non-overlapping, well-ordered time slot.
        const own =
          step.table === 'appointments'
            ? {
                start_at: day(++slot),
                end_at: new Date(day(slot).getTime() + 1_800_000),
              }
            : {};
        await w.make(step.table, { ...(specific[step.table] ?? {}), ...own });
      } catch (e) {
        if (!unseeded.includes(step.table)) unseeded.push(step.table);
        reasons[step.table] = (e as Error).message.slice(0, 140);
      }
    }
  }
  if (unseeded.length) console.warn(JSON.stringify(reasons, null, 1));
  return { a, b, tenantA, tenantB, unseeded };
}

describe('TenantOffboardingService against real PostgreSQL', () => {
  runIf(
    'deletes EVERY row of the clinic in EVERY owned table and nothing else',
    async () => {
      const s = await seedBoth();
      const plan = await service().getPlan();
      const planned = new Set(plan.map((p) => p.table));

      // The proof is only as strong as the seeding: nearly every owned table must have been exercised.
      expect(plan.length).toBeGreaterThan(100);
      expect(s.unseeded.length).toBeLessThanOrEqual(
        Math.ceil(plan.length * 0.1),
      );
      if (s.unseeded.length)
        console.warn(
          'not seeded (excluded from the row-level proof):',
          s.unseeded.join(', '),
        );

      // The seeded clinic has ledger rows, so the sweep needs the explicit ledger opt-in.
      const result = await service().offboard(s.tenantA, {
        confirm: s.tenantA,
        purgeLedger: true,
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.evidenceId).toBeTruthy();

      const leftBehind: string[] = [];
      for (const row of s.a.created) {
        const shouldBeGone = planned.has(row.table);
        const here = await present(row.table, row.id);
        if (shouldBeGone && here) leftBehind.push(`${row.table}/${row.id}`);
        if (!shouldBeGone && !here)
          leftBehind.push(`WRONGLY DELETED global ${row.table}/${row.id}`);
      }
      expect(leftBehind).toEqual([]);

      // The other clinic is intact, row for row.
      const lost: string[] = [];
      for (const row of s.b.created)
        if (!(await present(row.table, row.id)))
          lost.push(`${row.table}/${row.id}`);
      expect(lost).toEqual([]);

      // Shared lookup / catalogue tables untouched.
      for (const g of GLOBAL_TABLES) {
        const own = s.a.created.filter((r) => r.table === g);
        for (const r of own) expect(await present(g, r.id)).toBe(true);
      }
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "tenants" WHERE "id" = $1`,
              [s.tenantA],
            )
          )[0].n,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "tenants" WHERE "id" = $1`,
              [s.tenantB],
            )
          )[0].n,
        ),
      ).toBe(1);

      // Stored objects: the whole tenant prefix, purged once, after the commit.
      expect(purged).toEqual([s.tenantA]);
    },
  );

  runIf(
    'REFUSES a clinic with rows in the immutable payment ledger unless the ledger purge is explicit — and deletes nothing',
    async () => {
      const w = factory.world({ connected: true });
      const tenant = await w.make('tenants', { is_active: false });
      await w.make('customers', { tenantId: tenant });
      await seedAppointment(w);
      await w.make('transactions', {});
      const ledger = () =>
        ds!.query(
          `SELECT count(*)::int AS n FROM "transactions" WHERE "tenantId" = $1`,
          [tenant],
        );
      expect(Number((await ledger())[0].n)).toBe(1);

      await expect(
        service().offboard(tenant, { confirm: tenant }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('immutable payment ledger'),
      });
      // Whole: the refusal came before any delete.
      expect(Number((await ledger())[0].n)).toBe(1);
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "customers" WHERE "tenantId" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(1);
      expect(purged).toEqual([]);
    },
  );

  runIf(
    'with the explicit ledger purge it removes ONLY this clinic ledger rows and the trigger is back on afterwards',
    async () => {
      const a = factory.world({ connected: true });
      const b = factory.world({ connected: true });
      const tenantA = await a.make('tenants', { is_active: false });
      const tenantB = await b.make('tenants', { is_active: false });
      await seedAppointment(a);
      await seedAppointment(b);
      await a.make('transactions', {});
      await b.make('transactions', {});

      const r = await service().offboard(tenantA, {
        confirm: tenantA,
        purgeLedger: true,
      });
      expect(r.status).toBe('COMPLETED');
      expect(r.report.options).toMatchObject({ purgeLedger: true });
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "transactions" WHERE "tenantId" = $1`,
              [tenantA],
            )
          )[0].n,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "transactions" WHERE "tenantId" = $1`,
              [tenantB],
            )
          )[0].n,
        ),
      ).toBe(1);

      // The guard is ENABLED again ('O' = fires on origin and local) and still bites.
      const [trig] = await ds!.query(
        `SELECT "tgenabled" FROM pg_trigger WHERE "tgname" = 'transactions_no_mutate' AND NOT "tgisinternal"`,
      );
      expect(trig.tgenabled).toBe('O');
      await expect(
        ds!.query(`DELETE FROM "transactions" WHERE "tenantId" = $1`, [
          tenantB,
        ]),
      ).rejects.toThrow(/append-only/);
    },
  );

  runIf(
    'a failure during a ledger purge leaves the trigger ENABLED and the ledger intact',
    async () => {
      const w = factory.world({ connected: true });
      const tenant = await w.make('tenants', { is_active: false });
      await seedAppointment(w);
      await w.make('transactions', {});
      const svc = service();
      const real = await svc.getPlan();
      const broken: TenantDeletionStep = {
        table: 'customers',
        predicate: `"no_such_column" = :tenant`,
        ownedBy: 'direct',
      };
      (svc as unknown as { plan: TenantDeletionStep[] }).plan = [
        ...real.slice(0, real.findIndex((p) => p.table === 'transactions') + 1),
        broken,
      ];

      await expect(
        svc.offboard(tenant, { confirm: tenant, purgeLedger: true }),
      ).rejects.toThrow();
      const [trig] = await ds!.query(
        `SELECT "tgenabled" FROM pg_trigger WHERE "tgname" = 'transactions_no_mutate' AND NOT "tgisinternal"`,
      );
      expect(trig.tgenabled).toBe('O');
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "transactions" WHERE "tenantId" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(1);
    },
  );

  runIf(
    'refuses a clinic that is still active, and a wrong confirmation, and changes nothing',
    async () => {
      const w = factory.world();
      const tenant = await w.make('tenants', { is_active: true });
      await w.make('customers', { tenantId: tenant });

      await expect(
        service().offboard(tenant, { confirm: tenant }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('still active'),
      });
      await ds!.query(
        `UPDATE "tenants" SET "is_active" = false WHERE "id" = $1`,
        [tenant],
      );
      await expect(
        service().offboard(tenant, { confirm: 'not-it' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Confirmation'),
      });
      await expect(
        service().offboard('not-a-uuid', { confirm: 'not-a-uuid' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('valid tenant id'),
      });

      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "customers" WHERE "tenantId" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(1);
      expect(purged).toEqual([]);
    },
  );

  runIf(
    'a dry run reports exact counts, changes nothing, writes no evidence and purges nothing',
    async () => {
      const w = factory.world();
      const tenant = await w.make('tenants', { is_active: false });
      await w.make('customers', { tenantId: tenant });
      await w.make('customers', { tenantId: tenant });
      const before = Number(
        (
          await ds!.query(`SELECT count(*)::int AS n FROM "deletion_evidence"`)
        )[0].n,
      );

      const r = await service().offboard(tenant, {
        confirm: tenant,
        dryRun: true,
      });
      expect(r.dryRun).toBe(true);
      expect(
        r.report.stores.find((x) => x.target === 'customers'),
      ).toMatchObject({ action: 'deleted', affected: 2 });
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "customers" WHERE "tenantId" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(2);
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "tenants" WHERE "id" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "deletion_evidence"`,
            )
          )[0].n,
        ),
      ).toBe(before);
      expect(purged).toEqual([]);
    },
  );

  runIf('rolls the WHOLE transaction back when any step fails', async () => {
    const w = factory.world();
    const tenant = await w.make('tenants', { is_active: false });
    const customer = await w.make('customers', { tenantId: tenant });
    await w.make('customer_addresses', {
      customerId: customer,
      tenantId: tenant,
    });

    const svc = service();
    const real = await svc.getPlan();
    const broken: TenantDeletionStep = {
      table: 'customers',
      predicate: `"no_such_column" = :tenant`,
      ownedBy: 'direct',
    };
    // Everything before the customers step succeeds first, then the broken one fails.
    (svc as unknown as { plan: TenantDeletionStep[] }).plan = [
      ...real.slice(0, real.findIndex((p) => p.table === 'customers') + 1),
      broken,
    ];

    await expect(svc.offboard(tenant, { confirm: tenant })).rejects.toThrow();
    expect(
      Number(
        (
          await ds!.query(
            `SELECT count(*)::int AS n FROM "customers" WHERE "tenantId" = $1`,
            [tenant],
          )
        )[0].n,
      ),
    ).toBe(1);
    expect(
      Number(
        (
          await ds!.query(
            `SELECT count(*)::int AS n FROM "customer_addresses" WHERE "tenantId" = $1`,
            [tenant],
          )
        )[0].n,
      ),
    ).toBe(1);
    expect(purged).toEqual([]);
  });

  runIf(
    'writes evidence that names tables and counts only, and keeps the proof after the tenant is gone',
    async () => {
      const w = factory.world();
      const tenant = await w.make('tenants', {
        name: 'Clinic Gamma Secret Name',
        is_active: false,
      });
      await w.make('customers', {
        tenantId: tenant,
        full_name: 'Patient Zero Name',
        email: 'zero@example.com',
      });
      const r = await service().offboard(tenant, { confirm: tenant });

      const [ev] = await ds!.query(
        `SELECT * FROM "deletion_evidence" WHERE "id" = $1`,
        [r.evidenceId],
      );
      expect(ev).toMatchObject({
        scope: 'TENANT',
        tenant_id: tenant,
        subject_id: null,
        status: 'COMPLETED',
      });
      const text = JSON.stringify(ev);
      for (const secret of [
        'Clinic Gamma Secret Name',
        'Patient Zero Name',
        'zero@example.com',
      ])
        expect(text).not.toContain(secret);
      const actions = new Set(
        (ev.report.stores as Array<{ action: string }>).map((x) => x.action),
      );
      expect(actions).toEqual(new Set(['deleted', 'not_covered']));
      // The proof outlived the tenant it describes.
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "tenants" WHERE "id" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(0);
    },
  );

  runIf(
    'reports a failed storage purge as PARTIAL, after the database is already clean',
    async () => {
      const w = factory.world();
      const tenant = await w.make('tenants', { is_active: false });
      storageFake.purgeTenantPrefix.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDenied' }),
      );
      const r = await service().offboard(tenant, { confirm: tenant });
      expect(r.status).toBe('PARTIAL');
      expect(
        r.report.stores.find((x) => x.action === 'failed')?.reason,
      ).toContain('database is already clean');
      expect(
        Number(
          (
            await ds!.query(
              `SELECT count(*)::int AS n FROM "tenants" WHERE "id" = $1`,
              [tenant],
            )
          )[0].n,
        ),
      ).toBe(0);
    },
  );
});
