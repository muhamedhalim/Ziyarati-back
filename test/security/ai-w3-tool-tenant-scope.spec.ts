/**
 * T091 — every MUTATING tool, executed with the CORRECT permission and role
 * but targeting a FOREIGN tenant's resource, asserting the target tenant's
 * database state is unchanged after each attempt (pre/post snapshot).
 *
 * The 10 mutating tools (`w3-state-changes.md` row 7's summary +
 * `book_appointment`/`reschedule_appointment`/`cancel_appointment`/
 * `request_human_handover`): `book_appointment`, `reschedule_appointment`,
 * `cancel_appointment`, `request_human_handover`, `select_clinic`,
 * `select_branch`, `select_service`, `select_doctor`, `select_slot`,
 * `book_public_appointment`. Three of these (`select_clinic` by design,
 * `select_slot`/`book_public_appointment` structurally) accept no
 * tenant-crossable id argument at all — recorded as such (absence is
 * evidence too, per the audit's own discipline in `w3-state-changes.md`)
 * rather than a fabricated test.
 *
 * NOTE (per the task instruction): this file's sub-cases run SEQUENTIALLY
 * (no `test.concurrent`, no `Promise.all` across cases) — a peer W9 task
 * (T139) also writes appointment rows and Jest may run spec FILES in
 * parallel, but within this file every case awaits to completion before the
 * next starts.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_PUBLIC_TOOL, AI_PUBLIC_BOOKING_TOOLS } from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { PublicBookingContextService } from '../../src/modules/public-booking/public-booking-context.service';
import { Service } from '../../src/entities/Services/Service';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import { StaffSchedule } from '../../src/entities/Staff/StaffSchedule';
import { StaffProfile } from '../../src/entities/Staff/StaffProfile';
import { Branch } from '../../src/entities/SaaS-Core/Branch';

describe('W3 — mutating tools, correct role, FOREIGN tenant resource (T091)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let dispatch: AiToolDispatchService;
  let tenantAServiceId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    dispatch = harness.app.get(AiToolDispatchService);

    for (const tenantId of [seed.tenantA.id, seed.tenantB.id]) {
      await harness.dataSource.query(
        `INSERT INTO tenant_settings (tenant_id, public_booking_enabled) VALUES ($1, true)
         ON CONFLICT (tenant_id) DO UPDATE SET public_booking_enabled = true`,
        [tenantId],
      );
    }

    // book_appointment / book_public_appointment's schemas have NO `endAt`
    // property — duration is always derived from `serviceIds`, so a REAL
    // booking (case 10 below) needs a real Service row (the seed fixture
    // creates none).
    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ tenant: { id: seed.tenantA.id } as Tenant, name: 'T091 Synthetic Service', duration_minutes: 30, base_price: 50 }),
    );
    tenantAServiceId = service.id;

    // `book_public_appointment` runs STRICT branch-scoping (`AppointmentSource
    // .PUBLIC_AI`) — `assertStaffAtBranch` requires an ACTIVE `StaffSchedule`
    // row for (staff, branch) specifically, unlike `book_appointment`'s
    // non-strict "anywhere" fallback. The seed fixture creates none; cover
    // every day of week with wide hours so the specific test date never matters.
    const schedules = harness.dataSource.getRepository(StaffSchedule);
    await schedules.save(
      Array.from({ length: 7 }, (_, day_of_week) =>
        schedules.create({
          staff: { id: seed.tenantA.staffProfileId } as StaffProfile,
          branch: { id: seed.tenantA.branchId } as Branch,
          tenant: { id: seed.tenantA.id } as Tenant,
          day_of_week,
          start_time: '00:00',
          end_time: '23:59',
          is_active: true,
        }),
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM staff_schedules WHERE "staffId" = $1`, [seed.tenantA.staffProfileId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM services WHERE id = $1`, [tenantAServiceId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function appointmentSnapshot(appointmentId: string) {
    const rows = await harness.dataSource.query(
      `SELECT status, start_at, end_at, "tenantId" FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    return rows[0];
  }

  async function guestConversation() {
    const conv = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: seed.guestA.id });
    return conv;
  }

  async function readSession(tenantId: string, conversationId: string): Promise<Record<string, unknown>> {
    const rows = await harness.dataSource.query(`SELECT session FROM ai_conversations WHERE id = $1 AND "tenantId" = $2`, [conversationId, tenantId]);
    return rows[0]?.session ?? {};
  }

  // ── 1. book_appointment — foreign branch/customer/staff from tenant B ──── //
  it('book_appointment: tenant-A staff, foreign (tenant-B) branchId/customerId/staffId — refused, zero appointment rows created for tenant B', async () => {
    const before = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantB.id]);

    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_CREATE],
    };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
      branchId: seed.tenantB.branchId,
      customerId: seed.tenantB.customerIds[0],
      staffId: seed.tenantB.staffUserId,
      startAt: '2027-03-01T10:00:00Z',
    }));

    expect(result.success).toBe(false);

    const after = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantB.id]);
    expect(after[0].n).toBe(before[0].n);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 2. reschedule_appointment — foreign (tenant-B) appointmentId ────────── //
  it('reschedule_appointment: tenant-A staff, foreign (tenant-B) appointmentId — refused, tenant-B appointment row unchanged', async () => {
    const before = await appointmentSnapshot(seed.tenantB.appointmentId);

    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_RESCHEDULE],
    };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.RESCHEDULE_APPOINTMENT, {
      appointmentId: seed.tenantB.appointmentId,
      newStartAt: '2027-03-02T10:00:00Z',
    }));

    expect(result.success).toBe(false);

    const after = await appointmentSnapshot(seed.tenantB.appointmentId);
    expect(after).toEqual(before);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 3. cancel_appointment — foreign (tenant-B) appointmentId ────────────── //
  it('cancel_appointment: tenant-A staff, foreign (tenant-B) appointmentId — refused, tenant-B appointment row unchanged', async () => {
    const before = await appointmentSnapshot(seed.tenantB.appointmentId);

    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_CANCEL],
    };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, {
      appointmentId: seed.tenantB.appointmentId,
    }));

    expect(result.success).toBe(false);

    const after = await appointmentSnapshot(seed.tenantB.appointmentId);
    expect(after).toEqual(before);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 4. request_human_handover — no id argument; confirm it CANNOT land in a foreign tenant ── //
  it('request_human_handover: no tenant-crossable argument exists (server-bound ctx.tenantId only) — the created row always belongs to the CALLING tenant, never any other', async () => {
    const beforeB = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM handover_requests WHERE "tenantId" = $1`, [seed.tenantB.id]);

    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, permissions: [] };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.REQUEST_HUMAN_HANDOVER, { reason: 'T091 tenant-scope probe' }));
    expect(result.success).not.toBe(false);

    const afterB = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM handover_requests WHERE "tenantId" = $1`, [seed.tenantB.id]);
    expect(afterB[0].n).toBe(beforeB[0].n); // tenant B untouched

    const afterA = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM handover_requests WHERE "tenantId" = $1`, [seed.tenantA.id]);
    expect(afterA[0].n).toBeGreaterThan(0); // the row landed in the CALLING tenant, as expected

    await harness.dataSource.query(`DELETE FROM handover_requests WHERE "tenantId" = $1`, [seed.tenantA.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 5. select_clinic — cross-tenant BY DESIGN, not a violation; confirm no leakage beyond the selection itself ── //
  it('select_clinic: selecting a DIFFERENT tenant\'s clinic is the intended public-discovery mechanism, not an isolation violation — confirm the session records exactly that clinic and nothing beyond it', async () => {
    const conv = await guestConversation();
    const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };

    const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_CLINIC, { clinicId: seed.tenantB.id }));
    expect(result.success).not.toBe(false);

    const session = await readSession(seed.discoveryTenantId, conv.id);
    expect(session.selectedClinicId).toBe(seed.tenantB.id);
    // Single-branch auto-select must resolve to a branch that ACTUALLY belongs
    // to tenant B — never tenant A's branch leaking in.
    if (session.selectedBranchId) {
      expect(session.selectedBranchId).not.toBe(seed.tenantA.branchId);
    }

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 6. select_branch — the flagship tamper cross-check (already proven in T038; re-asserted here as this file's own Artifact/Evidence) ── //
  it('select_branch: foreign (tenant-B) branchId against an ALREADY-selected tenant-A clinic — refused, session never adopts the foreign branch', async () => {
    const conv = await guestConversation();
    // Establish the precondition directly (mirrors ai-w2-tenant-override.spec.ts).
    const realBookingContext = harness.app.get(PublicBookingContextService);
    await realBookingContext.patchSelection(seed.discoveryTenantId, conv.id, { selectedClinicId: seed.tenantA.id });

    const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_BRANCH, { branchId: seed.tenantB.branchId }));
    expect(result.success).toBe(false);

    const session = await readSession(seed.discoveryTenantId, conv.id);
    expect(session.selectedBranchId).not.toBe(seed.tenantB.branchId);
    expect(session.selectedClinicId).toBe(seed.tenantA.id);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 7. select_service — foreign serviceId not offered at tenant-A's branch ── //
  it('select_service: a foreign/unrecognized serviceId is refused, session selectedServiceIds unchanged', async () => {
    const realBookingContext = harness.app.get(PublicBookingContextService);

    const conv = await guestConversation();
    await realBookingContext.patchSelection(seed.discoveryTenantId, conv.id, { selectedClinicId: seed.tenantA.id, selectedBranchId: seed.tenantA.branchId });

    const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_SERVICE, { serviceIds: ['foreign-tenant-service-id'] }));
    expect(result.success).toBe(false);

    const session = await readSession(seed.discoveryTenantId, conv.id);
    expect(session.selectedServiceIds).toBeUndefined();

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 8. select_doctor — a REAL foreign (tenant-B) staff id, does not work at tenant-A's branch ── //
  it('select_doctor: a REAL tenant-B staff id (not working at tenant-A\'s branch) is refused, session selectedDoctorId unchanged', async () => {
    const realBookingContext = harness.app.get(PublicBookingContextService);

    const conv = await guestConversation();
    await realBookingContext.patchSelection(seed.discoveryTenantId, conv.id, { selectedClinicId: seed.tenantA.id, selectedBranchId: seed.tenantA.branchId });

    const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_DOCTOR, { staffId: seed.tenantB.staffUserId }));
    expect(result.success).toBe(false);

    const session = await readSession(seed.discoveryTenantId, conv.id);
    expect(session.selectedDoctorId).toBeUndefined();

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  // ── 9. select_slot — no id-shaped/tenant-crossable argument exists ─────────── //
  it('select_slot: schema has NO id-shaped or tenant-crossable argument (only an ISO timestamp) — no foreign-tenant-resource surface exists for this tool', async () => {
    const schema = AI_PUBLIC_BOOKING_TOOLS.find((t) => t.name === AI_PUBLIC_TOOL.SELECT_SLOT)!;
    expect(Object.keys(schema.parameters.properties ?? {})).toEqual(['startAt']);
  });

  // ── 10. book_public_appointment — takes NO resource ids; confirm the write always lands in the SESSION-resolved tenant ── //
  it('book_public_appointment: schema has NO clinic/branch/service/doctor/slot argument — the write can only ever land in the session-resolved tenant (proven end to end: tenant A in, tenant A out, tenant B untouched)', async () => {
    const schema = AI_PUBLIC_BOOKING_TOOLS.find((t) => t.name === AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT)!;
    const props = Object.keys(schema.parameters.properties ?? {});
    for (const idLike of ['clinicId', 'branchId', 'serviceId', 'serviceIds', 'staffId', 'startAt', 'tenantId']) {
      expect(props).not.toContain(idLike);
    }

    const beforeB = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantB.id]);

    const realBookingContext = harness.app.get(PublicBookingContextService);
    const conv = await guestConversation();
    await realBookingContext.patchSelection(seed.discoveryTenantId, conv.id, {
      selectedClinicId: seed.tenantA.id,
      selectedBranchId: seed.tenantA.branchId,
      // `selectedDoctorId` must be a StaffProfile id (what `AppointmentsService
      // .create`'s `assertStaffAtBranch` looks up), not the User id.
      selectedDoctorId: seed.tenantA.staffProfileId,
      selectedServiceIds: [tenantAServiceId], // duration is derived from this — the tool schema has no endAt property
      selectedStartAt: '2027-03-05T10:00:00Z',
    });

    const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };
    const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT, {
      fullName: 'T091 Probe Visitor',
      phone: '+15558880000',
    }));

    const afterB = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantB.id]);
    expect(afterB[0].n).toBe(beforeB[0].n); // tenant B never touched regardless of outcome

    // Non-conditional: the booking MUST succeed here (a legitimate, fully
    // session-resolved tenant-A flow) — if it silently failed, the positive
    // "landed in the right tenant" claim below would never actually be
    // exercised, which is exactly the kind of unproven pass this audit's
    // evidence discipline forbids.
    expect(result.success).not.toBe(false);
    const appointmentId = result.appointmentId as string;
    const row = await appointmentSnapshot(appointmentId);
    expect(row.tenantId).toBe(seed.tenantA.id); // landed in the SESSION-resolved tenant, never tenant B
    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]);
    await harness.dataSource.query(`DELETE FROM customers WHERE "tenantId" = $1 AND phone = $2`, [seed.tenantA.id, '+15558880000']);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 20_000);
});
