/**
 * The Definition of Done for the WhatsApp-as-a-channel feature, as an
 * executable test — the capstone proof the plan's business goal actually
 * works against real Postgres, not just in isolated unit mocks.
 *
 * A patient texting a clinic's OWN WhatsApp number (simulated: a real
 * `WhatsappBotActorService` principal + a real bound `Customer`, exactly what
 * `WhatsappInboundAiService.processTurn` sets up before calling the
 * orchestrator) walks the SAME discovery → booking chain a real inbound
 * "عايز احجز كشف جلدية بكرة بعد العصر" turn would drive:
 *
 *   list_clinic_branches → list_clinic_services / list_clinic_doctors →
 *   check_availability → book_appointment
 *
 * through the REAL `AiToolDispatchService` (the model's own tool-calling loop
 * is out of scope here — see `ai-evaluation.live.spec.ts` /
 * `openai-model-compat.live.spec.ts`, gated behind live API keys — this suite
 * follows the SAME established convention as
 * `public-booking-flow.e2e-spec.ts`, which drives the dispatcher directly
 * rather than a live LLM).
 *
 * Also proves the two things this feature exists to fix:
 *  - Blocker 1: the bot can discover ITS OWN clinic's branches/doctors/
 *    services — no cross-tenant tool, no client-suppliable id.
 *  - Blocker 2: the booking's customer is the WhatsApp contact's SERVER-BOUND
 *    customer (`ctx.customerId`), never a model-supplied one — through the
 *    REAL `AppointmentsService.create`, not a mock.
 */
import { randomUUID } from 'node:crypto';

