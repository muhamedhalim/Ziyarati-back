/**
 * FULL HTTP end-to-end for the two-way Integration Platform (Phase 4).
 *
 * This boots the REAL AppModule against the REAL Postgres and Redis (see
 * createE2eApp) and drives everything over HTTP through the production guard
 * chain. It proves the whole path, not a slice of it:
 *
 *   HTTP → authentication/authorization (JWT + API-key scopes)
 *        → admission control
 *        → database
 *        → enqueue (real BullMQ/Redis)
 *        → worker (the real processor's service entry point)
 *        → the ONE shared mutation pipeline
 *        → mapping / conflict / history / audit
 *
 * The queue leg is exercised for real, then DRAINED by invoking the same
 * service method the registered processor calls, in the same tenant context.
 * That is deliberate — the API process does not run workers in this
 * deployment, so spinning a second worker process here would test the
 * deployment topology rather than the pipeline. Import/inbound creation goes
 * through the transactional outbox (Phase 0 — see
 * docs/CACHING_QUEUES_AUDIT.md §0.5 item 4): the durable guarantee asserted
 * here is the `outbox_jobs` row (PENDING, correct dedupe_key/payload), not a
 * live BullMQ job — `OutboxRelayService` is what turns that row into a real
 * job, and it isn't running in this e2e app (worker-only service).
 *
 * DATABASE ISOLATION: every fixture lives under a freshly created Tenant and is
 * deleted in FK-safe order in afterAll.
 */
import request from 'supertest';
import { randomUUID, createHmac } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { Service } from '../src/entities/Services/Service';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { AuditLog } from '../src/entities/Auth&RBAC/AuditLog';
import { IntegrationIdMap } from '../src/entities/Integration/IntegrationIdMap';
import { IntegrationConflict } from '../src/entities/Integration/IntegrationConflict';
import { IntegrationInboundEvent } from '../src/entities/Integration/IntegrationInboundEvent';
import { IntegrationStaffProvisioning } from '../src/entities/Integration/IntegrationStaffProvisioning';
import { OutboxJob } from '../src/entities/Campaigns/OutboxJob';
import { OutboxStatus } from '../src/entities/enums';

import { IntegrationImportJobService } from '../src/modules/integration-platform/imports/integration-import-job.service';
import { IntegrationInboundService } from '../src/modules/integration-platform/inbound/integration-inbound.service';
import { IntegrationSyncService } from '../src/modules/integration-platform/sync/integration-sync.service';
import { runInTenantContext } from '../src/queue/tenant-context.runner';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../src/queue/worker-authorization.service';
import { JOB, QUEUE } from '../src/queue/queue.constants';
import { OutboxRelayService } from '../src/worker/outbox-relay.service';
import { QueueService } from '../src/queue/queue.service';

const API = '/api/v1';

