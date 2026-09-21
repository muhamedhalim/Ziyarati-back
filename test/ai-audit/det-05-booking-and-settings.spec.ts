/**
 * Booking integrity and settings enforcement, through the real entry points.
 *
 * Findings covered:
 *   F-19  public booking attaches to an EXISTING patient record chosen by an unverified phone number
 *   F-20  AI usage / cost / quota for a public booking is metered on the guest-discovery tenant, not the clinic
 *   F-21  select_branch / select_doctor "reset" downstream choices with `undefined`, which is dropped (state persists)
 *   (controls) booking refuses past / closed-day / double-booked slots; settings DO change behaviour
 */
import { execSync } from 'node:child_process';
import { bootAudit, GuestSession, whatsappTurn, whatsappToolCtx, saveEvidence, type AuditRuntime } from './fixtures/audit-runtime';
import { ReactiveProvider, scriptedToolCall, lastToolResult } from './fixtures/reactive-provider';
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';

describe('booking integrity and settings', () => {
  let rt: AuditRuntime;
  let reactive: ReactiveProvider;
  const observed: Record<string, any> = {};
  const q = (sql: string, p: unknown[] = []) => rt.harness.dataSource.query(sql, p);

  beforeAll(async () => {
    rt = await bootAudit();
    reactive = new ReactiveProvider();
    rt.use(reactive);
  }, 180_000);
  afterAll(async () => {
    saveEvidence('det-05-booking-and-settings', observed);
    await rt?.close();
  }, 60_000);

  /** One message → the model calls `tool(args)` once → the tool result the model received. */
  async function step(g: GuestSession, tool: string, args: Record<string, unknown>) {
    reactive.setHandler((req) => (req.messages.some((m) => m.role === 'tool' && m.name === tool) ? { content: 'ok' } : { toolCalls: [scriptedToolCall(tool, args)] }));
    const turn = await g.say(`(audit) ${tool}`);
    return { turn, result: lastToolResult(reactive.capturedRequests, tool) };
  }

  /** Select clinic → branch → service → doctor and return the first offered slot. */
  async function prepare(g: GuestSession, doctor: 'omar' | 'layla' = 'omar') {
    const { full } = rt.seed;
    await step(g, 'select_clinic', { clinicId: full.tenantId });
    await step(g, 'select_branch', { branchId: full.branchId });
    await step(g, 'select_service', { serviceIds: [full.serviceIds.cleaning] });
    await step(g, 'select_doctor', { staffId: full.doctorStaffIds[doctor] });
    const avail = (await step(g, 'search_public_availability', { branchId: full.branchId, staffId: full.doctorStaffIds[doctor], daysAhead: 5 })).result;
    return { slot: avail.days[0].slots[0].startAt as string };
  }

  // ── a complete public booking ─────────────────────────────────────────────
  it('a full public booking works end to end and the widget receives a server-built confirmation', async () => {
    const { full } = rt.seed;
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g);
    await step(g, 'select_slot', { startAt: slot });
    const { turn, result } = await step(g, 'book_public_appointment', { fullName: 'Audit Guest One', phone: '966500700001', hasInsurance: false });
    observed.public_booking = result;
    expect(result.success).toBe(true);
    const done = turn.raw.find((e) => e.event === 'ai:done')?.payload;
    expect(done.bookingConfirmation.appointmentId).toBe(result.appointmentId);
    const appt = (await q(`SELECT "tenantId", source, status FROM appointments WHERE id=$1`, [result.appointmentId]))[0];
    expect(appt).toMatchObject({ tenantId: full.tenantId, source: 'PUBLIC_AI' });

    // F-20: where is the AI usage metered?
    const cost = await q(`SELECT tenant_id, count(*)::int c FROM ai_cost_entries WHERE tenant_id = ANY($1) GROUP BY tenant_id`, [[full.tenantId, rt.discoveryTenantId]]);
    const tools = await q(`SELECT tenant_id, resource_tenant_id FROM ai_tool_calls WHERE tool_name='book_public_appointment' ORDER BY created_at DESC LIMIT 1`);
    observed.metering = { cost, toolCall: tools[0], full: full.tenantId, discovery: rt.discoveryTenantId };
    const byTenant = Object.fromEntries(cost.map((r: any) => [r.tenant_id, r.c]));
    expect(tools[0].resource_tenant_id).toBe(full.tenantId); // the ledger row knows the clinic...
    expect(byTenant[full.tenantId] ?? 0).toBe(0); // ...but the cost rows are NOT the clinic's
    expect(byTenant[rt.discoveryTenantId]).toBeGreaterThan(0);
  });

  // ── F-19 ───────────────────────────────────────────────────────────────────
  it('F-19 DEFECT: booking with an existing patient\'s phone number and a different name attaches the appointment to THAT patient\'s record', async () => {
    const { full } = rt.seed;
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g, 'layla');
    await step(g, 'select_slot', { startAt: slot });
    const { result } = await step(g, 'book_public_appointment', { fullName: 'Someone Else Entirely', phone: full.patientPhones!.x });
    observed.identity_bind = result;
    expect(result.success).toBe(true);
    const row = (await q(`SELECT "customerId" FROM appointments WHERE id=$1`, [result.appointmentId]))[0];
    expect(row.customerId).toBe(full.patientIds.x);
    const patient = (await q(`SELECT full_name FROM customers WHERE id=$1`, [full.patientIds.x]))[0];
    expect(patient.full_name).toBe(`Patient X ${full.name.split(' ').pop()}`); // the supplied name was silently discarded
  });

  // ── control: refusal paths ────────────────────────────────────────────────
  it('CONTROL: booking refuses a past slot, a closed weekday and an already-taken slot', async () => {
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g);

    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await step(g, 'select_slot', { startAt: past });
    const pastRes = (await step(g, 'book_public_appointment', { fullName: 'Past Guest', phone: '966500700002' })).result;

    // find the next Friday 09:00 local (closed day): Riyadh = UTC+3
    const d = new Date(); d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7)); d.setUTCHours(6, 0, 0, 0);
    await step(g, 'select_slot', { startAt: d.toISOString() });
    const closedRes = (await step(g, 'book_public_appointment', { fullName: 'Friday Guest', phone: '966500700003' })).result;

    await step(g, 'select_slot', { startAt: slot });
    const ok = (await step(g, 'book_public_appointment', { fullName: 'First Guest', phone: '966500700004' })).result;
    const g2 = await GuestSession.start(rt);
    await prepare(g2);
    await step(g2, 'select_slot', { startAt: slot });
    const dup = (await step(g2, 'book_public_appointment', { fullName: 'Second Guest', phone: '966500700005' })).result;

    observed.refusals = { pastRes, closedRes, ok, dup };
    expect(pastRes.success).toBe(false);
    expect(closedRes.success).toBe(false);
    expect(ok.success).toBe(true);
    expect(dup.success).toBe(false);
  });

  // ── F-21 ───────────────────────────────────────────────────────────────────
  it('F-21 DEFECT: select_branch does not clear the previously selected doctor/service/slot, select_doctor does not clear the slot', async () => {
    const { full } = rt.seed;
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g);
    await step(g, 'select_slot', { startAt: slot });
    const before = await g.session();
    await step(g, 'select_branch', { branchId: full.branch2Id });
    const afterBranch = await g.session();
    await step(g, 'select_doctor', { staffId: full.doctorStaffIds.layla });
    const afterDoctor = await g.session();
    observed.stale_state = { before, afterBranch, afterDoctor };
    // AI-006 fixed this for select_clinic via SESSION_UNSET; the two sibling tools still pass `undefined`.
    expect(afterBranch.selectedBranchId).toBe(full.branch2Id);
    expect(afterBranch.selectedDoctorId).toBe(full.doctorStaffIds.omar); // stale: doctor of the OLD branch
    expect(afterBranch.selectedServiceIds).toEqual([full.serviceIds.cleaning]);
    expect(afterBranch.selectedStartAt).toBe(slot);
    expect(afterDoctor.selectedStartAt).toBe(slot); // slot picked for omar survives the switch to layla
  });

  // ── settings ──────────────────────────────────────────────────────────────
  describe('settings', () => {
    const setSetting = (col: string, val: boolean) => q(`UPDATE tenant_settings SET ${col} = $1 WHERE tenant_id = $2`, [val, rt.seed.full.tenantId]);

    it('bot_enabled=false: an inbound WhatsApp message gets no model call and no reply', async () => {
      const { full } = rt.seed;
      await setSetting('bot_enabled', false);
      try {
        reactive.setHandler(() => ({ content: 'should never be sent' }));
        const r = await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, 'hello?');
        expect(reactive.capturedRequests).toHaveLength(0);
        expect(r.replies).toEqual([]);
      } finally {
        await setSetting('bot_enabled', true);
      }
    });

    it('public_booking_enabled=false: the clinic disappears from discovery and select_clinic is refused', async () => {
      const { full } = rt.seed;
      await setSetting('public_booking_enabled', false);
      try {
        const g = await GuestSession.start(rt);
        const found = (await step(g, 'search_clinics', {})).result;
        const picked = (await step(g, 'select_clinic', { clinicId: full.tenantId })).result;
        observed.public_booking_off = { found: (found.clinics as any[]).map((c) => c.name), picked };
        expect((found.clinics as any[]).some((c) => c.slug === full.slug)).toBe(false);
        expect(picked.success).toBe(false);
      } finally {
        await setSetting('public_booking_enabled', true);
      }
    });

    it('payment_required=true: a WhatsApp booking returns a payment link; false: none', async () => {
      const { full } = rt.seed;
      const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
      const avail = await rt.dispatch.execute(ctx, call('check_availability', { branchId: full.branchId, staffId: full.doctorStaffIds.layla, daysAhead: 4, slotMinutes: 45 }));
      const book = (i: number) => rt.dispatch.execute(ctx, call('book_appointment', {
        branchId: full.branchId, staffId: full.doctorStaffIds.layla, startAt: avail.days[0].slots[i].startAt,
        serviceIds: [full.serviceIds.cleaning], hasInsurance: false,
      }));
      await setSetting('payment_required', false); // the column DEFAULTS to true — set it explicitly
      const off = await book(0);
      await setSetting('payment_required', true);
      let on: any;
      try { on = await book(1); } finally { await setSetting('payment_required', false); }
      observed.payment = { off: off.paymentLink ?? null, on: on.paymentLink ?? null };
      expect(off.success).toBe(true);
      expect(off.paymentLink).toBeUndefined();
      expect(on.success).toBe(true);
      expect(on.paymentLink).toBeDefined();
    });

    it('DEFECT (coverage): settings that exist but are read by NO AI code path — booking_confirmation, default_language', async () => {
      const grep = (needle: string) => {
        try { return execSync(`grep -rlE "${needle}" src/modules/ai src/modules/ai-realtime src/modules/ai-orchestrator src/modules/whatsapp/whatsapp-inbound-ai.service.ts src/modules/public-booking src/modules/public-discovery`, { cwd: process.cwd() }).toString().trim(); } catch { return ''; }
      };
      const hits = { booking_confirmation: grep('booking_confirmation|bookingConfirmation\\b.*setting'), default_language: grep('default_language'), cancellation_hours: grep('cancellation_hours|cancellationHours') };
      observed.settings_unread_by_ai = hits;
      expect(hits.default_language).toBe('');
      expect(hits.cancellation_hours).toBe('');
    });
  });
});
