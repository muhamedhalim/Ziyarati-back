/**
 * The Definition of Done, as an executable test.
 *
 * An ANONYMOUS visitor walks the full cycle — city → clinic → branch → service
 * → doctor → slot → patient details → insurance → booking — through the REAL
 * tool dispatcher against real Postgres, and a real appointment lands in the
 * selected clinic with correct tenant and branch isolation.
 *
 * The visitor holds a guest token scoped to the shared `__guest_discovery__`
 * tenant and has ZERO roles and ZERO permissions for the whole run. Nothing
 * here grants them any; the write executes as the selected clinic's own
 * least-privilege `ai-bot` actor, and the clinic tenant is derived server-side
 * from the branch they picked — never from an argument.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import {
  createE2eApp,
  cleanupTenant,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  AiToolDispatchService,
  type ToolContext,
} from '../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../src/modules/ai/tools/ai-tools.constants';
import { AI_PUBLIC_TOOL } from '../src/modules/ai/tools/ai-public-booking-tools.constants';
import { AiConversationService } from '../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../src/modules/ai-orchestrator/conversation-session.service';
import { GuestSessionService } from '../src/modules/guest-chat/guest-session.service';
import { FreeAccessOverrideService } from '../src/modules/subscription-billing/free-access-override.service';
import { AppointmentsService } from '../src/modules/appointment/appointment.service';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { City } from '../src/entities/System&Lookup/City';
import { Service } from '../src/entities/Services/Service';
import { ServicePrice } from '../src/entities/Services/ServicePrice';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { User } from '../src/entities/Auth&RBAC/User';
import {
  TenantApprovalStatus,
  AppointmentSource,
  AppointmentStatus,
  AppointmentPaymentStatus,
} from '../src/entities/enums';
import { PERMISSION } from '../src/rbac/rbac.constants';
import type { AuthenticatedUser } from '../src/modules/auth/interfaces/authenticated-user.interface';

const SUITE = `pbf-${randomUUID().slice(0, 8)}`;

/**
 * Phone-safe suffix. The public-booking DTO enforces the shared phone rule (CRM-PHONE-01: digits only after
 * the optional +), so a slice of the hex suite id (which carries a-f) was refused with 400 in most runs.
 * Digits only, padded so there are always enough.
 */
const phoneTail = (n: number): string =>
  randomUUID().replace(/\D/g, '').padEnd(n, '0').slice(0, n);
const SUITE_PHONE_TAIL = phoneTail(7);
const HTTP_PHONE_TAIL = phoneTail(7);

/** 15:00 Asia/Riyadh, comfortably inside the 08:00–20:00 schedule below. */
const SLOT_START = '2027-03-15T12:00:00.000Z';

interface Clinic {
  tenantId: string;
  branchId: string;
  serviceId: string;
  staffId: string;
  cityId: string;
}

