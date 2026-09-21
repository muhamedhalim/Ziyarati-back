/**
 * WhatsApp surface — one clinic on its own number, authenticated bot actor.
 *
 * Real path: `WhatsappInboundAiService.handleInboundValue` (the webhook bridge) →
 * orchestrator → `AiExecutionService` → dispatcher, with the tenant's REAL
 * per-tenant bot actor (`AI_BOT_PERMISSIONS`). Only the outbound Meta send is
 * captured. The "model" is a deterministic double.
 *
 * Findings covered:
 *   F-03  cancel/reschedule accept ANY appointment id in the tenant (within-tenant IDOR)
 *   F-04  the confirmation token is model-mediated: redeemable in the same turn, no user reply
 *   F-05  tenant_settings.cancellation_hours is not applied on the AI path
 *   F-02  (WhatsApp variant) availability slot length is whatever the model passes
 *
 * Convention: defect tests PASS WHILE THE DEFECT EXISTS.
 */
import { randomUUID } from 'node:crypto';
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';
import { bootAudit, whatsappTurn, whatsappToolCtx, saveEvidence, type AuditRuntime } from './fixtures/audit-runtime';
import { ReactiveProvider, toolResultsIn } from './fixtures/reactive-provider';

describe('WhatsApp surface — tools, identity binding and appointment actions', () => {
  let rt: AuditRuntime;
  let reactive: ReactiveProvider;
  const observed: Record<string, any> = {};
  const q = (sql: string, p: unknown[] = []) => rt.harness.dataSource.query(sql, p);

  /** A CONFIRMED appointment for `customerId`, starting `hoursAhead` from now. */
  async function newAppointment(customerId: string, hoursAhead: number): Promise<string> {
    const { full } = rt.seed;
    const start = new Date(Date.now() + hoursAhead * 3_600_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 45 * 60_000);
    const rows = await q(
      `INSERT INTO appointments (status,payment_status,currency,source,start_at,end_at,"tenantId","branchId","customerId","staffId")
       VALUES ('CONFIRMED','UNPAID','SAR','MANUAL',$1,$2,$3,$4,$5,$6) RETURNING id`,
      [start.toISOString(), end.toISOString(), full.tenantId, full.branchId, customerId, full.doctorStaffIds.omar],
    );
    return rows[0].id;
  }
  const statusOf = async (id: string) => (await q(`SELECT status, start_at FROM appointments WHERE id=$1`, [id]))[0];

  beforeAll(async () => {
    rt = await bootAudit();
    reactive = new ReactiveProvider();
    rt.use(reactive);
  }, 180_000);
  afterAll(async () => {
    saveEvidence('det-02-whatsapp', observed);
    await rt?.close();
  }, 60_000);

  // ── discovery tools are tenant-bound and work ──────────────────────────────
  it('own-clinic facts work on WhatsApp (tenant from ctx): branches, services, hours, address, phone, roster', async () => {
    const { full } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const branches = await rt.dispatch.execute(ctx, call('list_clinic_branches', {}));
    const services = await rt.dispatch.execute(ctx, call('list_clinic_services', { branchId: full.branchId }));
    const info = await rt.dispatch.execute(ctx, call('get_branch_info', { branchId: full.branchId }));
    const sched = await rt.dispatch.execute(ctx, call('get_doctor_schedule', { branchId: full.branchId, staffId: full.doctorStaffIds.omar }));
    observed.wa_branches = branches; observed.wa_services = services; observed.wa_info = info; observed.wa_sched = sched;

    expect((branches.branches as any[]).map((b) => b.name).sort()).toEqual(['Main Branch', 'North Branch']);
    expect(info.success).toBe(true);
    expect(info.branch.phone).toBe('+966500000111');
    expect(sched.success).toBe(true);
    expect((services.services as any[]).find((s) => s.name === 'General Consultation').price).toBeNull();
    // MINOR: unlike the public tool, the WhatsApp list carries no `priceStatus`, so `price: null` is
    // distinguishable from free only by the prompt's own warning.
    expect((services.services as any[])[0]).not.toHaveProperty('priceStatus');
  });

  it('F-02 (WhatsApp): check_availability uses the slot length the MODEL passes — omitted, a free 09:00-17:00 day is one window start', async () => {
    const { full } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const base = { branchId: full.branchId, staffId: full.doctorStaffIds.omar, daysAhead: 3 };
    const noSlot = await rt.dispatch.execute(ctx, call('check_availability', base));
    const withSlot = await rt.dispatch.execute(ctx, call('check_availability', { ...base, slotMinutes: 45 }));
    observed.wa_avail_noslot = noSlot; observed.wa_avail_slot45 = withSlot;
    expect((noSlot.days as any[])[0].slots).toHaveLength(1);
    expect((withSlot.days as any[])[0].slots.length).toBeGreaterThanOrEqual(8);
  });

  // ── booking binds the server-side customer ────────────────────────────────
  it('book_appointment books for the SERVER-bound customer even when the model supplies another patient\'s id', async () => {
    const { full } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const avail = await rt.dispatch.execute(ctx, call('check_availability', {
      branchId: full.branchId, staffId: full.doctorStaffIds.omar, daysAhead: 3, slotMinutes: 45,
    }));
    const slot = (avail.days as any[])[0].slots[1].startAt;
    const res = await rt.dispatch.execute(ctx, call('book_appointment', {
      branchId: full.branchId, staffId: full.doctorStaffIds.omar, startAt: slot,
      serviceIds: [full.serviceIds.cleaning], customerId: full.patientIds.y, hasInsurance: false,
    }));
    observed.wa_book = res;
    expect(res.success).toBe(true);
    const row = (await q(`SELECT "customerId" FROM appointments WHERE id=$1`, [res.appointmentId]))[0];
    expect(row.customerId).toBe(full.patientIds.x); // NOT y
  });

  // ── F-03 / F-04 ────────────────────────────────────────────────────────────
  it('F-03 + F-04 DEFECT: patient X cancels patient Y\'s appointment from ONE message — the model redeems its own confirmation token, no user reply in between', async () => {
    const { full } = rt.seed;
    const apptY = await newAppointment(full.patientIds.y, 72);
    reactive.setHandler((req) => {
      const results = toolResultsIn(req).filter((r) => r.name === 'cancel_appointment');
      if (results.length === 0) return { toolCalls: [call('cancel_appointment', { appointmentId: apptY, reason: 'patient request' })] };
      const last = results[results.length - 1].json;
      if (last?.confirmationRequired) {
        return { toolCalls: [call('cancel_appointment', { appointmentId: apptY, confirmationToken: last.confirmationToken })] };
      }
      return { content: 'Done — the appointment is cancelled.' };
    });

    const before = await statusOf(apptY);
    const r = await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, `please cancel appointment ${apptY}`);
    const after = await statusOf(apptY);
    const ledger = await q(
      `SELECT status FROM ai_tool_calls WHERE tenant_id=$1 AND tool_name='cancel_appointment' ORDER BY created_at DESC LIMIT 5`,
      [full.tenantId],
    );
    const userMsgs = await q(
      `SELECT count(*)::int c FROM ai_messages m
        WHERE m."tenantId"=$1 AND m.role='user' AND m.content LIKE $2`,
      [full.tenantId, `%${apptY}%`],
    );
    observed.wa_cancel_idor = { before, after, ledger, replies: r.replies, tools: r.tools, userMessagesCarryingId: userMsgs[0].c };

    expect(before.status).toBe('CONFIRMED');
    expect(after.status).toBe('CANCELLED'); // Y's appointment, cancelled by X
    expect(r.tools.filter((t) => t === 'cancel_appointment').length).toBe(2); // token issued, then redeemed
    expect(ledger.map((l: any) => l.status)).toEqual(expect.arrayContaining(['REFUSED', 'SUCCEEDED']));
    expect(userMsgs[0].c).toBe(1); // exactly one user message — no human confirmation turn happened
  });

  it('F-03 DEFECT: reschedule has the same hole — X moves Y\'s appointment to a time the model chose', async () => {
    const { full } = rt.seed;
    const apptY = await newAppointment(full.patientIds.y, 96);
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const avail = await rt.dispatch.execute(ctx, call('check_availability', {
      branchId: full.branchId, staffId: full.doctorStaffIds.omar, daysAhead: 3, slotMinutes: 45,
    }));
    const target = (avail.days as any[])[0].slots[3].startAt;
    reactive.setHandler((req) => {
      const results = toolResultsIn(req).filter((r) => r.name === 'reschedule_appointment');
      if (results.length === 0) return { toolCalls: [call('reschedule_appointment', { appointmentId: apptY, newStartAt: target })] };
      const last = results[results.length - 1].json;
      if (last?.confirmationRequired) {
        return { toolCalls: [call('reschedule_appointment', { appointmentId: apptY, newStartAt: target, confirmationToken: last.confirmationToken })] };
      }
      return { content: 'Moved.' };
    });
    const before = await statusOf(apptY);
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, `move appointment ${apptY} earlier`);
    const after = await statusOf(apptY);
    observed.wa_reschedule_idor = { before, after, target };
    expect(new Date(after.start_at).toISOString()).toBe(new Date(target).toISOString());
    expect(new Date(before.start_at).toISOString()).not.toBe(new Date(after.start_at).toISOString());
  });

  // ── F-05 ───────────────────────────────────────────────────────────────────
  it('F-05 DEFECT: the clinic\'s cancellation_hours=24 policy is ignored — Y cancels their OWN appointment that starts in 2 hours', async () => {
    const { full } = rt.seed;
    expect((await q(`SELECT cancellation_hours FROM tenant_settings WHERE tenant_id=$1`, [full.tenantId]))[0].cancellation_hours).toBe(24);
    const soon = await newAppointment(full.patientIds.y, 2);
    reactive.setHandler((req) => {
      const results = toolResultsIn(req).filter((r) => r.name === 'cancel_appointment');
      if (results.length === 0) return { toolCalls: [call('cancel_appointment', { appointmentId: soon })] };
      const last = results[results.length - 1].json;
      if (last?.confirmationRequired) return { toolCalls: [call('cancel_appointment', { appointmentId: soon, confirmationToken: last.confirmationToken })] };
      return { content: 'Cancelled.' };
    });
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.y, 'cancel my appointment');
    const after = await statusOf(soon);
    observed.wa_policy = { after };
    expect(after.status).toBe('CANCELLED'); // policy says free cancellation only >=24h ahead
  });

  // ── no listing tool + toolset ─────────────────────────────────────────────
  it('F-06: the WhatsApp toolset has no way to list a patient\'s own appointments, so the model must be handed an id by the patient', async () => {
    const { full } = rt.seed;
    reactive.setHandler(() => ({ content: 'hi' }));
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, 'hello');
    const names = (reactive.capturedRequests[0].tools ?? []).map((t) => t.name).sort();
    observed.wa_toolset = names;
    expect(names).toEqual([
      'book_appointment', 'cancel_appointment', 'check_availability', 'get_branch_info', 'get_customer_insurance_status',
      'get_doctor_schedule', 'list_clinic_branches', 'list_clinic_doctors', 'list_clinic_services',
      'request_human_handover', 'reschedule_appointment',
    ]);
    expect(names.some((n) => /appointments?$/.test(n) && /^(list|get|find|my)/.test(n))).toBe(false);
    void randomUUID;
  });
});
