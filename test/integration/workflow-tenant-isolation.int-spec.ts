/**
 * OFFLINE integration test — real PostgreSQL. Proves the workflow engine's
 * tenant isolation the same way `workflow-claim.int-spec.ts` proves the
 * atomic claim: a mocked repository can only prove the query SHAPE, not that
 * Postgres actually enforces the tenant filter — that needs a real database.
 *
 * Covers: a workflow/run belonging to tenant A is invisible (NOT_FOUND) to
 * tenant B, and `WorkflowRecipientResolver` (which resolves an EMAIL/WHATSAPP
 * action's recipient from `context.customerId`/`staffId`) never resolves a
 * customer/staff row across tenants even when handed the exact right id.
 *
 * Runs against a throwaway DB created from DATABASE_URL. Skips cleanly if the
 * DB is unreachable.
 *
 * Run: npx jest --config test/jest-integration.json test/integration/workflow-tenant-isolation.int-spec.ts
 */
import 'dotenv/config';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { Workflow } from '../../src/entities/Workflows/Workflow';
import { WorkflowRun } from '../../src/entities/Workflows/WorkflowRun';
import { Customer } from '../../src/entities/CRM/Customer';
import { StaffProfile } from '../../src/entities/Staff/StaffProfile';
import { User } from '../../src/entities/Auth&RBAC/User';
import { WorkflowService } from '../../src/modules/workflow/workflow.service';
import { WorkflowRecipientResolver } from '../../src/modules/workflow/workflow-recipient.resolver';
import { WORKFLOW_RECIPIENT_TYPE } from '../../src/modules/workflow/workflow.constants';
import { AppError } from '../../src/common/errors';

const TEST_DB =
  process.env.INTEGRATION_TEST_DB_WORKFLOW_TENANCY ??
  'ziyarati_inttest_workflow_tenancy';
const BASE = process.env.DATABASE_URL ?? '';
const adminUrl = BASE.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = BASE.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

let ds: DataSource | null = null;
let available = false;

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
    migrationsTransactionMode: 'each' as const,
  });
  await ds.initialize();
  await ds.runMigrations();
}

beforeAll(async () => {
  if (!BASE) return;
  try {
    await boot();
    available = true;
  } catch (e) {
    console.warn(
      'Workflow tenant-isolation integration test skipped (no DB):',
      (e as Error).message,
    );
  }
}, 60_000);

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
  if (!available) return;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await a.end();
});

const runIf = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(
    name,
    async () => {
      if (!available) return;
      await fn();
    },
    timeout,
  );

interface Fixture {
  tenantA: Tenant;
  tenantB: Tenant;
  workflowA: Workflow;
  runA: WorkflowRun;
  customerA: Customer;
  staffA: StaffProfile;
}

async function buildFixture(): Promise<Fixture> {
  const tenants = ds!.getRepository(Tenant);
  const workflows = ds!.getRepository(Workflow);
  const runs = ds!.getRepository(WorkflowRun);
  const customers = ds!.getRepository(Customer);
  const staffProfiles = ds!.getRepository(StaffProfile);
  const users = ds!.getRepository(User);

  const uniq = randomUUID();
  const tenantA = await tenants.save(
    tenants.create({
      name: `tenant-a-${uniq}`,
      slug: `tenant-a-${uniq}`,
      contact_email: `a-${uniq}@test.local`,
    }),
  );
  const tenantB = await tenants.save(
    tenants.create({
      name: `tenant-b-${uniq}`,
      slug: `tenant-b-${uniq}`,
      contact_email: `b-${uniq}@test.local`,
    }),
  );

  const workflowA = await workflows.save(
    workflows.create({
      tenant: tenantA,
      name: 'wf-a',
      trigger_event: 'appointment.created',
      actions: [{ type: 'EMAIL', recipientType: 'CUSTOMER', config: {} }],
    }),
  );
  const runA = await runs.save(
    runs.create({
      tenant: tenantA,
      workflow: workflowA,
      trigger_event: 'appointment.created',
      status: 'RUNNING',
      context: {},
      results: [],
    }),
  );

  const customerA = await customers.save(
    customers.create({
      tenant: tenantA,
      full_name: `customer-a-${uniq}`,
      phone: `9665${uniq.slice(0, 8)}`,
      email: `cust-a-${uniq}@test.local`,
    }),
  );

  const userA = await users.save(
    users.create({
      tenant: tenantA,
      email: `staff-a-${uniq}@test.local`,
      phone: `9665${uniq.slice(8, 16)}`,
      password_hash: 'x',
    } as Partial<User>),
  );
  const staffA = await staffProfiles.save(
    staffProfiles.create({
      tenant: tenantA,
      user: userA,
      title: 'Staff A',
      public_slug: `staff-a-${uniq}`,
    } as Partial<StaffProfile>),
  );

  return { tenantA, tenantB, workflowA, runA, customerA, staffA };
}