describe('Public AI booking — full anonymous cycle, real Postgres', () => {
  let e2e: E2eApp;
  let tools: AiToolDispatchService;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let appointments: AppointmentsService;

  let discoveryTenantId: string;
  let guest: AuthenticatedUser;
  let ctx: ToolContext;
  let clinic: Clinic;
  let otherClinic: Clinic;
  let cityId: string;

  const tenantIds: string[] = [];
  const convIds: string[] = [];

  /** Calls a tool exactly as the model would — through the real dispatcher. */
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools.execute(ctx, {
      id: randomUUID(),
      name,
      arguments: JSON.stringify(args),
    });

  async function makeClinic(label: string, city: string): Promise<Clinic> {
    const ds = e2e.dataSource;

    const tenant = await ds.getRepository(Tenant).save(
      ds.getRepository(Tenant).create({
        name: `E2E ${label} ${SUITE}`,
        slug: `e2e-${label}-${SUITE}`,
        contact_email: `${label}-${SUITE}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    tenantIds.push(tenant.id);

    // Unmetered, so the booking is not blocked by plan quotas in the test.
    await e2e.app.get(FreeAccessOverrideService).grant(tenant.id, {
      reason: `e2e ${SUITE}`,
      durationDays: null,
    });

    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: tenant.id } as Tenant,
        public_booking_enabled: true,
        payment_required: false, // keep the happy path off the payment gateway
      }),
    );

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Main`,
        address: `1 ${label} Street`,
        city_id: city,
        is_active: true,
        timezone: 'Asia/Riyadh',
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Consultation`,
        // NOT NULL, unique per tenant (ServiceService assigns it in production).
        public_slug: `consultation-${randomUUID().slice(0, 8)}`,
        duration_minutes: 30,
        base_price: 100,
        is_active: true,
      }),
    );
    // Branch-specific price — proves the booking is priced from service_prices.
    await ds.getRepository(ServicePrice).save(
      ds.getRepository(ServicePrice).create({
        tenant: { id: tenant.id } as Tenant,
        service: { id: service.id } as Service,
        branch: { id: branch.id } as Branch,
        price: 250,
        is_active: true,
      }),
    );

    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenant.id } as Tenant,
        email: `doctor-${label}-${SUITE}@example.test`,
        full_name: `Dr ${label}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: tenant.id } as Tenant,
        user: { id: user.id } as User,
        // `staff_profiles.public_slug` is NOT NULL + globally unique (StaffService
        // assigns it in production); a fixture inserting the row directly must too.
        public_slug: `dr-${randomUUID().slice(0, 12)}`,
        title: 'Consultant',
        is_available_for_booking: true,
      }),
    );
    // Working hours at THIS branch — the link that makes the doctor bookable here.
    for (let day = 0; day < 7; day += 1) {
      await ds.getRepository(StaffSchedule).save(
        ds.getRepository(StaffSchedule).create({
          tenant: { id: tenant.id } as Tenant,
          staff: { id: staff.id } as StaffProfile,
          branch: { id: branch.id } as Branch,
          day_of_week: day,
          start_time: '08:00:00',
          end_time: '20:00:00',
          is_active: true,
        }),
      );
    }

    return {
      tenantId: tenant.id,
      branchId: branch.id,
      serviceId: service.id,
      staffId: staff.id,
      cityId: city,
    };
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    tools = e2e.app.get(AiToolDispatchService);
    conversations = e2e.app.get(AiConversationService);
    sessions = e2e.app.get(ConversationSessionService);
    appointments = e2e.app.get(AppointmentsService);

    const city = await e2e.dataSource.getRepository(City).save(
      e2e.dataSource.getRepository(City).create({
        name_en: `Testville ${SUITE}`,
        name_ar: `مدينة ${SUITE}`,
      }),
    );
    cityId = city.id;

    clinic = await makeClinic('alpha', cityId);
    otherClinic = await makeClinic('beta', cityId);

    discoveryTenantId = await e2e.app
      .get(GuestSessionService)
      .ensureDiscoveryTenant();
    guest = {
      id: randomUUID(),
      tenantId: discoveryTenantId,
      email: null,
      roles: [],
      permissions: [],
      guest: true,
    };

    const conv = await conversations.start(discoveryTenantId, {});
    convIds.push(conv.id);
    await sessions.patch(discoveryTenantId, conv.id, {
      guestSubject: guest.id,
    });

    ctx = {
      tenantId: discoveryTenantId, // the CONVERSATION tenant — never the booking tenant
      aiConversationId: conv.id,
      permissions: [], // the visitor holds none, throughout
      principal: guest,
    };
  }, 120_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) =>
      e2e.dataSource.query(sql, p).catch(() => undefined);
    await q(`DELETE FROM ai_messages WHERE ai_conversation_id = ANY($1)`, [
      convIds,
    ]);
    await q(`DELETE FROM ai_conversations WHERE id = ANY($1)`, [convIds]);
    for (const tenantId of tenantIds) {
      await q(`DELETE FROM ai_tool_calls WHERE tenant_id = $1`, [tenantId]);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM payment_links WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM service_prices WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM services WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
      await q(`DELETE FROM subscription_usage WHERE tenant_id = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM free_access_overrides WHERE tenant_id = $1`, [
        tenantId,
      ]);
      // Role provisioning writes an audit row that FKs the tenant.
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [tenantId]);
      await q(
        `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
        [tenantId],
      );
      await q(
        `DELETE FROM user_roles WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
        [tenantId],
      );
      await q(`DELETE FROM roles WHERE "tenantId" = $1`, [tenantId]);
      await cleanupTenant(e2e, tenantId);
    }
    await q(`DELETE FROM cities WHERE id = $1`, [cityId]);
    await e2e.app.close();
  }, 120_000);

  it('walks the whole cycle and persists a real appointment in the selected clinic', async () => {
    // 1. City
    const cities = (await call(AI_PUBLIC_TOOL.LIST_CITIES)) as any;
    expect(cities.success).toBe(true);
    expect(cities.cities.map((c: any) => c.id)).toContain(cityId);

    // 2. Clinic discovery, narrowed to that city
    const found = (await call(AI_TOOL.SEARCH_CLINICS, { query: SUITE })) as any;
    expect(found.success).not.toBe(false);

    // 3. Clinic selection — one branch, so it is auto-selected
    const selectedClinic = (await call(AI_PUBLIC_TOOL.SELECT_CLINIC, {
      clinicId: clinic.tenantId,
    })) as any;
    expect(selectedClinic.success).toBe(true);
    expect(selectedClinic.branchAutoSelected).toBe(true);
    expect(selectedClinic.selectedBranch.id).toBe(clinic.branchId);
    // Branch location is exposed, so the visitor can tell branches apart.
    expect(selectedClinic.branches[0]).toMatchObject({
      address: expect.any(String),
      city: expect.objectContaining({ id: cityId }),
    });

    // 4. Branch-scoped service list, at the BRANCH price
    const services = (await call(AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES)) as any;
    expect(services.success).toBe(true);
    expect(services.services).toEqual([
      expect.objectContaining({ id: clinic.serviceId, price: 250 }),
    ]);

    // 5. Branch-scoped doctor list
    const doctors = (await call(AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS)) as any;
    expect(doctors.success).toBe(true);
    expect(doctors.doctors).toEqual([
      expect.objectContaining({ id: clinic.staffId }),
    ]);

    // 6. Selections
    expect(
      (await call(AI_PUBLIC_TOOL.SELECT_SERVICE, {
        serviceIds: [clinic.serviceId],
      })) as any,
    ).toMatchObject({ success: true });
    expect(
      (await call(AI_PUBLIC_TOOL.SELECT_DOCTOR, {
        staffId: clinic.staffId,
      })) as any,
    ).toMatchObject({ success: true });

    // 7. Real availability, then a slot
    const windows = (await call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, {
      branchId: clinic.branchId,
      staffId: clinic.staffId,
      date: '2027-03-15',
    })) as any;
    expect(windows.success).not.toBe(false);

    expect(
      (await call(AI_PUBLIC_TOOL.SELECT_SLOT, { startAt: SLOT_START })) as any,
    ).toMatchObject({ success: true });

    // 8. Patient details + insurance → booking
    const booked = (await call(AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, {
      fullName: 'Anonymous Patient',
      phone: `+96650${SUITE_PHONE_TAIL}`,
      hasInsurance: false,
      notes: 'Booked by the public AI assistant',
    })) as any;

    // Assert on `error` first, so a failure reports WHY rather than just `false`.
    expect(booked.error).toBeUndefined();
    expect(booked).toMatchObject({
      success: true,
      appointmentId: expect.any(String),
    });

    // The appointment is real, and it belongs to the SELECTED clinic + branch.
    const row = await e2e.dataSource.query(
      `SELECT "tenantId", "branchId", "staffId", source, status, payment_status, total_amount
         FROM appointments WHERE id = $1`,
      [booked.appointmentId],
    );
    expect(row[0]).toMatchObject({
      tenantId: clinic.tenantId,
      branchId: clinic.branchId,
      staffId: clinic.staffId,
      source: AppointmentSource.PUBLIC_AI,
      // payment_required = false for this clinic → nothing to collect online.
      status: AppointmentStatus.CONFIRMED,
      payment_status: AppointmentPaymentStatus.UNPAID,
    });
    // Priced from service_prices (250), not the clinic-wide base_price (100).
    expect(Number(row[0].total_amount)).toBe(250);

    // …and never in the conversation's own (guest discovery) tenant.
    expect(row[0].tenantId).not.toBe(discoveryTenantId);
  }, 120_000);

  it('is visible to the selected clinic and invisible to every other clinic', async () => {
    const list = await appointments.findAll(
      clinic.tenantId,
      { page: 1, limit: 20 } as never,
      { id: 'staff-x', permissions: [PERMISSION.APPOINTMENTS_READ] },
    );
    expect(list.total).toBeGreaterThan(0);
    const appointmentId = list.data[0].id;

    // The other clinic cannot retrieve it — tenant-scoped, uniform 404.
    await expect(
      appointments.findOne(otherClinic.tenantId, appointmentId, {
        id: 'staff-y',
        permissions: [PERMISSION.APPOINTMENTS_READ],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      appointments.findAll(
        otherClinic.tenantId,
        { page: 1, limit: 20 } as never,
        { id: 'staff-y', permissions: [PERMISSION.APPOINTMENTS_READ] },
      ),
    ).resolves.toMatchObject({ total: 0 });
  });

  it('books at most once when the same intent is retried (idempotent)', async () => {
    const before = await e2e.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM appointments WHERE "tenantId" = $1`,
      [clinic.tenantId],
    );

    const retry = (await call(AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, {
      fullName: 'Anonymous Patient',
      phone: `+96650${SUITE_PHONE_TAIL}`,
      hasInsurance: false,
    })) as any;
    // Replayed from the ai_tool_calls ledger rather than executed again.
    expect(retry).toMatchObject({ success: true, idempotentReplay: true });

    const after = await e2e.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM appointments WHERE "tenantId" = $1`,
      [clinic.tenantId],
    );
    expect(after[0].c).toBe(before[0].c);
  });

  it('refuses a doctor who does not work at the selected branch (cross-clinic)', async () => {
    const res = (await call(AI_PUBLIC_TOOL.SELECT_DOCTOR, {
      staffId: otherClinic.staffId,
    })) as any;
    expect(res.success).toBe(false);
  });

  it('refuses a service that belongs to a different clinic', async () => {
    const res = (await call(AI_PUBLIC_TOOL.SELECT_SERVICE, {
      serviceIds: [otherClinic.serviceId],
    })) as any;
    expect(res.success).toBe(false);
  });

  it('refuses a branch that belongs to a different clinic than the one selected', async () => {
    const res = (await call(AI_PUBLIC_TOOL.SELECT_BRANCH, {
      branchId: otherClinic.branchId,
    })) as any;
    expect(res.success).toBe(false);
  });

  it('never lets the guest reach the staff-only booking tool', async () => {
    const res = (await call(AI_TOOL.BOOK_APPOINTMENT, {
      branchId: clinic.branchId,
      customerId: randomUUID(),
      staffId: clinic.staffId,
      startAt: SLOT_START,
    })) as any;
    expect(res.success).toBe(false);
    // Refused before any permission check even runs: a guest principal is not a
    // real user, so there is no `actorUserId` to book on behalf of.
    expect(String(res.error)).toMatch(/permission|Forbidden|no acting user/i);
  });
});

