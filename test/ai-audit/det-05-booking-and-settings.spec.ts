/**
 * Booking integrity and settings enforcement, through the real entry points.
 *
 * Findings covered:
 *   F-19  public booking attached to an EXISTING patient record chosen by an unverified phone number — FIXED, Phase 2
 *   F-20  AI usage / cost for a public booking was metered on the guest-discovery tenant, not the clinic — FIXED in Phase 3
 *   F-21  select_branch / select_doctor "reset" downstream choices with `undefined`, which is dropped (state persists)
 *   (controls) booking refuses past / closed-day / double-booked slots; settings DO change behaviour
 */
import { execSync } from 'node:child_process';
import { bootAudit, GuestSession, whatsappTurn, whatsappToolCtx, saveEvidence, type AuditRuntime } from './fixtures/audit-runtime';
import { ReactiveProvider, scriptedToolCall, lastToolResult } from './fixtures/reactive-provider';
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';
import { CustomerService } from '../../src/modules/crm/customer.service';

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
    const quota = async () =>
      Number((await q(`SELECT COALESCE(SUM(ai_tokens_used::numeric), 0) AS n FROM subscription_usage WHERE tenant_id = $1`, [full.tenantId]))[0].n);
    const quotaBefore = await quota();
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

    // F-20: where is the AI usage metered? (was: every row on the discovery tenant, none on the clinic)
    const byTenant = async (sql: string) =>
      Object.fromEntries((await q(sql, [g.conversationId])).map((r: any) => [r.tenant, r.c]));
    const cost = await byTenant(`SELECT tenant_id AS tenant, count(*)::int c FROM ai_cost_entries WHERE ai_conversation_id = $1 GROUP BY tenant_id`);
    const metrics = await byTenant(`SELECT "tenantId" AS tenant, count(*)::int c FROM ai_execution_metrics WHERE ai_conversation_id = $1 GROUP BY "tenantId"`);
    const tools = await q(`SELECT tenant_id, resource_tenant_id FROM ai_tool_calls WHERE tool_name='book_public_appointment' ORDER BY created_at DESC LIMIT 1`);
    observed.metering = { cost, metrics, toolCall: tools[0], full: full.tenantId, discovery: rt.discoveryTenantId };
    expect(tools[0].resource_tenant_id).toBe(full.tenantId); // the ledger row knew the clinic...
    // ...and now the cost and metrics rows do too, from the turn AFTER the clinic was chosen.
    // (The turn that CHOOSES it was priced before the choice existed, so it stays on the discovery tenant.)
    expect(cost[full.tenantId]).toBeGreaterThan(0);
    expect(cost[full.tenantId]).toBeGreaterThan(cost[rt.discoveryTenantId] ?? 0);
    expect(metrics[full.tenantId]).toBeGreaterThan(0);
    // the clinic's usage log (what its AI analytics read) records the public turns, with no agent
    const usage = await q(`SELECT total_requests, total_tokens FROM ai_usage_logs WHERE "tenantId" = $1 AND "agentId" IS NULL`, [full.tenantId]);
    expect(Number(usage[0]?.total_requests ?? 0)).toBeGreaterThan(0);
    expect(Number(usage[0]?.total_tokens ?? 0)).toBeGreaterThan(0);
    // What did NOT move: the clinic's plan-quota counter. Charging a clinic's purchased AI tokens for
    // anonymous visitors is a commercial decision, not a bookkeeping fix (Phase 3 log).
    expect(await quota()).toBe(quotaBefore);
  });

  it('F-20 (found while proving it): agent-less turns accumulate into ONE usage row per tenant-month — the write used to be skipped for every one of them', async () => {
    const { full } = rt.seed;
    const rows = () =>
      q(`SELECT total_requests, total_tokens FROM ai_usage_logs WHERE "tenantId" = $1 AND "agentId" IS NULL`, [full.tenantId]);
    const before = await rows();
    const g = await GuestSession.start(rt);
    await step(g, 'select_clinic', { clinicId: full.tenantId }); // from here on the turns are the clinic's
    reactive.setHandler(() => ({ content: 'ok' }));
    await g.say('what time do you open?');
    await g.say('and on Saturday?');
    const after = await rows();
    // (the UPDATE-then-INSERT path: the first agent-less turn INSERTS, the later ones UPDATE the same row)
    expect(after).toHaveLength(1);
    expect(Number(after[0].total_requests) - Number(before[0]?.total_requests ?? 0)).toBe(2);
    expect(Number(after[0].total_tokens) - Number(before[0]?.total_tokens ?? 0)).toBeGreaterThan(0);
  });

  // ── F-19 (fixed in Phase 2) ────────────────────────────────────────────────
  it('F-19 regression: booking with an existing patient\'s phone number and a DIFFERENT name never touches that patient\'s record — it gets a record of its own, under the name given', async () => {
    const { full } = rt.seed;
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g, 'layla');
    await step(g, 'select_slot', { startAt: slot });
    const { result } = await step(g, 'book_public_appointment', { fullName: 'Someone Else Entirely', phone: full.patientPhones!.x });
    observed.identity_bind = result;
    expect(result.success).toBe(true);
    const row = (await q(`SELECT "customerId" FROM appointments WHERE id=$1`, [result.appointmentId]))[0];
    expect(row.customerId).not.toBe(full.patientIds.x); // NOT patient X's record
    const created = (await q(`SELECT full_name, phone, source, "tenantId" FROM customers WHERE id=$1`, [row.customerId]))[0];
    expect(created).toMatchObject({ full_name: 'Someone Else Entirely', phone: full.patientPhones!.x, source: 'public_ai', tenantId: full.tenantId });
    // X is exactly as they were: same name, and no appointment was added to their record.
    const patient = (await q(`SELECT full_name FROM customers WHERE id=$1`, [full.patientIds.x]))[0];
    expect(patient.full_name).toBe(`Patient X ${full.name.split(' ').pop()}`);
    const onX = await q(`SELECT count(*)::int c FROM appointments WHERE "customerId"=$1 AND id=$2`, [full.patientIds.x, result.appointmentId]);
    expect(onX[0].c).toBe(0);
  });

  it('F-19: the SAME person (phone + name, however the name is spaced or cased) is recognised — a returning public patient is not duplicated', async () => {
    const { full } = rt.seed;
    const phone = '966500700777';
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g, 'omar');
    await step(g, 'select_slot', { startAt: slot });
    const first = (await step(g, 'book_public_appointment', { fullName: 'Nour Al-Din Haddad', phone })).result;
    expect(first.success).toBe(true);
    const firstCustomer = (await q(`SELECT "customerId" FROM appointments WHERE id=$1`, [first.appointmentId]))[0].customerId;
    const sameName = await q(
      `SELECT count(*)::int c FROM customers WHERE "tenantId"=$1 AND phone=$2`, [full.tenantId, phone],
    );
    expect(sameName[0].c).toBe(1);
    const again = await rt.harness.app.get(CustomerService).findOrCreateForBooking(full.tenantId, { fullName: '  nour   AL-DIN  haddad ', phone });
    expect(again.id).toBe(firstCustomer); // same person, however typed
    const other = await rt.harness.app.get(CustomerService).findOrCreateForBooking(full.tenantId, { fullName: 'Nour Haddad Jr', phone });
    expect(other.id).not.toBe(firstCustomer); // a different name on a shared number is a different person
    const total = await q(`SELECT count(*)::int c FROM customers WHERE "tenantId"=$1 AND phone=$2`, [full.tenantId, phone]);
    expect(total[0].c).toBe(2);
    observed.identity_same_person = { firstCustomer, again: again.id, other: other.id };
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
  it('F-21 FIXED: select_branch clears the previously selected doctor/service/slot', async () => {
    const { full } = rt.seed;
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g);
    await step(g, 'select_slot', { startAt: slot });
    const before = await g.session();
    // Both seeded doctors work at `branchId` only — `branch2Id` has none —
    // so this switch is a pure test of the RESET, not a re-validated pick.
    await step(g, 'select_branch', { branchId: full.branch2Id });
    const afterBranch = await g.session();
    observed.stale_state = { before, afterBranch };
    expect(before.selectedDoctorId).toBe(full.doctorStaffIds.omar);
    expect(before.selectedServiceIds).toEqual([full.serviceIds.cleaning]);
    expect(before.selectedStartAt).toBe(slot);
    // FIXED: SESSION_UNSET (not `undefined`) now genuinely clears these on a
    // branch switch — the same mechanism AI-006 already used for
    // select_clinic. A stale doctor/service/slot can no longer survive into
    // the new branch's context.
    expect(afterBranch.selectedBranchId).toBe(full.branch2Id);
    expect(afterBranch.selectedDoctorId).toBeNull();
    expect(afterBranch.selectedServiceIds).toBeNull();
    expect(afterBranch.selectedStartAt).toBeNull();
  });

  it('F-21 FIXED: select_doctor clears the previously selected slot', async () => {
    const { full } = rt.seed;
    const g = await GuestSession.start(rt);
    const { slot } = await prepare(g, 'omar');
    await step(g, 'select_slot', { startAt: slot });
    const before = await g.session();
    expect(before.selectedStartAt).toBe(slot);
    // Switching doctor WITHIN the same branch (both omar and layla work at
    // `branchId`) isolates select_doctor's own reset from select_branch's.
    await step(g, 'select_doctor', { staffId: full.doctorStaffIds.layla });
    const afterDoctor = await g.session();
    observed.stale_slot_after_doctor_switch = { before, afterDoctor };
    // FIXED: the new doctor's calendar differs, so the slot picked for the
    // OLD doctor is genuinely cleared — not silently carried over to a doctor
    // it was never checked against.
    expect(afterDoctor.selectedDoctorId).toBe(full.doctorStaffIds.layla);
    expect(afterDoctor.selectedStartAt).toBeNull();
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
        branchId: full.branchId, staffId: full.doctorStaffIds.layla, startAt: (avail.days as Array<{ slots: Array<{ startAt: string }> }>)[0].slots[i].startAt,
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

    it('DEFECT (coverage): settings that exist but are read by NO AI code path — booking_confirmation, default_language (cancellation_hours is read since F-05)', async () => {
      const grep = (needle: string) => {
        try { return execSync(`grep -rlE "${needle}" src/modules/ai src/modules/ai-realtime src/modules/ai-orchestrator src/modules/whatsapp/whatsapp-inbound-ai.service.ts src/modules/public-booking src/modules/public-discovery`, { cwd: process.cwd() }).toString().trim(); } catch { return ''; }
      };
      const hits = { booking_confirmation: grep('booking_confirmation|bookingConfirmation\\b.*setting'), default_language: grep('default_language'), cancellation_hours: grep('cancellation_hours|cancellationHours') };
      observed.settings_unread_by_ai = hits;
      expect(hits.default_language).toBe('');
      // F-05 (fixed in Phase 2): the AI cancel/reschedule path now applies the clinic's change window.
      expect(hits.cancellation_hours).toContain('ai-tool-dispatch.service.ts');
    });
  });
});
