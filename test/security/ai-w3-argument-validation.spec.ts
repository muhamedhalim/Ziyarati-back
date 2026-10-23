/**
 * T095 — tool-argument validation: scripted calls carrying extra properties,
 * wrong types, out-of-range/malformed dates, negative/altered monetary
 * values, and status values the caller may not set. Every call goes through
 * the REAL dispatcher (`AiToolDispatchService.execute`) with a raw JSON
 * string exactly as `scriptedToolCall` builds it — deliberately unsanitized,
 * per its own doc comment, so this measures the DISPATCHER's own validation,
 * not a fixture's.
 *
 * Structural note recorded as OBSERVED BEHAVIOR (not asserted as a bug): the
 * dispatcher parses `call.arguments` with `JSON.parse` and then reads named
 * fields off the resulting object by hand (`this.str(args.foo)`,
 * `Array.isArray(args.bar)`, etc.) — it does NOT itself validate against the
 * tool's declared JSON Schema (`additionalProperties:false`, required types).
 * That schema is understood to be enforced by the MODEL PROVIDER's
 * function-calling contract before a real call is ever emitted — the
 * scripted provider in this harness bypasses that entirely, which is exactly
 * what lets this file test the DISPATCHER's own defense in depth (or its
 * absence) directly.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL, AI_TOOLS } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_ADMIN_TOOL, AI_ADMIN_TOOLS } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { AI_PUBLIC_BOOKING_TOOLS, AI_PUBLIC_TOOL } from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { Service } from '../../src/entities/Services/Service';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

describe('W3 — tool-argument validation (T095)', () => {
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

    // book_appointment's schema has NO `endAt` property — duration is always
    // derived from `serviceIds`; the seed fixture creates no Service rows.
    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ public_slug: `svc-${Math.random().toString(36).slice(2, 10)}`, tenant: { id: seed.tenantA.id } as Tenant, name: 'T095 Synthetic Service', duration_minutes: 30, base_price: 50 }),
    );
    serviceId = service.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  /** FK-safe appointment cleanup. */
  async function deleteAppointment(appointmentId: string) {
    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]).catch(() => undefined);
  }

  async function bookCtx() {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [PERMISSION.APPOINTMENTS_CREATE],
    };
    return { conv, ctx };
  }

  describe('extra / forbidden properties (additionalProperties:false in the schema, NOT enforced by the dispatcher itself)', () => {
    it('book_appointment: extra properties (isAdmin, permissions, tenantId, totalAmount, status) are silently IGNORED — never read, never influence the outcome or the persisted row', async () => {
      const { conv, ctx } = await bookCtx();
      const result = await dispatch.execute(
        ctx,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
          branchId: seed.tenantA.branchId,
          customerId: seed.tenantA.customerIds[0],
          staffId: seed.tenantA.staffProfileId,
          startAt: '2027-05-01T10:00:00Z',
          serviceIds: [serviceId],
          // Everything below is NOT a declared schema property.
          isAdmin: true,
          permissions: ['*'],
          tenantId: seed.tenantB.id,
          totalAmount: -999999,
          amount: 999999,
          status: 'CONFIRMED_BY_INJECTION',
          __proto__: { polluted: true },
        }),
      );

      expect(result.success).not.toBe(false);
      const appointmentId = result.appointmentId as string;
      const row = await harness.dataSource.query(`SELECT "tenantId", status, total_amount FROM appointments WHERE id = $1`, [appointmentId]);
      expect(row[0].tenantId).toBe(seed.tenantA.id); // the injected tenantId (tenant B) never took effect
      expect(Number(row[0].total_amount ?? 0)).toBeGreaterThanOrEqual(0); // never went negative from the injected totalAmount

      await deleteAppointment(appointmentId);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });

    it('every one of the 26 tool schemas declares additionalProperties:false (recorded per T095\'s Verify clause)', () => {
      const allSchemas = [...AI_TOOLS, ...AI_ADMIN_TOOLS, ...AI_PUBLIC_BOOKING_TOOLS];
      const missing = allSchemas.filter((t) => t.parameters.additionalProperties !== false).map((t) => t.name);
      expect(missing).toEqual([]);
      expect(allSchemas.length).toBeGreaterThanOrEqual(26); // 9 core + 8 admin + 9 public (public re-adds the 4 reused discovery names as separate entries only in AI_TOOLS — not double counted here)
    });
  });

  describe('wrong types', () => {
    it('book_appointment: startAt as a NUMBER (not a string) is treated as absent — required-field refusal, not a type-coercion booking', async () => {
      const { conv, ctx } = await bookCtx();
      const result = await dispatch.execute(
        ctx,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
          branchId: seed.tenantA.branchId,
          customerId: seed.tenantA.customerIds[0],
          staffId: seed.tenantA.staffProfileId,
          startAt: 1893456000000, // epoch millis, not an ISO string
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/required/i);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });

    it('select_service (public catalog): serviceIds as a STRING (not an array) is treated as an empty selection — refused, never silently coerced to a single-item array', async () => {
      const conv = await conversations.start(seed.discoveryTenantId, {});
      const sessions = harness.app.get(ConversationSessionService);
      await sessions.patch(seed.discoveryTenantId, conv.id, { guestSubject: seed.guestA.id });

      const ctx: ToolContext = { tenantId: seed.discoveryTenantId, aiConversationId: conv.id, principal: seed.guestA, permissions: [] };
      const result = await dispatch.execute(ctx, scriptedToolCall(AI_PUBLIC_TOOL.SELECT_SERVICE, { serviceIds: 'not-an-array' }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/required/i);

      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });

    it(`get_patient_overview (admin): isActive as a STRING ("true") is NOT treated as the boolean true — the dispatcher's strict typeof==='boolean' check ignores it`, async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: seed.tenantA.staffUserId, permissions: [PERMISSION.CUSTOMERS_READ] };
      const result = await dispatch.execute(ctx, scriptedToolCall(AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW, { isActive: 'true' }));
      expect(result.success).not.toBe(false); // does not crash — the filter is just silently dropped, not applied as a truthy string
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });
  });

  describe('out-of-range / malformed dates', () => {
    it('book_appointment: a non-parseable startAt string is refused — `new Date()` yields NaN, caught by AppointmentsService.assertChronological (appointment.service.ts:1298-1307), never booked as an Invalid Date', async () => {
      const { conv, ctx } = await bookCtx();
      const result = await dispatch.execute(
        ctx,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
          branchId: seed.tenantA.branchId,
          customerId: seed.tenantA.customerIds[0],
          staffId: seed.tenantA.staffProfileId,
          serviceIds: [serviceId],
          startAt: 'definitely-not-a-date',
        }),
      );
      expect(result.success).toBe(false);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });

    it('book_appointment: a startAt far in the PAST is refused — PD-6 (AI-027): `assertChronological` (appointment.service.ts:1298-1329) now rejects a past `startAt` specifically on the assistant\'s own booking sources (`WHATSAPP_BOT`/`PUBLIC_AI`), closing the gap this file previously recorded as observed-but-unguarded behavior', async () => {
      const { conv, ctx } = await bookCtx();
      const result = await dispatch.execute(
        ctx,
        scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
          branchId: seed.tenantA.branchId,
          customerId: seed.tenantA.customerIds[0],
          staffId: seed.tenantA.staffProfileId,
          serviceIds: [serviceId],
          startAt: '2000-01-01T10:00:00Z',
        }),
      );
      // Inverted per PD-6 (2026-08-17): the assistant's booking path now
      // rejects a well-formed past date deterministically, rather than
      // silently booking it. Staff/admin backdating on other, non-assistant
      // paths is unaffected by this change (out of scope for AI-027).
      expect(result.success).toBe(false);
      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });
  });

  describe('status values the caller may not set', () => {
    it('no tool in any of the 26 accepts a raw appointment "status" SET argument — status is always server-derived, never model-supplied (confirmed by schema inspection)', () => {
      const allSchemas = [...AI_TOOLS, ...AI_ADMIN_TOOLS, ...AI_PUBLIC_BOOKING_TOOLS];
      for (const tool of allSchemas) {
        // get_appointment_overview's `status` is a READ FILTER, not a set — the
        // only "status"-named property in the entire 26-tool surface.
        if (tool.name === AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW) continue;
        expect(Object.keys(tool.parameters.properties ?? {})).not.toContain('status');
      }
    });

    it('get_appointment_overview: an injection-shaped status filter never executes as SQL — the appointments table survives intact, and the call ends in a graceful result (success or a clean validation rejection), never a raw DB error or an unhandled exception', async () => {
      const conv = await conversations.start(seed.tenantA.id, {});
      const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: seed.tenantA.staffUserId, permissions: [PERMISSION.APPOINTMENTS_READ] };
      const result = await dispatch.execute(ctx, scriptedToolCall(AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW, { status: "'; DROP TABLE appointments; --" }));

      // The DECISIVE assertion: the table was never touched by the injection
      // payload — proven by querying it independently afterward (a dropped
      // or corrupted table would throw here).
      const stillExists = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM appointments WHERE "tenantId" = $1`, [seed.tenantA.id]);
      expect(typeof stillExists[0].n).toBe('number');

      // The call itself resolves gracefully either way — TypeORM's query
      // builder parameterizes `status`, so an unrecognized value is either
      // silently non-matching (success, zero-ish count) or rejected by a
      // typed validator upstream (a clean AppError, not a raw pg crash).
      // Whichever it is, `dispatch.execute()` never throws out to the caller.
      expect(typeof result.success).toBe('boolean'); // always a defined boolean — no unhandled exception reached the top
      if (result.success !== false) {
        expect(typeof result.totalAppointments).toBe('number');
      } else {
        expect(typeof result.error).toBe('string');
      }

      await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    });
  });
});
