/**
 * T094 — idempotency of mutating tools: invoke twice with the SAME logical
 * intent (same deterministic idempotency key, per `w3-state-changes.md`) and
 * confirm exactly ONE domain side effect, with the second call replaying the
 * first result rather than re-executing — enforced by
 * `uq_ai_tool_call_idem (tenant_id, idempotency_key)`
 * (`ai-tool-calls.bootstrap.ts:53-56`).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AppointmentsService } from '../../src/modules/appointment/appointment.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { Service } from '../../src/entities/Services/Service';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

describe('W3 — mutating-tool idempotency (T094)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;
  let serviceId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);

    // `book_appointment`'s tool schema has NO `endAt` property (duration is
    // ALWAYS derived from `serviceIds`, per `computeWindowAndTotal`) — the
    // seed fixture creates no `Service` rows, so a real booking needs one.
    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ tenant: { id: seed.tenantA.id } as Tenant, name: 'T094 Synthetic Service', duration_minutes: 30, base_price: 50 }),
    );
    serviceId = service.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  /** FK-safe appointment cleanup — a booking with services/payment may have `appointment_services` and `payment_links` rows referencing it. */
  async function deleteAppointment(appointmentId: string) {
    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]).catch(() => undefined);
  }

  it('book_appointment: same conversation + staffId + startAt, called TWICE — exactly one Appointment row, second call replays', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const createSpy = jest.spyOn(harness.app.get(AppointmentsService), 'create');
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_CREATE],
    };
    const args = {
      branchId: seed.tenantA.branchId,
      customerId: seed.tenantA.customerIds[0],
      // `staffId` is a StaffProfile id (the practitioner being booked) — NOT
      // the same as `ctx.actorUserId` (a User id, the person making the
      // booking). The seed fixture's single staff member has both, but they
      // are different ids on different tables (`assertStaffAtBranch` looks
      // `staffId` up against `StaffProfile`, `ai-tool-dispatch.service.ts`'s
      // `ctx.actorUserId` flows into `Appointment.booked_by` → `User`).
      staffId: seed.tenantA.staffProfileId,
      startAt: '2027-04-01T10:00:00Z',
      serviceIds: [serviceId], // duration is derived from this — the tool schema has no endAt property
    };

    const before = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1 AND "staffId" = $2 AND start_at = $3`,
      [seed.tenantA.id, seed.tenantA.staffProfileId, '2027-04-01T10:00:00Z'],
    );

    const first = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args));
    expect(first.success).not.toBe(false);
    expect(first.idempotentReplay).toBeUndefined();

    const second = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args));
    expect(second.success).not.toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.appointmentId).toBe(first.appointmentId);

    // Exactly ONE domain side effect: AppointmentsService.create called once, not twice.
    expect(createSpy).toHaveBeenCalledTimes(1);

    const after = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1 AND "staffId" = $2 AND start_at = $3`,
      [seed.tenantA.id, seed.tenantA.staffProfileId, '2027-04-01T10:00:00Z'],
    );
    expect(after[0].n).toBe(before[0].n + 1);
    await deleteAppointment(first.appointmentId as string);
    // Ledger check: exactly one ai_tool_calls row for this idempotency key, SUCCEEDED.
    const key = `book:${conv.id}:${seed.tenantA.staffProfileId}:2027-04-01T10:00:00Z`;
    const ledgerRows = await harness.dataSource.query(`SELECT status FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key = $2`, [seed.tenantA.id, key]);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].status).toBe('SUCCEEDED');

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    createSpy.mockRestore();
  });

  it('cancel_appointment: same appointmentId, called TWICE — exactly one AppointmentsService.cancel invocation, second call replays', async () => {
    // Use a FRESH appointment (not the seed's shared one) so this case is
    // independent of test ordering / other files touching the seed row.
    const created = await dispatch.execute(
      {
        tenantId: seed.tenantA.id,
        aiConversationId: (await conversations.start(seed.tenantA.id, {})).id,
        actorUserId: seed.tenantA.staffUserId,
        permissions: [PERMISSION.APPOINTMENTS_CREATE],
      },
      scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[1],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-04-02T10:00:00Z',
        serviceIds: [serviceId],
      }),
    );
    expect(created.success).not.toBe(false);
    const appointmentId = created.appointmentId as string;

    const conv = await conversations.start(seed.tenantA.id, {});
    const cancelSpy = jest.spyOn(harness.app.get(AppointmentsService), 'cancel');
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_CANCEL],
    };

    // AI-019/F1 (PD-1, 2026-08-17): cancel_appointment is now confirmation-
    // gated — the FIRST call with no confirmationToken is refused and mints
    // one; the SECOND call, carrying it, is the actual first execution this
    // test's idempotency assertions are about.
    const propose = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, { appointmentId }));
    expect(propose.success).toBe(false);
    expect(propose.confirmationRequired).toBe(true);
    const confirmationToken = propose.confirmationToken as string;

    const first = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, { appointmentId, confirmationToken }));
    expect(first.success).not.toBe(false);
    expect(first.idempotentReplay).toBeUndefined();

    // A retry carrying NO token (or a stale one) still replays the SUCCEEDED
    // result rather than re-asking for confirmation — the confirmation gate
    // is skipped once a ledger claim already exists for this key (FR-027:
    // idempotency semantics are not disturbed by the confirmation gate).
    const second = await dispatch.execute(ctx, scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, { appointmentId }));
    expect(second.success).not.toBe(false);
    expect(second.idempotentReplay).toBe(true);

    // Exactly ONE domain side effect: AppointmentsService.cancel called once, not twice.
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    const key = `cancel:${appointmentId}`;
    const ledgerRows = await harness.dataSource.query(`SELECT status FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key = $2`, [seed.tenantA.id, key]);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].status).toBe('SUCCEEDED');

    await deleteAppointment(appointmentId);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    cancelSpy.mockRestore();
  });

  it('the SAME idempotency key is scoped per-tenant (uq_ai_tool_call_idem is (tenant_id, idempotency_key)) — a different tenant with the coincidentally-identical key is NOT deduplicated against tenant A\'s claim', async () => {
    // request_human_handover's key is `handover:${aiConversationId}` — unique
    // per conversation regardless of tenant, so this specific coincidence
    // cannot arise for it; instead prove the INDEX itself is tenant-scoped by
    // inserting two ai_tool_calls rows with the identical idempotency_key
    // under two different tenants and confirming both persist (no cross-tenant
    // unique-constraint collision).
    const sharedKey = `t094-cross-tenant-coincidence-${Date.now()}`;
    const convA = await conversations.start(seed.tenantA.id, {});
    const convB = await conversations.start(seed.tenantB.id, {});

    await harness.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, tool_name, arguments, status, idempotency_key)
       VALUES ($1, $2, 'search_clinics', '{}'::jsonb, 'SUCCEEDED', $3)`,
      [seed.tenantA.id, convA.id, sharedKey],
    );
    // Must NOT throw a unique-constraint violation — different tenant, same key.
    await harness.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, tool_name, arguments, status, idempotency_key)
       VALUES ($1, $2, 'search_clinics', '{}'::jsonb, 'SUCCEEDED', $3)`,
      [seed.tenantB.id, convB.id, sharedKey],
    );

    const rows = await harness.dataSource.query(`SELECT tenant_id FROM ai_tool_calls WHERE idempotency_key = $1`, [sharedKey]);
    expect(rows).toHaveLength(2);

    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE idempotency_key = $1`, [sharedKey]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id IN ($1, $2)`, [convA.id, convB.id]);
  });
});