import { createE2eApp, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { AiToolDispatchService, type ToolContext } from '../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../src/modules/ai/tools/ai-tools.constants';
import { WhatsappBotActorService } from '../src/modules/whatsapp/whatsapp-bot-actor.service';
import { CustomerService } from '../src/modules/crm/customer.service';
import { AppointmentsService } from '../src/modules/appointment/appointment.service';
import { FreeAccessOverrideService } from '../src/modules/subscription-billing/free-access-override.service';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { TenantSetting } from '../src/entities/SaaS-Core/TenantSetting';
import { Branch } from '../src/entities/SaaS-Core/Branch';
import { Service } from '../src/entities/Services/Service';
import { ServicePrice } from '../src/entities/Services/ServicePrice';
import { StaffProfile } from '../src/entities/Staff/StaffProfile';
import { StaffSchedule } from '../src/entities/Staff/StaffSchedule';
import { User } from '../src/entities/Auth&RBAC/User';
import {
  TenantApprovalStatus,
  AppointmentSource,
  AppointmentStatus,
} from '../src/entities/enums';
import type { AuthenticatedUser } from '../src/modules/auth/interfaces/authenticated-user.interface';

const SUITE = `wab-${randomUUID().slice(0, 8)}`;
const SLOT_DATE = '2027-04-12';
const SLOT_START = `${SLOT_DATE}T12:00:00.000Z`;

interface Clinic {
  tenantId: string;
  branchId: string;
  serviceId: string;
  staffId: string;
}

describe('WhatsApp AI booking — own-clinic discovery + server-bound customer, real Postgres', () => {
  let e2e: E2eApp;
  let tools: AiToolDispatchService;
  let botActor: WhatsappBotActorService;
  let customers: CustomerService;

  let clinicA: Clinic;
  let clinicB: Clinic;
  /** The WhatsApp patient's own bound customer, in clinic A. */
  let patientCustomer: { id: string };
  /** A DIFFERENT clinic-A customer — used to prove a model-supplied id never wins. */
  let otherCustomer: { id: string };
  let ctx: ToolContext;

  const tenantIds: string[] = [];

  /** Calls a tool exactly as the model would — through the real dispatcher. */
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools.execute(ctx, { id: randomUUID(), name, arguments: JSON.stringify(args) });

  async function makeClinic(label: string): Promise<Clinic> {
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

    await e2e.app.get(FreeAccessOverrideService).grant(tenant.id, {
      reason: `e2e ${SUITE}`,
      durationDays: null,
    });

    // Deliberately public_booking_enabled = false (default/unset) — the
    // WhatsApp own-clinic tools must work WITHOUT public booking opt-in,
    // unlike the guest discovery tools (`get_clinic_details` et al.), which
    // gate on it. Proving that gap is closed is part of Blocker 1.
    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: tenant.id } as Tenant,
        payment_required: false,
      }),
    );

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Main`,
        address: `1 ${label} Street`,
        is_active: true,
        timezone: 'Asia/Riyadh',
      }),
    );

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenant.id } as Tenant,
        name: `${label} Dermatology Consult`,
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
        price: 300,
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
        title: 'Dermatologist',
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

    return { tenantId: tenant.id, branchId: branch.id, serviceId: service.id, staffId: staff.id };
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    tools = e2e.app.get(AiToolDispatchService);
    botActor = e2e.app.get(WhatsappBotActorService);
    customers = e2e.app.get(CustomerService);

    clinicA = await makeClinic('alpha');
    clinicB = await makeClinic('beta');

    // The tenant's own real ai-bot actor — the SAME principal
    // WhatsappInboundAiService restores via TenantContextService.run() before
    // every inbound turn. Real RolesService/AuthService path, no shortcut.
    const bot: AuthenticatedUser = await botActor.ensureBotActor(clinicA.tenantId);

    patientCustomer = await customers.create(clinicA.tenantId, {
      full_name: 'WhatsApp Patient',
      phone: `+9665${SUITE.slice(-8)}`,
      email: `whatsapp+${clinicA.tenantId}-patient@bot.internal`,
      whatsapp_id: `9665${SUITE.slice(-8)}`,
      source: 'whatsapp',
    } as never);
    otherCustomer = await customers.create(clinicA.tenantId, {
      full_name: 'A Different Clinic-A Patient',
      phone: `+9665${SUITE.slice(0, 8)}`,
      email: `whatsapp+${clinicA.tenantId}-other@bot.internal`,
      source: 'manual',
    } as never);

    // Exactly what `AiExecutionService`'s ToolContext looks like for a real
    // inbound WhatsApp turn: the bot's own real permissions (never assumed),
    // and customerId bound SERVER-SIDE — the trustedSessionPatch outcome,
    // never a value the model could have asserted.
    ctx = {
      tenantId: clinicA.tenantId,
      aiConversationId: randomUUID(), // ai_tool_calls.ai_conversation_id has no FK — a stable id is enough
      actorUserId: bot.id,
      permissions: bot.permissions,
      customerId: patientCustomer.id,
    };
  }, 120_000);

  afterAll(async () => {
    const q = (sql: string, p: unknown[]) => e2e.dataSource.query(sql, p).catch(() => undefined);
    for (const tenantId of tenantIds) {
      await q(`DELETE FROM ai_tool_calls WHERE tenant_id = $1`, [tenantId]);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM appointment_history WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM payment_links WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM staff_schedules WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM service_prices WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM services WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
      await q(`DELETE FROM subscription_usage WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM free_access_overrides WHERE "tenantId" = $1`, [tenantId]);
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
    await e2e.app.close();
  }, 120_000);

  it('walks list_clinic_branches → list_clinic_services/doctors → check_availability → book_appointment, and persists a real appointment for the SERVER-BOUND customer', async () => {
    // 1. Own-clinic branch discovery — tenant-scoped, no clinicId/tenantId argument exists.
    const branches = (await call(AI_TOOL.LIST_CLINIC_BRANCHES)) as any;
    expect(branches.error).toBeUndefined();
    expect(branches.success).toBe(true);
    expect(branches.branches).toEqual([
      { id: clinicA.branchId, name: 'alpha Main', address: '1 alpha Street' },
    ]);
    // Never clinic B's branch — this tool has no notion of "other clinics".
    expect(JSON.stringify(branches.branches)).not.toContain(clinicB.branchId);

    // 2. Services at the branch price (300), not the base price (100) —
    //    proves this reuses the SAME branch-price-override logic the guest
    //    path uses (no duplicated pricing rule).
    const services = (await call(AI_TOOL.LIST_CLINIC_SERVICES, {
      branchId: clinicA.branchId,
    })) as any;
    expect(services.success).toBe(true);
    expect(services.services).toEqual([
      expect.objectContaining({ id: clinicA.serviceId, price: 300 }),
    ]);

    // 3. Doctors at the branch.
    const doctors = (await call(AI_TOOL.LIST_CLINIC_DOCTORS, {
      branchId: clinicA.branchId,
    })) as any;
    expect(doctors.success).toBe(true);
    expect(doctors.doctors).toEqual([
      expect.objectContaining({ id: clinicA.staffId, title: 'Dermatologist' }),
    ]);

    // 4. Real availability.
    const windows = (await call(AI_TOOL.CHECK_AVAILABILITY, {
      branchId: clinicA.branchId,
      staffId: clinicA.staffId,
      date: SLOT_DATE,
    })) as any;
    expect(windows.success).not.toBe(false);

    // 5. Book — deliberately supplying NO customerId, exactly like the real
    //    WHATSAPP_BOT tool schema encourages ("Omit to use the customer
    //    already bound to this conversation"). The server-bound ctx.customerId
    //    is what must be used.
    const booked = (await call(AI_TOOL.BOOK_APPOINTMENT, {
      branchId: clinicA.branchId,
      staffId: clinicA.staffId,
      startAt: SLOT_START,
      serviceIds: [clinicA.serviceId],
      hasInsurance: false,
    })) as any;
    expect(booked.error).toBeUndefined();
    expect(booked).toMatchObject({ success: true, appointmentId: expect.any(String) });

    const row = await e2e.dataSource.query(
      `SELECT "tenantId", "branchId", "staffId", "customerId", source, status, total_amount
         FROM appointments WHERE id = $1`,
      [booked.appointmentId],
    );
    expect(row[0]).toMatchObject({
      tenantId: clinicA.tenantId,
      branchId: clinicA.branchId,
      staffId: clinicA.staffId,
      customerId: patientCustomer.id,
      source: AppointmentSource.WHATSAPP_BOT,
      status: AppointmentStatus.CONFIRMED,
    });
    expect(Number(row[0].total_amount)).toBe(300);
  });

  it('CROSS-TENANT: a branchId from clinic B is refused on clinic A\'s own bot context — no branch info, doctors, services or availability leak', async () => {
    const doctorsAcrossTenant = (await call(AI_TOOL.LIST_CLINIC_DOCTORS, {
      branchId: clinicB.branchId,
    })) as any;
    expect(doctorsAcrossTenant.success).toBe(false);
    expect(doctorsAcrossTenant.doctors).toBeUndefined();

    const servicesAcrossTenant = (await call(AI_TOOL.LIST_CLINIC_SERVICES, {
      branchId: clinicB.branchId,
    })) as any;
    expect(servicesAcrossTenant.success).toBe(false);
    expect(servicesAcrossTenant.services).toBeUndefined();

    const availabilityAcrossTenant = (await call(AI_TOOL.CHECK_AVAILABILITY, {
      branchId: clinicB.branchId,
      staffId: clinicB.staffId,
      date: SLOT_DATE,
    })) as any;
    // check_availability has no tenant-ownership check of its own (it is a
    // staff-facing tool, unscoped by design) — AvailabilityService resolves
    // windows for ctx.tenantId (clinic A), so a clinic-B branchId simply
    // matches nothing real, never clinic B's actual schedule.
    expect(JSON.stringify(availabilityAcrossTenant)).not.toContain(
      clinicB.staffId,
    );
  });

  it('CUSTOMER BINDING: a model-supplied customerId is ignored — the appointment is booked for the SERVER-BOUND WhatsApp patient, through the REAL AppointmentsService', async () => {
    const booked = (await call(AI_TOOL.BOOK_APPOINTMENT, {
      branchId: clinicA.branchId,
      staffId: clinicA.staffId,
      startAt: `${SLOT_DATE}T13:00:00.000Z`,
      serviceIds: [clinicA.serviceId],
      hasInsurance: false,
      // A model that hallucinated, or was prompt-injected via patient text,
      // into using a DIFFERENT clinic-A customer's id.
      customerId: otherCustomer.id,
    })) as any;
    expect(booked.error).toBeUndefined();
    expect(booked.success).toBe(true);

    const row = await e2e.dataSource.query(
      `SELECT "customerId" FROM appointments WHERE id = $1`,
      [booked.appointmentId],
    );
    expect(row[0].customerId).toBe(patientCustomer.id);
    expect(row[0].customerId).not.toBe(otherCustomer.id);
  });
});
