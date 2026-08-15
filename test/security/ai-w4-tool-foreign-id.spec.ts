/**
 * T054 — user-supplied foreign-id tool-call reproduction (FR-020, FR-021).
 *
 * A tenant-A principal supplies tenant-B appointment/customer/staff ids to
 * every id-accepting tool, invoked directly through the REAL dispatcher
 * (`AiToolDispatchService.execute`, per `HARNESS_GUIDE.md` gotcha 10 — the
 * direct entry point for exercising one tool in isolation). `search_clinics` /
 * `get_clinic_details` / `search_public_availability` are excluded from this
 * table: `w3-declared-vs-enforced.md` documents them as deliberate PUBLIC
 * cross-tenant discovery tools (any visitor may look up any publicly-bookable
 * clinic by design) — returning tenant-B data there is the intended feature,
 * not a boundary violation, so including them would misrepresent the finding.
 * The tools below are the ones where tenant B's data must NEVER be reachable
 * from a tenant-A-scoped `ToolContext`.
 *
 * Per-tool outcome table is printed at the end (T054's Evidence requirement).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_ADMIN_TOOL } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

interface OutcomeRow {
  tool: string;
  foreignId: string;
  success: unknown;
  leaked: boolean;
}

describe('AI-W4 tool foreign-id reproduction (T054)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;
  const outcomes: OutcomeRow[] = [];

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
    // eslint-disable-next-line no-console
    console.log(
      '\n===T054-PER-TOOL-OUTCOME-TABLE===\n' +
        outcomes.map((o) => `${o.tool} | foreignId=${o.foreignId} | success=${JSON.stringify(o.success)} | leaked=${o.leaked}`).join('\n') +
        '\n===END===\n',
    );
  }, 60_000);

  /** Fully-privileged tenant-A ToolContext (every permission these tools could require). */
  async function tenantAConv(): Promise<AiConversation> {
    return conversations.start(seed.tenantA.id, {});
  }

  function fullCtx(convId: string): ToolContext {
    return {
      tenantId: seed.tenantA.id,
      aiConversationId: convId,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [
        PERMISSION.APPOINTMENTS_CREATE,
        PERMISSION.APPOINTMENTS_READ,
        PERMISSION.APPOINTMENTS_RESCHEDULE,
        PERMISSION.APPOINTMENTS_CANCEL,
        PERMISSION.CUSTOMERS_READ,
        PERMISSION.STAFF_READ,
        PERMISSION.ANALYTICS_DASHBOARD_READ,
        PERMISSION.SUBSCRIPTION_READ,
        PERMISSION.USAGE_READ,
        PERMISSION.AI_ANALYTICS_READ,
      ],
    };
  }

  function record(tool: string, foreignId: string, result: Record<string, unknown>, leakKeys: string[]) {
    const leaked = leakKeys.some((k) => Object.prototype.hasOwnProperty.call(result, k));
    outcomes.push({ tool, foreignId, success: result.success, leaked });
    return leaked;
  }

  it('get_customer_insurance_status: tenant-B customerId is refused, no insurance field leaked', async () => {
    const conv = await tenantAConv();
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c1',
      name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
      arguments: JSON.stringify({ customerId: seed.tenantB.customerIds[0] }),
    });
    expect(result.success).toBe(false);
    const leaked = record(AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS, seed.tenantB.customerIds[0], result, ['hasInsurance']);
    expect(leaked).toBe(false);
  });

  it('book_appointment: tenant-B branchId/customerId/staffId are refused, no appointment created', async () => {
    const conv = await tenantAConv();
    const before = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM appointments WHERE "branchId" = $1`,
      [seed.tenantB.branchId],
    );
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c2',
      name: AI_TOOL.BOOK_APPOINTMENT,
      arguments: JSON.stringify({
        branchId: seed.tenantB.branchId,
        customerId: seed.tenantB.customerIds[0],
        staffId: seed.tenantB.staffProfileId,
        startAt: '2027-03-01T10:00:00Z',
      }),
    });
    expect(result.success).toBe(false);
    const after = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS count FROM appointments WHERE "branchId" = $1`,
      [seed.tenantB.branchId],
    );
    expect(after[0].count).toBe(before[0].count); // zero side effect against tenant B
    record(AI_TOOL.BOOK_APPOINTMENT, seed.tenantB.branchId, result, ['appointmentId']);
  });

  it('reschedule_appointment: tenant-B appointmentId is refused (not-found), never rescheduled', async () => {
    const conv = await tenantAConv();
    const before = await harness.dataSource.query(
      `SELECT start_at FROM appointments WHERE id = $1`,
      [seed.tenantB.appointmentId],
    );
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c3',
      name: AI_TOOL.RESCHEDULE_APPOINTMENT,
      arguments: JSON.stringify({
        appointmentId: seed.tenantB.appointmentId,
        newStartAt: '2027-03-02T10:00:00Z',
      }),
    });
    expect(result.success).toBe(false);
    const after = await harness.dataSource.query(
      `SELECT start_at FROM appointments WHERE id = $1`,
      [seed.tenantB.appointmentId],
    );
    expect(new Date(after[0].start_at).toISOString()).toBe(new Date(before[0].start_at).toISOString());
    record(AI_TOOL.RESCHEDULE_APPOINTMENT, seed.tenantB.appointmentId, result, ['startAt']);
  });

  it('cancel_appointment: tenant-B appointmentId is refused (not-found), never cancelled', async () => {
    const conv = await tenantAConv();
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c4',
      name: AI_TOOL.CANCEL_APPOINTMENT,
      arguments: JSON.stringify({ appointmentId: seed.tenantB.appointmentId }),
    });
    expect(result.success).toBe(false);
    const after = await harness.dataSource.query(
      `SELECT status FROM appointments WHERE id = $1`,
      [seed.tenantB.appointmentId],
    );
    expect(after[0].status).not.toBe('CANCELLED');
    record(AI_TOOL.CANCEL_APPOINTMENT, seed.tenantB.appointmentId, result, []);
  });

  it('get_staff_overview: a tenant-B branchId filter yields zero (tenant-scoped count, not a tenant-B count)', async () => {
    const conv = await tenantAConv();
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c5',
      name: AI_ADMIN_TOOL.GET_STAFF_OVERVIEW,
      arguments: JSON.stringify({ branchId: seed.tenantB.branchId }),
    });
    // Not a refusal (the admin gate passed) — but the count must be 0, since
    // StaffService.findAll(ctx.tenantId=tenantA, {branchId: tenantB.branchId})
    // can never match a tenant-A staff row against a foreign branch id.
    expect(result.success).not.toBe(false);
    expect((result as { totalStaff?: number }).totalStaff).toBe(0);
    record(AI_ADMIN_TOOL.GET_STAFF_OVERVIEW, seed.tenantB.branchId, result, []);
  });

  it('get_appointment_overview: tenant-A count is unaffected by tenant-B rows (no cross-tenant contribution)', async () => {
    const conv = await tenantAConv();
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c6',
      name: AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW,
      arguments: JSON.stringify({}),
    });
    expect(result.success).not.toBe(false);
    // Tenant A has exactly 1 seeded appointment; tenant B's own seeded
    // appointment must not inflate this count.
    expect((result as { totalAppointments?: number }).totalAppointments).toBe(1);
    record(AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW, seed.tenantB.appointmentId, result, []);
  });

  it('control: the SAME tools succeed against tenant A\'s own ids (proves refusal above is tenant-scoping, not a blanket failure)', async () => {
    const conv = await tenantAConv();
    const result = await dispatch.execute(fullCtx(conv.id), {
      id: 'c7',
      name: AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
      arguments: JSON.stringify({ customerId: seed.tenantA.customerIds[0] }),
    });
    expect(result.success).not.toBe(false);
    expect(result).toHaveProperty('hasInsurance');
  });
});
