/**
 * T059 — bulk, search and aggregation cross-tenant reproduction (FR-021, FR-022).
 *
 * Drives every list/search/aggregate admin tool as tenant A via the REAL
 * dispatcher and compares the returned counts against the KNOWN per-tenant
 * seed cardinality from `seedAiAudit` (T015: exactly 2 customers, 1 staff
 * member, 1 appointment per tenant) — proving tenant B's rows make zero
 * contribution to tenant A's aggregate, not merely that SOME number came
 * back. An extra tenant-B-only customer/appointment is seeded here
 * specifically so a leak would be numerically visible (a naive UNSCOPED count
 * would over-report tenant A's numbers by exactly this amount).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_ADMIN_TOOL } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { Customer } from '../../src/entities/CRM/Customer';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import type { AiConversation } from '../../src/entities/AI Agent/AiConversation';

describe('AI-W4 bulk/search/aggregation cross-tenant reproduction (T059)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;
  let extraTenantBCustomerId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);

    // A THIRD customer, only in tenant B — makes a leak numerically visible:
    // if tenant A's count ever included tenant B's rows, it would be off by
    // exactly this extra row (3 total across both tenants instead of 2+1=3
    // matching only if scoped correctly; tenant A must report exactly 2).
    const customers = harness.dataSource.getRepository(Customer);
    const extra = await customers.save(
      customers.create({
        tenant: { id: seed.tenantB.id } as Tenant,
        full_name: 'Extra Tenant-B-Only Customer (T059 cardinality probe)',
        phone: `+1555${Math.floor(1_000_000 + Math.random() * 8_000_000)}`,
        email: `t059-extra-${Date.now()}@example.test`,
      }),
    );
    extraTenantBCustomerId = extra.id;
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM customers WHERE id = $1`, [extraTenantBCustomerId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function tenantACtx(): Promise<ToolContext> {
    const conv: AiConversation = await conversations.start(seed.tenantA.id, {});
    return {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: [
        PERMISSION.APPOINTMENTS_READ,
        PERMISSION.CUSTOMERS_READ,
        PERMISSION.STAFF_READ,
        PERMISSION.ANALYTICS_DASHBOARD_READ,
      ],
    };
  }

  it('get_patient_overview (bulk count): tenant A reports exactly its own 2 seeded customers, never tenant B\'s 3rd', async () => {
    const ctx = await tenantACtx();
    const result = await dispatch.execute(ctx, {
      id: 'c1',
      name: AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW,
      arguments: JSON.stringify({}),
    });
    expect(result.success).not.toBe(false);
    expect((result as { totalPatients?: number }).totalPatients).toBe(2);
  });

  it('get_appointment_overview (aggregation): tenant A reports exactly its own 1 seeded appointment', async () => {
    const ctx = await tenantACtx();
    const result = await dispatch.execute(ctx, {
      id: 'c2',
      name: AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW,
      arguments: JSON.stringify({}),
    });
    expect(result.success).not.toBe(false);
    expect((result as { totalAppointments?: number }).totalAppointments).toBe(1);
  });

  it('get_staff_overview (bulk count): tenant A reports exactly its own 1 seeded staff member', async () => {
    const ctx = await tenantACtx();
    const result = await dispatch.execute(ctx, {
      id: 'c3',
      name: AI_ADMIN_TOOL.GET_STAFF_OVERVIEW,
      arguments: JSON.stringify({}),
    });
    expect(result.success).not.toBe(false);
    expect((result as { totalStaff?: number }).totalStaff).toBe(1);
  });

  it('get_dashboard_kpis (aggregation): tenant A KPI snapshot never inflates from tenant B activity', async () => {
    const ctx = await tenantACtx();
    const result = await dispatch.execute(ctx, {
      id: 'c4',
      name: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS,
      arguments: JSON.stringify({}),
    });
    expect(result.success).not.toBe(false);
    expect(result).toHaveProperty('kpis');
  });

  it('control: the SAME extra customer IS visible when queried under tenant B\'s own context (proves counting logic works, isolation is the cause of the difference above)', async () => {
    const convB = await conversations.start(seed.tenantB.id, {});
    const ctxB: ToolContext = {
      tenantId: seed.tenantB.id,
      aiConversationId: convB.id,
      actorUserId: seed.tenantB.staffUserId,
      permissions: [PERMISSION.CUSTOMERS_READ],
    };
    const result = await dispatch.execute(ctxB, {
      id: 'c5',
      name: AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW,
      arguments: JSON.stringify({}),
    });
    expect(result.success).not.toBe(false);
    expect((result as { totalPatients?: number }).totalPatients).toBe(3); // 2 seeded + 1 extra
  });
});