describe('Workflow engine — tenant isolation (real Postgres)', () => {
  let service: WorkflowService;
  let recipients: WorkflowRecipientResolver;

  beforeAll(() => {
    if (!available) return;
    service = new WorkflowService(
      ds!.getRepository(Workflow),
      ds!.getRepository(WorkflowRun),
      ds!,
    );
    recipients = new WorkflowRecipientResolver(
      ds!.getRepository(Customer),
      ds!.getRepository(StaffProfile),
    );
  });

  runIf(
    "tenant B cannot fetch tenant A's workflow by id — NOT_FOUND, not the actual row",
    async () => {
      const { tenantB, workflowA } = await buildFixture();
      await expect(
        service.findOne(tenantB.id, workflowA.id),
      ).rejects.toBeInstanceOf(AppError);
    },
  );

  runIf(
    "tenant B cannot fetch tenant A's run by id (getOwnedRun — the Test Run polling endpoint's own guard)",
    async () => {
      const { tenantB, runA } = await buildFixture();
      await expect(
        service.getOwnedRun(tenantB.id, runA.id),
      ).rejects.toBeInstanceOf(AppError);
    },
  );

  runIf(
    "tenant B cannot list tenant A's run under tenant A's workflow id (listRuns ownership check)",
    async () => {
      const { tenantB, workflowA } = await buildFixture();
      await expect(
        service.listRuns(tenantB.id, workflowA.id),
      ).rejects.toBeInstanceOf(AppError);
    },
  );

  runIf(
    'tenant A CAN fetch its own workflow and run — the isolation is per-tenant, not a blanket failure',
    async () => {
      const { tenantA, workflowA, runA } = await buildFixture();
      await expect(
        service.findOne(tenantA.id, workflowA.id),
      ).resolves.toMatchObject({ id: workflowA.id });
      await expect(
        service.getOwnedRun(tenantA.id, runA.id),
      ).resolves.toMatchObject({ id: runA.id });
    },
  );

  runIf(
    "WorkflowRecipientResolver never resolves tenant A's customer for tenant B, even given the exact right id " +
      "(this is what stands between a WHATSAPP/EMAIL action and messaging the wrong tenant's customer)",
    async () => {
      const { tenantA, tenantB, customerA } = await buildFixture();
      const asTenantB = await recipients.resolve(
        tenantB.id,
        WORKFLOW_RECIPIENT_TYPE.CUSTOMER,
        {
          customerId: customerA.id,
        },
      );
      expect(asTenantB).toBeNull();

      const asTenantA = await recipients.resolve(
        tenantA.id,
        WORKFLOW_RECIPIENT_TYPE.CUSTOMER,
        {
          customerId: customerA.id,
        },
      );
      expect(asTenantA).toMatchObject({
        phone: customerA.phone,
        email: customerA.email,
      });
    },
  );

  runIf(
    "WorkflowRecipientResolver never resolves tenant A's staff for tenant B, even given the exact right id",
    async () => {
      const { tenantA, tenantB, staffA } = await buildFixture();
      const asTenantB = await recipients.resolve(
        tenantB.id,
        WORKFLOW_RECIPIENT_TYPE.STAFF,
        { staffId: staffA.id },
      );
      expect(asTenantB).toBeNull();

      const asTenantA = await recipients.resolve(
        tenantA.id,
        WORKFLOW_RECIPIENT_TYPE.STAFF,
        { staffId: staffA.id },
      );
      expect(asTenantA?.phone).toBeDefined();
    },
  );

  runIf(
    "pickSampleContext (the Test Run auto-context) only ever picks tenant A's own customer/staff, never tenant B's",
    async () => {
      const { tenantA, customerA, staffA } = await buildFixture();
      const sample = await recipients.pickSampleContext(tenantA.id);
      expect(sample.customerId).toBe(customerA.id);
      expect(sample.staffId).toBe(staffA.id);
    },
  );
});