/**
 * T063 (US4, FR-P003) — the DETERMINISTIC step-by-step HTTP path
 * (`PublicBookingController`), proven against real Postgres exactly like the
 * conversational path above. A separate `describe`, a separate clinic and a
 * separate `E2eApp`: Jest describes in this codebase each own an isolated
 * app instance rather than sharing state across blocks, matching every other
 * e2e file here.
 *
 * Parity is proven structurally: both paths call the identical write path
 * (`AppointmentsService.create`, under the clinic's bot actor, with
 * `AppointmentSource.PUBLIC_AI`) — for the same selections, both must land
 * an appointment with the same tenant/branch/staff/source/status/price
 * shape the conversational suite already pins above.
 */
describe('Public booking — deterministic HTTP path (T063, US4)', () => {
  let e2e: E2eApp;
  const API = '/api/v1';
  const HTTP_SUITE = `pbf-http-${randomUUID().slice(0, 8)}`;
  const HTTP_SLOT_START = '2027-03-17T12:00:00.000Z'; // Wednesday, well inside 08:00–20:00

  let cityId: string;
  let httpClinic: Clinic;
  let otherHttpClinic: Clinic;
  const tenantIds: string[] = [];

  async function makeClinic(label: string, city: string): Promise<Clinic> {
    const ds = e2e.dataSource;

    const tenant = await ds.getRepository(Tenant).save(
      ds.getRepository(Tenant).create({
        name: `E2E ${label} ${HTTP_SUITE}`,
        slug: `e2e-${label}-${HTTP_SUITE}`,
        contact_email: `${label}-${HTTP_SUITE}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    tenantIds.push(tenant.id);

    await e2e.app.get(FreeAccessOverrideService).grant(tenant.id, {
      reason: `e2e ${HTTP_SUITE}`,
      durationDays: null,
    });

    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: tenant.id } as Tenant,
        public_booking_enabled: true,
        payment_required: false,
      }),
    );

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Main`,
        address: `1 ${label} Street`,
        city_id: city,
        is_active: true,
        timezone: 'Asia/Riyadh',
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Consultation`,
        // NOT NULL, unique per tenant (ServiceService assigns it in production).
        public_slug: `consultation-${randomUUID().slice(0, 8)}`,
        duration_minutes: 30,
        base_price: 100,
        is_active: true,
      }),
    );
    await ds.getRepository(ServicePrice).save(
      ds.getRepository(ServicePrice).create({
        tenant: { id: tenant.id } as Tenant,
        service: { id: service.id } as Service,
        branch: { id: branch.id } as Branch,
        price: 250,
        is_active: true,
      }),
    );

    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenant.id } as Tenant,
        email: `doctor-${label}-${HTTP_SUITE}@example.test`,
        full_name: `Dr ${label}`,
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        tenant: { id: tenant.id } as Tenant,
        user: { id: user.id } as User,
        // `staff_profiles.public_slug` is NOT NULL + globally unique (StaffService
        // assigns it in production); a fixture inserting the row directly must too.
        public_slug: `dr-${randomUUID().slice(0, 12)}`,
        title: 'Consultant',
        is_available_for_booking: true,
      }),
    );
    for (let day = 0; day < 7; day += 1) {
      await ds.getRepository(StaffSchedule).save(
        ds.getRepository(StaffSchedule).create({
          tenant: { id: tenant.id } as Tenant,
          staff: { id: staff.id } as StaffProfile,
          branch: { id: branch.id } as Branch,
          day_of_week: day,
          start_time: '08:00:00',
          end_time: '20:00:00',
          is_active: true,
        }),
      );
    }

    return {
      tenantId: tenant.id,
      branchId: branch.id,
      serviceId: service.id,
      staffId: staff.id,
      cityId: city,
    };
  }

  /** Drives the deterministic flow's cookie jar across requests, like a browser. */
  function agent() {
    return request.agent(e2e.app.getHttpServer());
  }

  beforeAll(async () => {
    e2e = await createE2eApp();

    const city = await e2e.dataSource.getRepository(City).save(
      e2e.dataSource.getRepository(City).create({
        name_en: `Testville ${HTTP_SUITE}`,
        name_ar: `مدينة ${HTTP_SUITE}`,
      }),
    );
    cityId = city.id;

    httpClinic = await makeClinic('alpha', cityId);
    otherHttpClinic = await makeClinic('beta', cityId);
  }, 120_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) =>
      e2e.dataSource.query(sql, p).catch(() => undefined);
    for (const tenantId of tenantIds) {
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM payment_links WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM service_prices WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM services WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
      await q(`DELETE FROM subscription_usage WHERE tenant_id = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM free_access_overrides WHERE tenant_id = $1`, [
        tenantId,
      ]);
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [tenantId]);
      await q(
        `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
        [tenantId],
      );
      await q(
        `DELETE FROM user_roles WHERE "roleId" IN (SELECT id FROM roles WHERE "tenantId" = $1)`,
        [tenantId],
      );
      await q(`DELETE FROM roles WHERE "tenantId" = $1`, [tenantId]);
      await cleanupTenant(e2e, tenantId);
    }
    await q(
      `DELETE FROM ai_conversations WHERE "tenantId" = (SELECT id FROM tenants WHERE slug LIKE $1)`,
      [`%${HTTP_SUITE}%`],
    );
    await q(`DELETE FROM cities WHERE id = $1`, [cityId]);
    await e2e.app.close();
  }, 120_000);

  it('walks the whole step chain over HTTP and produces the same shape as the conversational path', async () => {
    const client = agent();

    await client
      .post(`${API}/public/booking/select/clinic`)
      .send({ clinicId: httpClinic.tenantId })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/service`)
      .send({ serviceIds: [httpClinic.serviceId] })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/doctor`)
      .send({ staffId: httpClinic.staffId })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/slot`)
      .send({ startAt: HTTP_SLOT_START })
      .expect(200);

    const confirmRes = await client
      .post(`${API}/public/booking/confirm`)
      .send({
        fullName: 'HTTP Anonymous Patient',
        phone: `+96650${HTTP_PHONE_TAIL}`,
        hasInsurance: false,
        notes: 'Booked via the deterministic HTTP flow',
      })
      .expect(200);

    expect(confirmRes.body).toMatchObject({
      appointmentId: expect.any(String),
      status: expect.any(String),
      hasInsurance: false,
    });

    const row = await e2e.dataSource.query(
      `SELECT "tenantId", "branchId", "staffId", source, status, payment_status, total_amount
         FROM appointments WHERE id = $1`,
      [confirmRes.body.appointmentId],
    );
    // Same shape the conversational path's own assertion pins above — the
    // parity FR-P003 requires, for the same selections.
    expect(row[0]).toMatchObject({
      tenantId: httpClinic.tenantId,
      branchId: httpClinic.branchId,
      staffId: httpClinic.staffId,
      source: AppointmentSource.PUBLIC_AI,
      status: AppointmentStatus.CONFIRMED,
      payment_status: AppointmentPaymentStatus.UNPAID,
    });
    expect(Number(row[0].total_amount)).toBe(250);
  }, 60_000);

  it('rejects a doctor from a different clinic than the one selected (cross-clinic, same as the conversational path)', async () => {
    const client = agent();
    await client
      .post(`${API}/public/booking/select/clinic`)
      .send({ clinicId: httpClinic.tenantId })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/service`)
      .send({ serviceIds: [httpClinic.serviceId] })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/doctor`)
      .send({ staffId: otherHttpClinic.staffId })
      .expect(422);
  });

  it('an injected branchId/staffId/startAt on the confirm body has no effect — the DTO does not accept them', async () => {
    const client = agent();
    await client
      .post(`${API}/public/booking/select/clinic`)
      .send({ clinicId: httpClinic.tenantId })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/service`)
      .send({ serviceIds: [httpClinic.serviceId] })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/doctor`)
      .send({ staffId: httpClinic.staffId })
      .expect(200);
    await client
      .post(`${API}/public/booking/select/slot`)
      .send({ startAt: HTTP_SLOT_START })
      .expect(200);

    // A visitor who never selected `otherHttpClinic` tries to smuggle its
    // resource ids into the confirm body directly.
    const res = await client.post(`${API}/public/booking/confirm`).send({
      fullName: 'Attacker',
      phone: `+96650${HTTP_PHONE_TAIL.slice(-6)}9`,
      branchId: otherHttpClinic.branchId,
      staffId: otherHttpClinic.staffId,
      startAt: '2027-03-18T12:00:00.000Z',
    });

    // Global `forbidNonWhitelisted` refuses the request outright — the
    // strongest possible "no effect": the fields can never even reach the
    // handler, let alone retarget the booking.
    expect(res.status).toBe(400);

    const leaked = await e2e.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM appointments WHERE "tenantId" = $1 AND "branchId" = $2`,
      [otherHttpClinic.tenantId, otherHttpClinic.branchId],
    );
    expect(leaked[0].c).toBe(0);
  });

  /**
   * T075 (US4) — two anonymous visitors racing for the SAME slot. The window
   * is bookable when both check it; only one commit can win. This is
   * `appointments_no_overlap` (the DB exclusion constraint), not application
   * code — `AvailabilityService`'s own docblock names this exact race
   * (`STAFF_NOT_AVAILABLE` → 409, "the window WAS bookable when checked, but
   * a concurrent request committed first"). Two independent `agent()`
   * cookie jars, so neither request carries the other's session.
   */
  const RACE_SLOT_START = '2027-03-17T14:00:00.000Z';

  it('exactly one of two concurrent confirms for the same slot wins', async () => {
    const clientA = agent();
    const clientB = agent();

    for (const client of [clientA, clientB]) {
      await client
        .post(`${API}/public/booking/select/clinic`)
        .send({ clinicId: httpClinic.tenantId })
        .expect(200);
      await client
        .post(`${API}/public/booking/select/service`)
        .send({ serviceIds: [httpClinic.serviceId] })
        .expect(200);
      await client
        .post(`${API}/public/booking/select/doctor`)
        .send({ staffId: httpClinic.staffId })
        .expect(200);
      await client
        .post(`${API}/public/booking/select/slot`)
        .send({ startAt: RACE_SLOT_START })
        .expect(200);
    }

    const [resA, resB] = await Promise.all([
      clientA.post(`${API}/public/booking/confirm`).send({
        fullName: 'Racer A',
        phone: `+96650${HTTP_PHONE_TAIL.slice(-6)}1`,
      }),
      clientB.post(`${API}/public/booking/confirm`).send({
        fullName: 'Racer B',
        phone: `+96650${HTTP_PHONE_TAIL.slice(-6)}2`,
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const landed = await e2e.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM appointments
        WHERE "tenantId" = $1 AND "staffId" = $2 AND start_at = $3`,
      [httpClinic.tenantId, httpClinic.staffId, RACE_SLOT_START],
    );
    expect(landed[0].c).toBe(1);
  }, 30_000);
});