/** Signs exactly like the receiver verifies: HMAC over "{ts}.{rawBody}". */
function signInbound(secret: string, ts: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function cleanupIntegrationTenant(e2e: E2eApp, tenantId: string): Promise<void> {
  const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
  await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_inbound_events WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_webhook_endpoints WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_staff_provisioning WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_oauth_states WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_conflicts WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_id_map WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_import_items WHERE "jobId" IN (SELECT id FROM integration_import_jobs WHERE "tenantId" = $1)`);
  await q(`DELETE FROM integration_import_jobs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_sync_jobs WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_idempotency_keys WHERE "tenantId" = $1`);
  await q(`DELETE FROM integration_connections WHERE "tenantId" = $1`);
  await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
  await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
  await q(`DELETE FROM branch_users WHERE "tenantId" = $1`);
  await q(`DELETE FROM branches WHERE "tenantId" = $1`);
  await q(`DELETE FROM services WHERE "tenantId" = $1`);
  await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
  await q(`DELETE FROM api_keys WHERE "tenantId" = $1`);
  await q(`DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`);
  await q(`DELETE FROM roles WHERE "tenantId" = $1`);
  await cleanupTenant(e2e, tenantId);
}

describe('Integration Platform — FULL HTTP e2e (Postgres + Redis + BullMQ + workers)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let other: OwnerFixture; // second tenant — cross-tenant isolation
  let connectionId: string;
  let apiKey: string;
  let serviceId: string;
  let branchId: string;

  let importJobs: IntegrationImportJobService;
  let inbound: IntegrationInboundService;
  let syncs: IntegrationSyncService;
  let ctx: TenantContextService;
  let authz: WorkerAuthorizationService;
  let relay: OutboxRelayService;
  let queueService: QueueService;

  const server = () => e2e.app.getHttpServer();

  /**
   * Runs a worker's entry point through the EXACT helper the registered
   * processors use (`runInTenantContext`), so the tenant ALS store is restored
   * the same way it is in a real worker — including the Phase 0 tenant/actor
   * authorization check (see WorkerAuthorizationService), using the REAL
   * service against the e2e app's DB so a genuinely-suspended-tenant test
   * would actually be rejected here too.
   */
  const drain = <T>(tenantId: string, fn: () => Promise<T>, jobName: string = JOB.INTEGRATION_IMPORT): Promise<T> =>
    runInTenantContext(ctx, authz, jobName, { tenantId } as never, fn);

  /**
   * Drives the REAL `OutboxRelayService` (not a reimplementation) through one
   * claim -> publish -> mark cycle (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.1). `OutboxRelayService` isn't
   * registered in `AppModule` (worker-only), so it's constructed directly here
   * from the e2e app's real `DataSource`/`QueueService` — exactly the same
   * pattern the `drain()` helper above already uses for `runInTenantContext`.
   * `drainBatch` is private; invoked via a type assertion, the same technique
   * `outbox-relay.service.spec.ts` already uses for its own unit tests.
   */
  const drainOutboxOnce = (): Promise<void> =>
    (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'intplat');
    other = await createOwnerFixture(e2e, 'intplat-other');

    importJobs = e2e.app.get(IntegrationImportJobService);
    inbound = e2e.app.get(IntegrationInboundService);
    syncs = e2e.app.get(IntegrationSyncService);
    ctx = e2e.app.get(TenantContextService);
    authz = e2e.app.get(WorkerAuthorizationService);
    queueService = e2e.app.get(QueueService);
    relay = new OutboxRelayService(e2e.dataSource, queueService);

    // Domain fixtures the appointment flow depends on.
    const services = e2e.dataSource.getRepository(Service);
    serviceId = (
      await services.save(
        services.create({
          tenant: { id: owner.tenantId } as Tenant,
          name: `Consult ${randomUUID().slice(0, 6)}`,
          duration_minutes: 30,
          is_active: true,
        }),
      )
    ).id;

    const branches = e2e.dataSource.getRepository(Branch);
    branchId = (
      await branches.save(
        branches.create({
          tenant: { id: owner.tenantId } as Tenant,
          name: `Main ${randomUUID().slice(0, 6)}`,
          is_active: true,
        }),
      )
    ).id;

    // The connection every test writes through.
    const conn = await request(server())
      .post(`${API}/platform/integrations/connections`)
      .set(...authHeader(owner.token))
      .send({
        name: 'E2E PMS',
        provider: 'generic_rest',
        authType: 'api_key',
        credential: 'pms-secret-value',
        config: { baseUrl: 'https://api.example.com', apiKey: { location: 'header', name: 'X-Api-Key' } },
        syncDirection: 'bidirectional',
        defaultConflictPolicy: 'external_wins',
      })
      .expect(201);
    connectionId = conn.body.id;

    // A real API key with the write scopes — the M2M auth leg.
    const key = await request(server())
      .post(`${API}/platform/api-keys`)
      .set(...authHeader(owner.token))
      .send({
        name: 'e2e-integration-key',
        permissions: [
          'integration.customers.write',
          'integration.services.write',
          'integration.staff.write',
          'integration.appointments.write',
        ],
      })
      .expect(201);
    apiKey = key.body.apiKey;
  }, 120_000);

  afterAll(async () => {
    await cleanupIntegrationTenant(e2e, owner.tenantId).catch(() => undefined);
    await cleanupIntegrationTenant(e2e, other.tenantId).catch(() => undefined);
    await e2e.app.close();
  }, 60_000);

  // ── M2M write: HTTP → API-key guard → admission → pipeline → mapping ──────

  describe('M2M upsert over HTTP', () => {
    it('customer upsert creates the record, the mapping and an audit row', async () => {
      const externalId = `CUST-${randomUUID().slice(0, 8)}`;
      const res = await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId, data: { full_name: 'Sara Ahmed', phone: `+9665${Date.now() % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` } })
        .expect(200);

      expect(res.body.outcome).toBe('created');
      expect(res.body.internalId).toEqual(expect.any(String));

      const map = await e2e.dataSource.getRepository(IntegrationIdMap).findOne({
        where: { tenant: { id: owner.tenantId }, external_id: externalId },
      });
      expect(map?.internal_resource_id).toBe(res.body.internalId);

      const audits = await e2e.dataSource.getRepository(AuditLog).find({
        where: { tenant: { id: owner.tenantId }, action: 'integration.upsert' },
      });
      expect(audits.length).toBeGreaterThan(0);
    });

    it('a repeated upsert of the same external id is idempotent (no duplicate record)', async () => {
      const externalId = `CUST-${randomUUID().slice(0, 8)}`;
      const phone = `+9665${(Date.now() + 1) % 100000000}`;
      const body = { connectionId, externalId, data: { full_name: 'Repeat Test', phone, email: `repeat-${randomUUID().slice(0, 8)}@example.test` } };

      const first = await request(server()).post(`${API}/integrations/customers/upsert`).set('X-API-Key', apiKey).send(body).expect(200);
      const second = await request(server()).post(`${API}/integrations/customers/upsert`).set('X-API-Key', apiKey).send(body).expect(200);

      expect(first.body.internalId).toBe(second.body.internalId);
      expect(second.body.outcome).not.toBe('created');
    });

    it('service upsert works through the same pipeline', async () => {
      const externalId = `SVC-${randomUUID().slice(0, 8)}`;
      const res = await request(server())
        .post(`${API}/integrations/services/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId, data: { name: `Imported ${randomUUID().slice(0, 6)}`, durationMinutes: 45 } })
        .expect(200);
      expect(['created', 'updated', 'linked']).toContain(res.body.outcome);
    });

    it('REJECTS a protected field with 422 rather than silently stripping it', async () => {
      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId: `CUST-${randomUUID().slice(0, 8)}`,
          data: { full_name: 'Mass Assign', phone: '+966500000001', email: `e2e-${randomUUID().slice(0, 8)}@example.test`, tenantId: other.tenantId, payment_status: 'paid' },
        })
        .expect(422);
    });

    it('rejects a request with no API key (401/403)', async () => {
      const res = await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .send({ connectionId, externalId: 'X', data: {} });
      expect([401, 403]).toContain(res.status);
    });

    it('CROSS-TENANT: another tenant cannot write through this connection', async () => {
      const otherKey = await request(server())
        .post(`${API}/platform/api-keys`)
        .set(...authHeader(other.token))
        .send({ name: 'other-key', permissions: ['integration.customers.write'] })
        .expect(201);

      // The connection id belongs to `owner`; resolved tenant-scoped => not found.
      const res = await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', otherKey.body.apiKey)
        .send({ connectionId, externalId: 'CROSS-1', data: { full_name: 'X', phone: '+966500000009', email: `e2e-${randomUUID().slice(0, 8)}@example.test` } });
      expect([404, 422]).toContain(res.status);
    });

    it('idempotency: the same key with a DIFFERENT payload is a 422 mismatch', async () => {
      const key = `idem-${randomUUID()}`;
      const externalId = `CUST-${randomUUID().slice(0, 8)}`;
      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .set('Idempotency-Key', key)
        .send({ connectionId, externalId, data: { full_name: 'Idem A', phone: '+966500000021', email: `e2e-${randomUUID().slice(0, 8)}@example.test` } })
        .expect(200);

      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .set('Idempotency-Key', key)
        .send({ connectionId, externalId, data: { full_name: 'Idem B — different', phone: '+966500000022', email: `e2e-${randomUUID().slice(0, 8)}@example.test` } })
        .expect(422);
    });

    it('idempotency: the same key with the SAME payload replays the stored response', async () => {
      const key = `idem-${randomUUID()}`;
      const body = {
        connectionId,
        externalId: `CUST-${randomUUID().slice(0, 8)}`,
        data: { full_name: 'Replay Me', phone: '+966500000031', email: `e2e-${randomUUID().slice(0, 8)}@example.test` },
      };
      const first = await request(server()).post(`${API}/integrations/customers/upsert`).set('X-API-Key', apiKey).set('Idempotency-Key', key).send(body).expect(200);
      const replay = await request(server()).post(`${API}/integrations/customers/upsert`).set('X-API-Key', apiKey).set('Idempotency-Key', key).send(body).expect(200);
      expect(replay.body).toEqual(first.body);
    });
  });

  // ── Staff: link vs provisioning review ───────────────────────────────────

  describe('staff', () => {
    it('an unmatched external staff member NEVER creates an account — it queues a review', async () => {
      const externalId = `STAFF-${randomUUID().slice(0, 8)}`;
      const res = await request(server())
        .post(`${API}/integrations/staff/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId,
          data: { title: 'Hygienist', matchEmail: `newstaff-${randomUUID().slice(0, 6)}@example.test`, fullName: 'New Staff' },
        })
        .expect(200);

      expect(res.body.outcome).toBe('conflicted');

      // A durable conflict WITH its reason code…
      const conflict = await e2e.dataSource.getRepository(IntegrationConflict).findOne({
        where: { tenant: { id: owner.tenantId }, external_id: externalId },
      });
      expect(conflict?.reason).toBe('staff_requires_account');

      // …and an ACTIONABLE provisioning request.
      const req = await e2e.dataSource.getRepository(IntegrationStaffProvisioning).findOne({
        where: { tenant: { id: owner.tenantId }, external_id: externalId },
      });
      expect(req?.status).toBe('pending');

      // Nothing about an account was created.
      const users = await e2e.dataSource.query(
        `SELECT count(*)::int n FROM users WHERE "tenantId" = $1 AND email LIKE 'newstaff-%'`,
        [owner.tenantId],
      );
      expect(users[0].n).toBe(0);
    });

    it('the provisioning queue is listable over HTTP', async () => {
      const res = await request(server())
        .get(`${API}/platform/integrations/staff-provisioning`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toHaveProperty('status');
      // Never leaks a credential.
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });

    it('REJECTS a staff payload that tries to set roles or access state (422)', async () => {
      await request(server())
        .post(`${API}/integrations/staff/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId: `STAFF-${randomUUID().slice(0, 8)}`, data: { title: 'X', roles: ['owner'], is_active: true } })
        .expect(422);
    });
  });

  // ── Appointments through the lifecycle service ────────────────────────────

  describe('appointments', () => {
    it('fails safely with an unresolvable dependency (nothing partial written)', async () => {
      const before = await e2e.dataSource.query(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [owner.tenantId]);
      const res = await request(server())
        .post(`${API}/integrations/appointments/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId: `APPT-${randomUUID().slice(0, 8)}`,
          data: {
            startAt: new Date(Date.now() + 86_400_000).toISOString(),
            endAt: new Date(Date.now() + 88_200_000).toISOString(),
            customerExternalId: 'NOPE-DOES-NOT-EXIST',
            staffExternalId: 'NOPE-EITHER',
            branchId,
          },
        });
      expect([400, 404, 422]).toContain(res.status);
      const after = await e2e.dataSource.query(`SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1`, [owner.tenantId]);
      expect(after[0].n).toBe(before[0].n);
    });

    it('REJECTS financial/lifecycle fields on an appointment payload (422)', async () => {
      await request(server())
        .post(`${API}/integrations/appointments/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId: `APPT-${randomUUID().slice(0, 8)}`,
          data: { startAt: new Date().toISOString(), status: 'completed', total_amount: 0, payment_status: 'paid' },
        })
        .expect(422);
    });

    /**
     * CREATE → RESCHEDULE → CANCEL through the real lifecycle service. Needs a
     * mapped customer AND a mapped staff member; staff cannot be provisioned by
     * an integration, so the staff fixture is created through the domain flow
     * and then LINKED, which is exactly the supported production path.
     */
    it('creates, reschedules and cancels through the lifecycle service', async () => {
      // A mapped customer.
      const custExternal = `APPT-C-${randomUUID().slice(0, 6)}`;
      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId: custExternal,
          data: {
            full_name: 'Appt Customer',
            phone: `+9665${(Date.now() + 41) % 100000000}`,
            email: `appt-${randomUUID().slice(0, 8)}@example.test`,
          },
        })
        .expect(200);

      // A staff member created through the DOMAIN flow, then linked by email —
      // the integration never creates the account itself.
      const staffEmail = `appt-staff-${randomUUID().slice(0, 8)}@example.test`;
      const staffRes = await request(server())
        .post(`${API}/staff/from-new-user`)
        .set(...authHeader(owner.token))
        .send({
          email: staffEmail,
          fullName: 'Appt Staff',
          title: 'Dentist',
          roleSlug: 'receptionist',
          branchIds: [branchId],
          primaryBranchId: branchId,
        });
      if (staffRes.status >= 400) {
        // Staff provisioning is exercised directly by its own suite; if this
        // fixture route is unavailable the appointment path cannot be proven
        // here, and saying so beats a false pass.
        throw new Error(`staff fixture failed (${staffRes.status}): ${JSON.stringify(staffRes.body)}`);
      }
      const staffExternal = `APPT-S-${randomUUID().slice(0, 6)}`;
      const linked = await request(server())
        .post(`${API}/integrations/staff/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId: staffExternal, data: { title: 'Linked', matchEmail: staffEmail } })
        .expect(200);
      expect(['linked', 'updated', 'skipped']).toContain(linked.body.outcome);

      // CREATE — availability is re-checked inside the lifecycle transaction.
      const apptExternal = `APPT-${randomUUID().slice(0, 8)}`;
      const start = new Date(Date.now() + 3 * 86_400_000);
      start.setUTCHours(10, 0, 0, 0);
      const created = await request(server())
        .post(`${API}/integrations/appointments/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId: apptExternal,
          data: {
            startAt: start.toISOString(),
            endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
            branchId,
            customerExternalId: custExternal,
            staffExternalId: staffExternal,
            serviceIds: [serviceId],
          },
        });
      expect(created.status).toBe(200);
      expect(created.body.outcome).toBe('created');
      const appointmentId: string = created.body.internalId;

      // Attribution is a REAL user (the integration service account), never an
      // API-key principal masquerading as one.
      const row = await e2e.dataSource.query(
        `SELECT "bookedById" FROM appointments WHERE id = $1`,
        [appointmentId],
      );
      expect(row[0].bookedById).toEqual(expect.any(String));
      const acct = await e2e.dataSource.query(
        `SELECT email, is_active, password_hash FROM users WHERE id = $1`,
        [row[0].bookedById],
      );
      expect(acct[0].email).toContain('@service.invalid');
      expect(acct[0].is_active).toBe(false);
      expect(acct[0].password_hash).toBeNull();

      // RESCHEDULE via the read-only `action` hint.
      const moved = new Date(start.getTime() + 2 * 3_600_000);
      const rescheduled = await request(server())
        .post(`${API}/integrations/appointments/upsert`)
        .set('X-API-Key', apiKey)
        .send({
          connectionId,
          externalId: apptExternal,
          data: {
            action: 'reschedule',
            startAt: moved.toISOString(),
            endAt: new Date(moved.getTime() + 30 * 60_000).toISOString(),
            reason: 'Patient request',
          },
        });
      expect(rescheduled.status).toBe(200);
      const after = await e2e.dataSource.query(`SELECT start_at FROM appointments WHERE id = $1`, [appointmentId]);
      expect(new Date(after[0].start_at).getTime()).toBe(moved.getTime());

      // CANCEL — reason only; refunds/amounts stay platform-owned.
      const cancelled = await request(server())
        .post(`${API}/integrations/appointments/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId: apptExternal, data: { action: 'cancel', reason: 'Patient cancelled' } });
      expect(cancelled.status).toBe(200);
      const final = await e2e.dataSource.query(`SELECT status FROM appointments WHERE id = $1`, [appointmentId]);
      expect(String(final[0].status).toLowerCase()).toContain('cancel');
    }, 90_000);
  });

  // ── Async import: HTTP → DB → REAL enqueue → worker → pipeline → history ──

  describe('async import', () => {
    it('enqueues a REAL BullMQ job, the worker drains it, and history is written', async () => {
      const externalId = `IMP-${randomUUID().slice(0, 8)}`;
      const created = await request(server())
        .post(`${API}/platform/integrations/import-jobs/customer`)
        .set(...authHeader(owner.token))
        .send({
          connectionId,
          records: [
            { externalId, data: { full_name: 'Imported One', phone: `+9665${(Date.now() + 7) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` } },
            { externalId: `${externalId}-B`, data: { full_name: 'Imported Two', phone: `+9665${(Date.now() + 8) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` } },
          ],
        })
        .expect(201);

      const jobId: string = created.body.jobId;
      expect(created.body.status).toBe('pending');

      // Phase 0: creation now goes through the transactional outbox (see
      // docs/CACHING_QUEUES_AUDIT.md §0.5 item 4) — the row + its enqueue-intent
      // commit atomically, and OutboxRelayService (not running in this e2e app)
      // is what later turns the PENDING row into a real BullMQ job. So the
      // durable guarantee to check here is the outbox row, not a live job.
      const outboxRow = await e2e.dataSource.getRepository(OutboxJob).findOne({
        where: { dedupe_key: `integration-import-${jobId}` },
      });
      expect(outboxRow).toBeTruthy();
      expect(outboxRow!.status).toBe(OutboxStatus.PENDING);
      expect(outboxRow!.payload).toMatchObject({ tenantId: owner.tenantId, importJobId: jobId });

      // Drain through the same service entry point the processor calls.
      await drain(owner.tenantId, () => importJobs.process(jobId));

      const status = await request(server())
        .get(`${API}/platform/integrations/import-jobs/${jobId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(status.body.status).toBe('completed');
      expect(status.body.progress.processed).toBe(2);

      // Per-item history exists and the mapping was written by the pipeline.
      const items = await request(server())
        .get(`${API}/platform/integrations/import-jobs/${jobId}/items`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(items.body.data.length).toBe(2);

      const map = await e2e.dataSource.getRepository(IntegrationIdMap).findOne({
        where: { tenant: { id: owner.tenantId }, external_id: externalId },
      });
      expect(map).toBeTruthy();
    }, 60_000);

    it('rejects an import into a DEACTIVATED connection', async () => {
      const temp = await request(server())
        .post(`${API}/platform/integrations/connections`)
        .set(...authHeader(owner.token))
        .send({ name: 'Temp', provider: 'custom', authType: 'none' })
        .expect(201);
      await request(server())
        .post(`${API}/platform/integrations/connections/${temp.body.id}/deactivate`)
        .set(...authHeader(owner.token))
        .expect(200);

      await request(server())
        .post(`${API}/platform/integrations/import-jobs/customer`)
        .set(...authHeader(owner.token))
        .send({ connectionId: temp.body.id, records: [{ externalId: 'X', data: { full_name: 'Y', phone: '+966500000099', email: `e2e-${randomUUID().slice(0, 8)}@example.test` } }] })
        .expect(422);
    });

    it('the COMPLETE path: DB transaction -> outbox row -> REAL relay -> real BullMQ job (gap-closure pass, §0.8.1)', async () => {
      const externalId = `IMPRELAY-${randomUUID().slice(0, 8)}`;
      const created = await request(server())
        .post(`${API}/platform/integrations/import-jobs/customer`)
        .set(...authHeader(owner.token))
        .send({
          connectionId,
          records: [{ externalId, data: { full_name: 'Relay Proof', phone: `+9665${(Date.now() + 13) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` } }],
        })
        .expect(201);
      const jobId: string = created.body.jobId;
      const dedupeKey = `integration-import-${jobId}`;

      const pending = await e2e.dataSource.getRepository(OutboxJob).findOne({ where: { dedupe_key: dedupeKey } });
      expect(pending?.status).toBe(OutboxStatus.PENDING);
      // No BullMQ job exists yet — only the outbox row is durable so far.
      expect(await queueService.queue(QUEUE.INTEGRATION_IMPORT).getJob(dedupeKey)).toBeFalsy();

      // The REAL relay claims the row and publishes it — no reimplementation.
      await drainOutboxOnce();

      const published = await e2e.dataSource.getRepository(OutboxJob).findOne({ where: { dedupe_key: dedupeKey } });
      expect(published?.status).toBe(OutboxStatus.PUBLISHED);
      const bullJob = await queueService.queue(QUEUE.INTEGRATION_IMPORT).getJob(dedupeKey);
      expect(bullJob).toBeTruthy();
      expect(bullJob!.data).toMatchObject({ tenantId: owner.tenantId, importJobId: jobId });

      // The worker leg (same entry point the real processor calls) completes the loop.
      await drain(owner.tenantId, () => importJobs.process(jobId), JOB.INTEGRATION_IMPORT);
      const status = await request(server())
        .get(`${API}/platform/integrations/import-jobs/${jobId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(status.body.status).toBe('completed');
    }, 60_000);
  });

  // ── Sync: cursor progression + duplicate-active rejection ─────────────────

  describe('sync', () => {
    it('starts a run, records cursor fields, and REJECTS a duplicate active run (DB index)', async () => {
      const first = await request(server())
        .post(`${API}/platform/integrations/sync`)
        .set(...authHeader(owner.token))
        .send({ connectionId, resourceType: 'customer', direction: 'inbound', mode: 'incremental' })
        .expect(200);

      expect(first.body).toHaveProperty('attemptedCursor');
      expect(first.body).toHaveProperty('lastSuccessfulCursor');
      expect(first.body).toHaveProperty('nextCursor');
      expect(first.body.cursorKind).toBe('opaque');

      // Second run for the same tuple is refused by the partial unique index.
      await request(server())
        .post(`${API}/platform/integrations/sync`)
        .set(...authHeader(owner.token))
        .send({ connectionId, resourceType: 'customer', direction: 'inbound', mode: 'incremental' })
        .expect(409);

      await drain(owner.tenantId, () => syncs.process(first.body.id));

      const status = await request(server())
        .get(`${API}/platform/integrations/sync/${first.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(['completed', 'partially_completed']).toContain(status.body.status);
      expect(status.body.stopReason).toBeTruthy();
      expect(status.body.pagesFetched).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it('the COMPLETE path: DB transaction -> outbox row -> REAL relay -> real BullMQ job (gap-closure pass, §0.8.1)', async () => {
      // A different resource/direction tuple than the test above, so this run
      // doesn't collide with its still-active-until-drained partial unique index.
      const started = await request(server())
        .post(`${API}/platform/integrations/sync`)
        .set(...authHeader(owner.token))
        .send({ connectionId, resourceType: 'service', direction: 'inbound', mode: 'incremental' })
        .expect(200);
      const syncJobId: string = started.body.id;
      const dedupeKey = `integration-sync-${syncJobId}`;

      const pending = await e2e.dataSource.getRepository(OutboxJob).findOne({ where: { dedupe_key: dedupeKey } });
      expect(pending?.status).toBe(OutboxStatus.PENDING);
      expect(await queueService.queue(QUEUE.INTEGRATION_SYNC).getJob(dedupeKey)).toBeFalsy();

      await drainOutboxOnce();

      const published = await e2e.dataSource.getRepository(OutboxJob).findOne({ where: { dedupe_key: dedupeKey } });
      expect(published?.status).toBe(OutboxStatus.PUBLISHED);
      const bullJob = await queueService.queue(QUEUE.INTEGRATION_SYNC).getJob(dedupeKey);
      expect(bullJob).toBeTruthy();
      expect(bullJob!.data).toMatchObject({ tenantId: owner.tenantId, syncJobId });

      await drain(owner.tenantId, () => syncs.process(syncJobId), JOB.INTEGRATION_SYNC);
      const status = await request(server())
        .get(`${API}/platform/integrations/sync/${syncJobId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(['completed', 'partially_completed']).toContain(status.body.status);
    }, 60_000);
  });

  // ── Inbound webhooks: the full signed path ────────────────────────────────

  describe('inbound webhooks', () => {
    let endpointId: string;
    let secret: string;

    beforeAll(async () => {
      const res = await request(server())
        .post(`${API}/platform/integrations/webhooks/endpoints`)
        .set(...authHeader(owner.token))
        .send({ connectionId, allowedEvents: ['customer.upserted'] })
        .expect(201);
      endpointId = res.body.id;
      secret = res.body.secret;
      // Show-once secret, and only a prefix afterwards.
      expect(secret).toEqual(expect.any(String));
      expect(res.body.secretPrefix).toBe(secret.slice(0, 12));
    });

    it('never returns the secret again after creation', async () => {
      const res = await request(server())
        .get(`${API}/platform/integrations/webhooks/endpoints/${endpointId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.secret).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(secret);
    });

    it('ACCEPTS a correctly signed delivery, persists it, and enqueues a real job', async () => {
      const eventId = `evt-${randomUUID()}`;
      const externalId = `WH-${randomUUID().slice(0, 8)}`;
      const body = JSON.stringify({
        externalId,
        data: { full_name: 'Webhook Customer', phone: `+9665${(Date.now() + 11) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` },
      });
      const ts = nowSeconds();

      const res = await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', ts)
        .set('X-Ziyarati-Event-Id', eventId)
        .set('X-Ziyarati-Event', 'customer.upserted')
        .set('X-Ziyarati-Signature', signInbound(secret, ts, body))
        .send(body)
        .expect(202);

      expect(res.body).toMatchObject({ received: true, status: 'accepted' });

      const row = await e2e.dataSource.getRepository(IntegrationInboundEvent).findOne({
        where: { tenant: { id: owner.tenantId }, provider_event_id: eventId },
      });
      expect(row?.status).toBe('accepted');

      // Durable BEFORE the ack, with its enqueue-intent committed in the SAME
      // transaction (Phase 0 — see docs/CACHING_QUEUES_AUDIT.md §0.5 item 4).
      // The outbox row is the durable guarantee; OutboxRelayService (not
      // running in this e2e app) is what later turns it into a real BullMQ job.
      const outboxRow = await e2e.dataSource.getRepository(OutboxJob).findOne({
        where: { dedupe_key: `integration-inbound-${row!.id}` },
      });
      expect(outboxRow).toBeTruthy();
      expect(outboxRow!.status).toBe(OutboxStatus.PENDING);
      expect(outboxRow!.payload).toMatchObject({ tenantId: owner.tenantId, inboundEventId: row!.id });

      // Worker leg → shared pipeline → mapping.
      await drain(owner.tenantId, () => inbound.process(row!.id));

      const processed = await e2e.dataSource.getRepository(IntegrationInboundEvent).findOne({ where: { id: row!.id } });
      expect(['processed', 'conflicted']).toContain(processed!.status);
      // The staging payload is dropped once terminal — history keeps metadata only.
      expect(processed!.payload).toBeNull();

      const map = await e2e.dataSource.getRepository(IntegrationIdMap).findOne({
        where: { tenant: { id: owner.tenantId }, external_id: externalId },
      });
      expect(map).toBeTruthy();
    }, 60_000);

    it('the COMPLETE path: DB transaction -> outbox row -> REAL relay -> real BullMQ job (gap-closure pass, §0.8.1)', async () => {
      const eventId = `evt-relay-${randomUUID()}`;
      const externalId = `WHRELAY-${randomUUID().slice(0, 8)}`;
      const body = JSON.stringify({
        externalId,
        data: { full_name: 'Relay Proof Customer', phone: `+9665${(Date.now() + 17) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` },
      });
      const ts = nowSeconds();

      const res = await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', ts)
        .set('X-Ziyarati-Event-Id', eventId)
        .set('X-Ziyarati-Event', 'customer.upserted')
        .set('X-Ziyarati-Signature', signInbound(secret, ts, body))
        .send(body)
        .expect(202);
      expect(res.body).toMatchObject({ received: true, status: 'accepted' });

      const row = await e2e.dataSource.getRepository(IntegrationInboundEvent).findOne({
        where: { tenant: { id: owner.tenantId }, provider_event_id: eventId },
      });
      const dedupeKey = `integration-inbound-${row!.id}`;

      const pending = await e2e.dataSource.getRepository(OutboxJob).findOne({ where: { dedupe_key: dedupeKey } });
      expect(pending?.status).toBe(OutboxStatus.PENDING);
      expect(await queueService.queue(QUEUE.INTEGRATION_INBOUND).getJob(dedupeKey)).toBeFalsy();

      // The REAL relay claims + publishes — no reimplementation of its logic.
      await drainOutboxOnce();

      const published = await e2e.dataSource.getRepository(OutboxJob).findOne({ where: { dedupe_key: dedupeKey } });
      expect(published?.status).toBe(OutboxStatus.PUBLISHED);
      const bullJob = await queueService.queue(QUEUE.INTEGRATION_INBOUND).getJob(dedupeKey);
      expect(bullJob).toBeTruthy();
      expect(bullJob!.data).toMatchObject({ tenantId: owner.tenantId, inboundEventId: row!.id });

      await drain(owner.tenantId, () => inbound.process(row!.id), JOB.INTEGRATION_INBOUND);
      const processed = await e2e.dataSource.getRepository(IntegrationInboundEvent).findOne({ where: { id: row!.id } });
      expect(['processed', 'conflicted']).toContain(processed!.status);
    }, 60_000);

    it('REJECTS an invalid signature (403) and writes no history row', async () => {
      const eventId = `evt-${randomUUID()}`;
      const body = JSON.stringify({ externalId: 'X', data: {} });
      await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', nowSeconds())
        .set('X-Ziyarati-Event-Id', eventId)
        .set('X-Ziyarati-Event', 'customer.upserted')
        .set('X-Ziyarati-Signature', 'sha256=' + 'f'.repeat(64))
        .send(body)
        .expect(403);

      // An UNAUTHENTICATED caller must not be able to write rows to a tenant table.
      const row = await e2e.dataSource.getRepository(IntegrationInboundEvent).findOne({
        where: { tenant: { id: owner.tenantId }, provider_event_id: eventId },
      });
      expect(row).toBeNull();
    });

    it('REJECTS a stale timestamp even with an otherwise valid signature (403)', async () => {
      const body = JSON.stringify({ externalId: 'X', data: {} });
      const stale = String(Math.floor(Date.now() / 1000) - 7200);
      await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', stale)
        .set('X-Ziyarati-Event-Id', `evt-${randomUUID()}`)
        .set('X-Ziyarati-Event', 'customer.upserted')
        .set('X-Ziyarati-Signature', signInbound(secret, stale, body))
        .send(body)
        .expect(403);
    });

    it('a DUPLICATE delivery of the same event id is acked 200 and not processed twice', async () => {
      const eventId = `evt-${randomUUID()}`;
      const body = JSON.stringify({
        externalId: `WH-${randomUUID().slice(0, 8)}`,
        data: { full_name: 'Dup', phone: `+9665${(Date.now() + 13) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` },
      });
      const ts = nowSeconds();
      const headers = {
        'X-Ziyarati-Timestamp': ts,
        'X-Ziyarati-Event-Id': eventId,
        'X-Ziyarati-Event': 'customer.upserted',
        'X-Ziyarati-Signature': signInbound(secret, ts, body),
      };

      await request(server()).post(`${API}/integrations/inbound/${connectionId}`).set('Content-Type', 'application/json').set(headers).send(body).expect(202);
      const dup = await request(server()).post(`${API}/integrations/inbound/${connectionId}`).set('Content-Type', 'application/json').set(headers).send(body).expect(200);
      expect(dup.body.status).toBe('duplicate');

      const rows = await e2e.dataSource.getRepository(IntegrationInboundEvent).find({
        where: { tenant: { id: owner.tenantId }, provider_event_id: eventId },
      });
      expect(rows.length).toBe(1); // the DB unique index is the replay guard
    });

    it('REJECTS an event type outside the endpoint allowlist (422, recorded)', async () => {
      const eventId = `evt-${randomUUID()}`;
      const body = JSON.stringify({ externalId: 'X', data: {} });
      const ts = nowSeconds();
      await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', ts)
        .set('X-Ziyarati-Event-Id', eventId)
        .set('X-Ziyarati-Event', 'appointment.cancelled') // not allowlisted here
        .set('X-Ziyarati-Signature', signInbound(secret, ts, body))
        .send(body)
        .expect(422);

      // AUTHENTICATED rejections ARE recorded — the partner can act on them.
      const row = await e2e.dataSource.getRepository(IntegrationInboundEvent).findOne({
        where: { tenant: { id: owner.tenantId }, provider_event_id: eventId },
      });
      expect(row?.status).toBe('rejected');
      expect(row?.rejection_reason).toBe('event_not_allowed');
      expect(row?.payload).toBeNull();
    });

    it('REJECTS an unknown event type entirely', async () => {
      const body = JSON.stringify({ externalId: 'X', data: {} });
      const ts = nowSeconds();
      await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', ts)
        .set('X-Ziyarati-Event-Id', `evt-${randomUUID()}`)
        .set('X-Ziyarati-Event', 'totally.made.up')
        .set('X-Ziyarati-Signature', signInbound(secret, ts, body))
        .send(body)
        .expect(422);
    });

    it('404s for a connection with no configured endpoint', async () => {
      await request(server())
        .post(`${API}/integrations/inbound/${randomUUID()}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Signature', 'sha256=abc')
        .send('{}')
        .expect(404);
    });

    it('delivery history exposes safe metadata and never a payload', async () => {
      const res = await request(server())
        .get(`${API}/platform/integrations/webhooks/events`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const row of res.body.data) {
        expect(row).toHaveProperty('status');
        expect(row).not.toHaveProperty('payload');
      }
    });

    it('rotating the secret invalidates deliveries signed with the old one', async () => {
      const rotated = await request(server())
        .post(`${API}/platform/integrations/webhooks/endpoints/${endpointId}/rotate-secret`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(rotated.body.secret).not.toBe(secret);

      const body = JSON.stringify({ externalId: 'X', data: {} });
      const ts = nowSeconds();
      await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', ts)
        .set('X-Ziyarati-Event-Id', `evt-${randomUUID()}`)
        .set('X-Ziyarati-Event', 'customer.upserted')
        .set('X-Ziyarati-Signature', signInbound(secret, ts, body)) // OLD secret
        .send(body)
        .expect(403);
      secret = rotated.body.secret;
    });

    it('an INACTIVE endpoint rejects deliveries', async () => {
      await request(server())
        .patch(`${API}/platform/integrations/webhooks/endpoints/${endpointId}`)
        .set(...authHeader(owner.token))
        .send({ active: false })
        .expect(200);

      const body = JSON.stringify({ externalId: 'X', data: {} });
      const ts = nowSeconds();
      await request(server())
        .post(`${API}/integrations/inbound/${connectionId}`)
        .set('Content-Type', 'application/json')
        .set('X-Ziyarati-Timestamp', ts)
        .set('X-Ziyarati-Event-Id', `evt-${randomUUID()}`)
        .set('X-Ziyarati-Event', 'customer.upserted')
        .set('X-Ziyarati-Signature', signInbound(secret, ts, body))
        .send(body)
        .expect(422);

      await request(server())
        .patch(`${API}/platform/integrations/webhooks/endpoints/${endpointId}`)
        .set(...authHeader(owner.token))
        .send({ active: true })
        .expect(200);
    });
  });

  // ── Mapping lifecycle ─────────────────────────────────────────────────────

  describe('mapping lifecycle', () => {
    it('unlink keeps the row as history and frees both sides; relink restores it', async () => {
      const externalId = `MAP-${randomUUID().slice(0, 8)}`;
      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId, data: { full_name: 'Mappable', phone: `+9665${(Date.now() + 17) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` } })
        .expect(200);

      const list = await request(server())
        .get(`${API}/platform/integrations/mappings?externalId=${externalId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      const mappingId = list.body.data[0].id;
      expect(list.body.data[0].active).toBe(true);

      await request(server())
        .post(`${API}/platform/integrations/mappings/${mappingId}/unlink`)
        .set(...authHeader(owner.token))
        .expect(200);

      // Gone from the ACTIVE view…
      const activeOnly = await request(server())
        .get(`${API}/platform/integrations/mappings?externalId=${externalId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(activeOnly.body.total).toBe(0);

      // …but retained as history.
      const history = await request(server())
        .get(`${API}/platform/integrations/mappings?externalId=${externalId}&scope=unlinked`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(history.body.total).toBe(1);
      expect(history.body.data[0].unlinkReason).toBe('manual');

      await request(server())
        .post(`${API}/platform/integrations/mappings/${mappingId}/relink`)
        .set(...authHeader(owner.token))
        .send({})
        .expect(200);

      const relinked = await request(server())
        .get(`${API}/platform/integrations/mappings?externalId=${externalId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(relinked.body.total).toBe(1);
    });

    it('search matches either side of the mapping', async () => {
      const res = await request(server())
        .get(`${API}/platform/integrations/mappings?search=MAP-&scope=all`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.total).toBeGreaterThan(0);
    });
  });

  // ── Disconnect / reconnect preserves history ─────────────────────────────

  describe('disconnect and reconnect', () => {
    it('disconnect preserves mappings and history; reconnect restores the connection', async () => {
      const temp = await request(server())
        .post(`${API}/platform/integrations/connections`)
        .set(...authHeader(owner.token))
        .send({ name: 'Reconnectable', provider: 'generic_rest', authType: 'api_key', credential: 'secret-1', config: { baseUrl: 'https://api.example.com', apiKey: { location: 'header', name: 'X-Api-Key' } } })
        .expect(201);
      const tempId = temp.body.id;

      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId: tempId, externalId: `RC-${randomUUID().slice(0, 8)}`, data: { full_name: 'Survivor', phone: `+9665${(Date.now() + 23) % 100000000}`, email: `e2e-${randomUUID().slice(0, 8)}@example.test` } })
        .expect(200);

      const before = await e2e.dataSource.getRepository(IntegrationIdMap).count({
        where: { tenant: { id: owner.tenantId }, connection: { id: tempId } },
      });
      expect(before).toBe(1);

      await request(server())
        .post(`${API}/platform/integrations/connections/${tempId}/disconnect`)
        .set(...authHeader(owner.token))
        .expect(200);

      // MAPPINGS SURVIVE an ordinary disconnect.
      const after = await e2e.dataSource.getRepository(IntegrationIdMap).count({
        where: { tenant: { id: owner.tenantId }, connection: { id: tempId } },
      });
      expect(after).toBe(1);

      // A disconnected connection cannot be written through.
      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId: tempId, externalId: 'RC-2', data: { full_name: 'Nope', phone: '+966500000044', email: `e2e-${randomUUID().slice(0, 8)}@example.test` } })
        .expect(422);

      // Reconnect requires the credential again (disconnect destroyed it).
      const noCredential = await request(server())
        .post(`${API}/platform/integrations/connections/${tempId}/reconnect`)
        .set(...authHeader(owner.token))
        .send({});
      expect([400, 422]).toContain(noCredential.status);

      const reconnected = await request(server())
        .post(`${API}/platform/integrations/connections/${tempId}/reconnect`)
        .set(...authHeader(owner.token))
        .send({ credential: 'secret-2' })
        .expect(200);
      expect(reconnected.body.reconnected).toBe(true);
      expect(reconnected.body.mappings.activeMappings).toBe(1);
    });

    it('hard delete is refused while the connection is still active, and shows its impact', async () => {
      const impact = await request(server())
        .get(`${API}/platform/integrations/connections/${connectionId}/purge-impact`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(impact.body.eligible).toBe(false);
      expect(impact.body.retains).toEqual(expect.arrayContaining(['audit log']));

      await request(server())
        .delete(`${API}/platform/integrations/connections/${connectionId}/purge`)
        .set(...authHeader(owner.token))
        .expect(422);
    });
  });

  // ── Conflicts ─────────────────────────────────────────────────────────────

  describe('conflicts', () => {
    it('a reject_and_report connection persists a conflict, and resolution is atomic', async () => {
      const strict = await request(server())
        .post(`${API}/platform/integrations/connections`)
        .set(...authHeader(owner.token))
        .send({ name: 'Strict', provider: 'generic_rest', authType: 'none', defaultConflictPolicy: 'reject_and_report', config: { baseUrl: 'https://api.example.com' } })
        .expect(201);

      const externalId = `CF-${randomUUID().slice(0, 8)}`;
      const phone = `+9665${(Date.now() + 29) % 100000000}`;
      const conflictEmail = `conflict-${randomUUID().slice(0, 8)}@example.test`;
      await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId: strict.body.id, externalId, data: { full_name: 'Original Name', phone, email: conflictEmail } })
        .expect(200);

      // A diverging value under reject_and_report → conflicted, not applied.
      const diverge = await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId: strict.body.id, externalId, data: { full_name: 'Changed Externally', phone, email: conflictEmail } })
        .expect(200);
      expect(diverge.body.outcome).toBe('conflicted');

      const list = await request(server())
        .get(`${API}/platform/integrations/conflicts?connectionId=${strict.body.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      const conflict = list.body.data[0];
      expect(conflict.status).toBe('pending');
      expect(conflict.isStale).toBe(false);
      // Safe comparison only — field NAMES and hashes, never values.
      expect(conflict.conflictingFields).toContain('full_name');
      expect(JSON.stringify(conflict)).not.toContain('Changed Externally');

      // Resolve once…
      await request(server())
        .post(`${API}/platform/integrations/conflicts/${conflict.id}/resolve`)
        .set(...authHeader(owner.token))
        .send({ resolution: 'platform_wins' })
        .expect(200);

      // …and a duplicate submit cannot resolve it again.
      await request(server())
        .post(`${API}/platform/integrations/conflicts/${conflict.id}/resolve`)
        .set(...authHeader(owner.token))
        .send({ resolution: 'platform_wins' })
        .expect(422);

      const audits = await e2e.dataSource.getRepository(AuditLog).find({
        where: { tenant: { id: owner.tenantId }, action: 'integration.conflict.resolve' },
      });
      expect(audits.length).toBeGreaterThan(0);
    }, 60_000);
  });

  // ── OAuth: disabled without a configured provider ────────────────────────

  describe('OAuth', () => {
    it('reports the feature disabled when no provider is configured', async () => {
      const res = await request(server())
        .get(`${API}/platform/integrations/oauth/providers`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('providers');
      if (!res.body.enabled) expect(res.body.providers).toEqual([]);
    });

    it('refuses to start a handshake for a provider with no OAuth adapter', async () => {
      await request(server())
        .post(`${API}/platform/integrations/oauth/${connectionId}/authorize`)
        .set(...authHeader(owner.token))
        .expect(422);
    });

    it('token status never exposes a token value', async () => {
      const res = await request(server())
        .get(`${API}/platform/integrations/oauth/${connectionId}/status`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body).toMatchObject({ connectionId, connected: false });
      expect(JSON.stringify(res.body)).not.toMatch(/ciphertext|access_token/i);
    });
  });

  // ── Admission control ─────────────────────────────────────────────────────

  describe('admission control', () => {
    it('rejects an over-sized upsert payload before any persistence', async () => {
      const huge = 'x'.repeat(300 * 1024);
      const res = await request(server())
        .post(`${API}/integrations/customers/upsert`)
        .set('X-API-Key', apiKey)
        .send({ connectionId, externalId: 'BIG-1', data: { full_name: huge, phone: '+966500000055', email: `e2e-${randomUUID().slice(0, 8)}@example.test` } });
      expect([400, 413, 422]).toContain(res.status);
    });

    it('caps concurrent import jobs per tenant', async () => {
      const ids: string[] = [];
      let capped = false;
      for (let i = 0; i < 6; i += 1) {
        const res = await request(server())
          .post(`${API}/platform/integrations/import-jobs/customer`)
          .set(...authHeader(owner.token))
          .send({ connectionId, records: [{ externalId: `CAP-${i}-${randomUUID().slice(0, 6)}`, data: { full_name: `Cap ${i}`, phone: `+96650000${1000 + i}` } }] });
        if (res.status === 429) {
          capped = true;
          break;
        }
        if (res.status === 201) ids.push(res.body.jobId);
      }
      expect(capped).toBe(true);
      // Drain so later tests are not blocked by the cap.
      for (const id of ids) await drain(owner.tenantId, () => importJobs.process(id));
    }, 90_000);
  });
});
