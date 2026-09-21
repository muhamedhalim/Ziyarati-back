/**
 * T094 — idempotency of mutating tools: invoke twice with the SAME logical
 * intent (same deterministic idempotency key, per `w3-state-changes.md`) and
 * confirm exactly ONE domain side effect, with the second call replaying the
 * first result rather than re-executing — enforced by
 * `uq_ai_tool_call_idem (tenant_id, idempotency_key)`
 * (`ai-tool-calls.bootstrap.ts:53-56`).
 */
import {
  buildAiAuditHarness,
  type AiAuditHarness,
} from './fixtures/ai-audit-harness';
import {
  seedAiAudit,
  teardownAiAuditSeed,
  type AiAuditSeed,
} from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import {
  AiToolDispatchService,
  ToolContext,
} from '../../src/modules/ai/tools/ai-tool-dispatch.service';
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
      services.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        name: 'T094 Synthetic Service',
        duration_minutes: 30,
        base_price: 50,
        public_slug: 't094-synthetic-service',
      }),
    );
    serviceId = service.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource
      .query(`DELETE FROM services WHERE id = $1`, [serviceId])
      .catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  /** FK-safe appointment cleanup — a booking with services/payment may have `appointment_services` and `payment_links` rows referencing it. */
  async function deleteAppointment(appointmentId: string) {
    await harness.dataSource
      .query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [
        appointmentId,
      ])
      .catch(() => undefined);
    await harness.dataSource
      .query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [
        appointmentId,
      ])
      .catch(() => undefined);
    await harness.dataSource
      .query(`DELETE FROM appointments WHERE id = $1`, [appointmentId])
      .catch(() => undefined);
  }

  it('book_appointment: same conversation + staffId + startAt, called TWICE — exactly one Appointment row, second call replays', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const createSpy = jest.spyOn(
      harness.app.get(AppointmentsService),
      'create',
    );
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

    const first = await dispatch.execute(
      ctx,
      scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args),
    );
    expect(first.success).not.toBe(false);
    expect(first.idempotentReplay).toBeUndefined();

    const second = await dispatch.execute(
      ctx,
      scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args),
    );
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
    const ledgerRows = await harness.dataSource.query(
      `SELECT status FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key = $2`,
      [seed.tenantA.id, key],
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].status).toBe('SUCCEEDED');

    await harness.dataSource.query(
      `DELETE FROM ai_conversations WHERE id = $1`,
      [conv.id],
    );
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
    const cancelSpy = jest.spyOn(
      harness.app.get(AppointmentsService),
      'cancel',
    );
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
    const propose = await dispatch.execute(
      { ...ctx, turnId: 'user-msg-1' },
      scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, { appointmentId }),
    );
    expect(propose.success).toBe(false);
    expect(propose.confirmationRequired).toBe(true);
    const confirmationToken = propose.confirmationToken as string;

    const first = await dispatch.execute(
      { ...ctx, turnId: 'user-msg-2' }, // Phase 2 (F-04): confirmed in a LATER user turn
      scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, {
        appointmentId,
        confirmationToken,
      }),
    );
    expect(first.success).not.toBe(false);
    expect(first.idempotentReplay).toBeUndefined();

    // A retry carrying NO token (or a stale one) still replays the SUCCEEDED
    // result rather than re-asking for confirmation — the confirmation gate
    // is skipped once a ledger claim already exists for this key (FR-027:
    // idempotency semantics are not disturbed by the confirmation gate).
    const second = await dispatch.execute(
      ctx,
      scriptedToolCall(AI_TOOL.CANCEL_APPOINTMENT, { appointmentId }),
    );
    expect(second.success).not.toBe(false);
    expect(second.idempotentReplay).toBe(true);

    // Exactly ONE domain side effect: AppointmentsService.cancel called once, not twice.
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    const key = `cancel:${appointmentId}`;
    const ledgerRows = await harness.dataSource.query(
      `SELECT status FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key = $2`,
      [seed.tenantA.id, key],
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].status).toBe('SUCCEEDED');

    await deleteAppointment(appointmentId);
    await harness.dataSource.query(
      `DELETE FROM ai_conversations WHERE id = $1`,
      [conv.id],
    );
    cancelSpy.mockRestore();
  });

  it("the SAME idempotency key is scoped per-tenant (uq_ai_tool_call_idem is (tenant_id, idempotency_key)) — a different tenant with the coincidentally-identical key is NOT deduplicated against tenant A's claim", async () => {
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

    const rows = await harness.dataSource.query(
      `SELECT tenant_id FROM ai_tool_calls WHERE idempotency_key = $1`,
      [sharedKey],
    );
    expect(rows).toHaveLength(2);

    await harness.dataSource.query(
      `DELETE FROM ai_tool_calls WHERE idempotency_key = $1`,
      [sharedKey],
    );
    await harness.dataSource.query(
      `DELETE FROM ai_conversations WHERE id IN ($1, $2)`,
      [convA.id, convB.id],
    );
  });

  describe('AIE-A08 — idempotency key is conversation-scoped: a DIFFERENT conversation with the same booking intent', () => {
    it("is NOT deduplicated by the idempotency ledger (different key), and is instead correctly refused by the AVAILABILITY layer's occupancy check", async () => {
      const startAt = '2027-06-01T10:00:00Z';
      const args = {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt,
        serviceIds: [serviceId],
      };

      const convA = await conversations.start(seed.tenantA.id, {});
      const ctxA: ToolContext = {
        tenantId: seed.tenantA.id,
        aiConversationId: convA.id,
        actorUserId: seed.tenantA.staffUserId,
        permissions: [PERMISSION.APPOINTMENTS_CREATE],
      };
      const first = await dispatch.execute(
        ctxA,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args),
      );
      expect(first.success).not.toBe(false);

      // A SECOND, DIFFERENT conversation attempts the identical booking
      // intent (same staff, same startAt). Its idempotency key is
      // `book:${convB.id}:...` — different from convA's — so this is NOT a
      // ledger replay. If the availability layer weren't doing its job, this
      // would silently double-book the same slot.
      const convB = await conversations.start(seed.tenantA.id, {});
      const ctxB: ToolContext = {
        tenantId: seed.tenantA.id,
        aiConversationId: convB.id,
        actorUserId: seed.tenantA.staffUserId,
        permissions: [PERMISSION.APPOINTMENTS_CREATE],
      };
      const second = await dispatch.execute(
        ctxB,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, args),
      );
      expect(second.success).toBe(false);

      const rows = await harness.dataSource.query(
        `SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1 AND "staffId" = $2 AND start_at = $3 AND status NOT IN ('CANCELLED','NO_SHOW')`,
        [seed.tenantA.id, seed.tenantA.staffProfileId, startAt],
      );
      expect(rows[0].n).toBe(1); // exactly one survives — not zero, not two

      // Two DIFFERENT ledger rows exist (proves this was refused by
      // availability, not silently absorbed as a replay of convA's claim).
      const ledgerRows = await harness.dataSource.query(
        `SELECT ai_conversation_id::text, status FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key LIKE $2 ORDER BY created_at`,
        [seed.tenantA.id, `book:%:${seed.tenantA.staffProfileId}:${startAt}`],
      );
      expect(ledgerRows).toHaveLength(2);
      expect(
        new Set(
          ledgerRows.map(
            (r: { ai_conversation_id: string }) => r.ai_conversation_id,
          ),
        ).size,
      ).toBe(2);

      await deleteAppointment(first.appointmentId as string);
      await harness.dataSource.query(
        `DELETE FROM ai_tool_calls WHERE tenant_id = $1 AND idempotency_key LIKE $2`,
        [seed.tenantA.id, `book:%:${seed.tenantA.staffProfileId}:${startAt}`],
      );
      await harness.dataSource.query(
        `DELETE FROM ai_conversations WHERE id IN ($1, $2)`,
        [convA.id, convB.id],
      );
    }, 30_000);
  });

  describe('AIE-A09 — the appointments_no_overlap exclusion constraint is the actual guarantee under a genuine race', () => {
    it('two truly CONCURRENT AppointmentsService.create() calls for the identical slot: exactly one succeeds, the loser is SLOT_ALREADY_BOOKED (23P01)', async () => {
      const appointments = harness.app.get(AppointmentsService);
      const startAt = '2027-06-01T15:00:00Z';
      const args = {
        branchId: seed.tenantA.branchId,
        staffId: seed.tenantA.staffProfileId,
        customerId: seed.tenantA.customerIds[0],
        serviceIds: [serviceId],
        startAt,
      };

      const results = await Promise.allSettled([
        appointments.create(
          seed.tenantA.id,
          seed.tenantA.staffUserId,
          args as any,
        ),
        appointments.create(
          seed.tenantA.id,
          seed.tenantA.staffUserId,
          args as any,
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // A direct AppointmentsService.create() call (bypassing the HTTP
      // exception filter / AI tool dispatcher, which is what maps this to
      // the friendly SLOT_ALREADY_BOOKED AppError — see
      // typeorm-error.mapper.ts) sees the RAW driver error: SQLSTATE 23P01,
      // the exclusion constraint violation itself. That raw code IS the
      // proof the database — not app-level logic — decided the race.
      expect((rejected[0].reason as { code?: string }).code).toBe('23P01');

      const rows = await harness.dataSource.query(
        `SELECT count(*)::int n FROM appointments WHERE "tenantId" = $1 AND "staffId" = $2 AND start_at = $3 AND status NOT IN ('CANCELLED','NO_SHOW')`,
        [seed.tenantA.id, seed.tenantA.staffProfileId, startAt],
      );
      expect(rows[0].n).toBe(1); // the exclusion constraint let exactly one survive

      const survivor = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>)
        .value;
      await deleteAppointment(survivor.id);
    }, 30_000);
  });
});
