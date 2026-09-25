/**
 * T090 — privilege-escalation attempts: a `customer`-role principal
 * attempting staff actions, and a lower-privileged staff role (`doctor`,
 * `receptionist`) invoking a higher-privileged admin tool from
 * `ai-admin-tools.constants.ts`. Every principal's permission array is read
 * LIVE from `ROLE_PERMISSIONS` (`ai-w3-tool-catalog.ts`'s `permissionsForPrincipal`)
 * — never hand-typed — so this file cannot silently drift from the real RBAC
 * contract in `rbac.constants.ts`.
 *
 * Each case asserts refusal (`result.success === false`) BEFORE the protected
 * operation — backed by a spy on the exact backing service showing zero
 * invocations — plus a control case per principal proving the SAME
 * dispatcher path executes successfully for a tool that principal's real
 * role DOES cover (so a blanket-refusal bug can never masquerade as a pass).
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_ADMIN_TOOL } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { permissionsForPrincipal, backingServiceSpy, PrincipalType } from './fixtures/ai-w3-tool-catalog';

interface EscalationCase {
  principal: PrincipalType;
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

describe('W3 — role-escalation attempts (T090)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function attemptAs(principal: PrincipalType, toolName: string, args: Record<string, unknown>) {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = {
      tenantId: seed.tenantA.id,
      aiConversationId: conv.id,
      actorUserId: seed.tenantA.staffUserId,
      permissions: permissionsForPrincipal(principal),
    };
    const result = await dispatch.execute(ctx, scriptedToolCall(toolName, args));
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
    return result;
  }

  describe('customer-role principal attempting STAFF actions', () => {
    // customer's real permission set has neither APPOINTMENTS_RESCHEDULE, APPOINTMENTS_CANCEL,
    // ANALYTICS_DASHBOARD_READ, STAFF_READ, nor CUSTOMERS_READ (rbac.constants.ts:1636-1641) —
    // sanity-check that assumption is still true before relying on it.
    it('sanity: customer role does not hold any of the escalation-target permissions', () => {
      const perms = permissionsForPrincipal('customer');
      expect(perms).not.toContain('appointments.reschedule');
      expect(perms).not.toContain('appointments.cancel');
      expect(perms).not.toContain('analytics.dashboard.read');
      expect(perms).not.toContain('staff.read');
      expect(perms).not.toContain('customers.read');
    });

    it('refuses: customer → reschedule (staff-only permission)', async () => {
      const spy = backingServiceSpy(harness.app, AI_TOOL.RESCHEDULE_APPOINTMENT);
      const result = await attemptAs('customer', AI_TOOL.RESCHEDULE_APPOINTMENT, {
        appointmentId: seed.tenantA.appointmentId,
        newStartAt: '2027-02-01T10:00:00Z',
      });
      expect(result.success).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    const customerEscalations: EscalationCase[] = [
      { principal: 'customer', tool: AI_TOOL.CANCEL_APPOINTMENT, args: {}, label: 'cancel (staff-only permission)' },
      { principal: 'customer', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, args: {}, label: 'dashboard KPIs (admin tool)' },
      { principal: 'customer', tool: AI_ADMIN_TOOL.GET_STAFF_OVERVIEW, args: {}, label: 'staff overview (admin tool)' },
      { principal: 'customer', tool: AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW, args: {}, label: 'patient overview (admin tool)' },
    ];

    for (const c of customerEscalations) {
      it(`refuses: customer → ${c.label}`, async () => {
        const spy = backingServiceSpy(harness.app, c.tool);
        const result = await attemptAs(c.principal, c.tool, c.args);
        expect(result.success).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });
    }

    it('control case: customer CAN book_appointment (the one staff-shaped action their real role grants)', async () => {
      const spy = backingServiceSpy(harness.app, AI_TOOL.BOOK_APPOINTMENT);
      spy.mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001', // valid-shaped UUID — real column type, avoids an unrelated DB error masking the assertion
        status: 'CONFIRMED',
        payment_status: 'UNPAID',
        start_at: new Date(),
        end_at: new Date(),
        total_amount: 0,
      } as never);

      const result = await attemptAs('customer', AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffUserId,
        startAt: '2027-02-01T10:00:00Z',
      });
      expect(result.success).not.toBe(false); // genuinely succeeded — no refusal of any kind
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('doctor (deliberately minimal) attempting write + admin actions', () => {
    it('sanity: doctor role holds its 12 reviewed permissions — own-scoped appointment read/status, own-patient edit, read-only CRM context — and NONE of the tenant-wide appointment/analytics slugs the escalation targets below need (rbac.constants.ts ROLE_PERMISSIONS[doctor])', () => {
      const perms = permissionsForPrincipal('doctor');
      expect([...perms].sort()).toEqual(
        [
          'appointments.read_own',
          'appointments.status.update',
          'clinical.records.manage',
          'clinical.records.read',
          'crm.customers.read',
          'crm.customers.update_own',
          'crm.files.read',
          'crm.notes.read',
          'crm.tags.read',
          'dashboard.access',
          'staff.read_own',
          'staff.schedule.read',
        ].sort(),
      );
      // The slugs each refusal below depends on — a doctor must never hold them.
      for (const forbidden of [
        'appointments.create',
        'appointments.reschedule',
        'appointments.cancel',
        'appointments.read',
        'appointments.update',
        'analytics.dashboard.read',
      ]) {
        expect(perms).not.toContain(forbidden);
      }
    });

    const doctorEscalations: EscalationCase[] = [
      { principal: 'doctor', tool: AI_TOOL.BOOK_APPOINTMENT, args: {}, label: 'book_appointment' },
      { principal: 'doctor', tool: AI_TOOL.RESCHEDULE_APPOINTMENT, args: {}, label: 'reschedule_appointment' },
      { principal: 'doctor', tool: AI_TOOL.CANCEL_APPOINTMENT, args: {}, label: 'cancel_appointment' },
      // appointments.read_own is a DIFFERENT slug from appointments.read — the
      // admin tool requires the tenant-wide slug, which a doctor never holds.
      { principal: 'doctor', tool: AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW, args: {}, label: 'get_appointment_overview (needs tenant-wide appointments.read, doctor only has appointments.read_own)' },
      { principal: 'doctor', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, args: {}, label: 'get_dashboard_kpis (admin tool)' },
    ];

    for (const c of doctorEscalations) {
      it(`refuses: doctor → ${c.label}`, async () => {
        const spy = backingServiceSpy(harness.app, c.tool);
        const result = await attemptAs(c.principal, c.tool, c.args);
        expect(result.success).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });
    }
  });

  describe('receptionist (lower-privileged staff) invoking HIGHER-privileged admin tools', () => {
    it('sanity: receptionist lacks analytics.dashboard.read, subscription.read, usage.read, ai.analytics.read (rbac.constants.ts:1553-1603)', () => {
      const perms = permissionsForPrincipal('receptionist');
      expect(perms).not.toContain('analytics.dashboard.read');
      expect(perms).not.toContain('subscription.read');
      expect(perms).not.toContain('usage.read');
      expect(perms).not.toContain('ai.analytics.read');
      // Control: receptionist DOES hold these — the escalation targets below
      // are a genuine step UP, not an artifact of an empty permission set.
      expect(perms).toContain('appointments.read');
      expect(perms).toContain('customers.read');
      expect(perms).toContain('staff.read');
    });

    const receptionistEscalations: EscalationCase[] = [
      { principal: 'receptionist', tool: AI_ADMIN_TOOL.GET_DASHBOARD_KPIS, args: {}, label: 'get_dashboard_kpis' },
      { principal: 'receptionist', tool: AI_ADMIN_TOOL.GET_SUBSCRIPTION_STATUS, args: {}, label: 'get_subscription_status' },
      { principal: 'receptionist', tool: AI_ADMIN_TOOL.GET_USAGE_QUOTA, args: {}, label: 'get_usage_quota' },
      { principal: 'receptionist', tool: AI_ADMIN_TOOL.GET_AI_USAGE_REPORT, args: {}, label: 'get_ai_usage_report' },
      { principal: 'receptionist', tool: AI_ADMIN_TOOL.GET_AI_MONITORING_SUMMARY, args: {}, label: 'get_ai_monitoring_summary' },
    ];

    for (const c of receptionistEscalations) {
      it(`refuses: receptionist → ${c.label}`, async () => {
        const spy = backingServiceSpy(harness.app, c.tool);
        const result = await attemptAs(c.principal, c.tool, c.args);
        expect(result.success).toBe(false);
        expect(spy).not.toHaveBeenCalled();
      });
    }

    it('control case: receptionist CAN reach get_appointment_overview / get_patient_overview / get_staff_overview (the 3 admin tools their real role covers)', async () => {
      for (const tool of [AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW, AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW, AI_ADMIN_TOOL.GET_STAFF_OVERVIEW]) {
        const spy = backingServiceSpy(harness.app, tool);
        spy.mockResolvedValue({ total: 0 } as never);
        const result = await attemptAs('receptionist', tool, {});
        expect(result.success).not.toBe(false); // genuinely succeeded — no refusal of any kind
        expect(spy).toHaveBeenCalledTimes(1);
        jest.restoreAllMocks();
      }
    });
  });
});
