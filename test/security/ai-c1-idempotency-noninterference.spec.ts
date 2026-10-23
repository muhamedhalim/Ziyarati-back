/**
 * T083 (AI-008, FR-027, FR-101, FR-086, R3, US3-AS7) — the single most
 * important new test in the feature (quickstart §Feature C).
 *
 * Proves the record/claim split (FR-023) is non-interfering end to end
 * against the real ledger:
 *  1. A permission DENIAL on `book_appointment` writes an ATTEMPT row
 *     (`attempt:book_appointment:<uuid>` key) — it does NOT pre-claim the
 *     real booking's idempotency key.
 *  2. A subsequent LEGITIMATE booking with the identical logical intent
 *     (same conversation/staff/start — the real claim key) still executes
 *     exactly once — the prior denial's attempt row neither blocks it nor
 *     is mistaken for a replayable prior result.
 *  3. Retrying the SAME legitimate booking again replays the SUCCEEDED
 *     claim (idempotent, one Appointment row total) — never the false
 *     "A matching action is already in progress." (`ai-tool-dispatch.
 *     service.ts:1363/1407`, which is what a PENDING/EXECUTING row would
 *     produce; an attempt row is written already-terminal, so this failure
 *     mode structurally cannot arise from it).
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

describe('C1 — idempotency non-interference between denial ATTEMPT rows and real CLAIM rows (T083)', () => {
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

    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`, tenant: { id: seed.tenantA.id } as Tenant, name: 'T083 Synthetic Service', duration_minutes: 30, base_price: 50 }),
    );
    serviceId = service.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function deleteAppointment(appointmentId: string) {
    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]).catch(() => undefined);
  }

  it('a denial ATTEMPT row never pre-claims, blocks, or replays the SAME booking intent once legitimately authorized', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const createSpy = jest.spyOn(harness.app.get(AppointmentsService), 'create');
    const staffId = seed.tenantA.staffProfileId;
    const startAt = '2027-05-01T10:00:00Z';
    const args = {
      branchId: seed.tenantA.branchId,
      customerId: seed.tenantA.customerIds[0],
      staffId,
      startAt,
      serviceIds: [serviceId],
    };
    const claimKey = `book:${conv.id}:${staffId}:${startAt}`;

    // (1) Denied — no `appointments.create` permission.
    const deniedCtx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [],
    };
    const denied = await dispatch.execute(deniedCtx, scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args));
    expect(denied.success).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();

    // The denial produced exactly one ATTEMPT row under a namespaced key —
    // NOT the real claim key — and the real claim key has no row at all yet.
    const afterDenial = await harness.dataSource.query(
      `SELECT idempotency_key, status FROM ai_tool_calls WHERE tenant_id = $1 AND ai_conversation_id = $2 AND tool_name = $3`,
      [seed.tenantA.id, conv.id, AI_TOOL.BOOK_APPOINTMENT],
    );
    expect(afterDenial).toHaveLength(1);
    expect(afterDenial[0].idempotency_key).toMatch(/^attempt:book_appointment:[0-9a-f-]{36}$/);
    expect(afterDenial[0].status).toBe('DENIED');
    const claimRowAfterDenial = await harness.dataSource.query(
      `SELECT 1 FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key = $2`,
      [seed.tenantA.id, claimKey],
    );
    expect(claimRowAfterDenial).toHaveLength(0);

    // (2) The SAME logical booking, now legitimately authorized — must
    // execute for real, not be blocked or falsely replayed by the attempt row.
    const authorizedCtx: ToolContext = {
      ...deniedCtx,
      permissions: [PERMISSION.APPOINTMENTS_CREATE],
    };
    const first = await dispatch.execute(authorizedCtx, scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args));
    expect(first.success).not.toBe(false);
    expect(first.idempotentReplay).toBeUndefined();
    expect(createSpy).toHaveBeenCalledTimes(1);

    // (3) A retry of the identical legitimate call replays the SUCCEEDED
    // claim — never the "already in progress" message a stale PENDING/
    // EXECUTING row would produce.
    const second = await dispatch.execute(authorizedCtx, scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args));
    expect(second.success).not.toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.appointmentId).toBe(first.appointmentId);
    expect(second.error ?? '').not.toMatch(/already in progress/i);
    // Still exactly one domain side effect across denial + 2 authorized calls.
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Ledger end-state: exactly the two rows this scenario should produce —
    // one terminal ATTEMPT (denial) and one terminal, unbounded CLAIM
    // (the real booking) — no interference in either direction.
    const finalRows = await harness.dataSource.query(
      `SELECT idempotency_key, status FROM ai_tool_calls WHERE tenant_id = $1 AND ai_conversation_id = $2 AND tool_name = $3 ORDER BY created_at`,
      [seed.tenantA.id, conv.id, AI_TOOL.BOOK_APPOINTMENT],
    );
    expect(finalRows).toHaveLength(2);
    expect(finalRows[0]).toMatchObject({
      idempotency_key: afterDenial[0].idempotency_key,
      status: 'DENIED',
    });
    expect(finalRows[1]).toMatchObject({ idempotency_key: claimKey, status: 'SUCCEEDED' });

    await deleteAppointment(first.appointmentId as string);
    await harness.dataSource.query(`DELETE FROM ai_tool_calls WHERE ai_conversation_id = $1`, [conv.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    createSpy.mockRestore();
  }, 30_000);
});
