/**
 * Phase 2 regression suite — who may change an appointment, and how it is confirmed.
 *
 *   F-03  cancel/reschedule accepted any appointment id in the tenant
 *   F-04  the "confirmation" could be redeemed by the model in the very turn it was asked for
 *   F-05  the clinic's cancellation_hours was never applied on the AI path
 *   F-06/F-27  no tool listed the patient's own appointments and a real "yes" could not complete
 *
 * The "model" is a deterministic double that behaves the way a real one is forced to: it only sees
 * the conversation's user/assistant messages and THIS turn's tool results (tool results are not
 * replayed), so a confirmation that depended on the model carrying a token across turns would fail
 * here exactly as it did live. What these tests prove is what the SERVER enforces — nothing here says
 * how a real model behaves; that is the live suite's job (run after Phase 4, per the fix plan).
 *
 * Real path where it matters (`WhatsappInboundAiService` → orchestrator → `AiExecutionService` →
 * dispatcher, real Postgres, real per-tenant bot actor); the dispatcher is called directly for the
 * matrix cases, with a `turnId` per simulated user message.
 */
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';
import {
  bootAudit,
  ownerPrincipal,
  whatsappTurn,
  whatsappToolCtx,
  saveEvidence,
  type AuditRuntime,
} from './fixtures/audit-runtime';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { ReactiveProvider, toolResultsIn } from './fixtures/reactive-provider';
import type { AiCompletionRequest } from '../../src/modules/ai/providers/ai-provider.interface';

const NOT_YOURS = /belongs to this patient/;

/** A cancel flow as a real model would run it: find the id, ask, and only then act. */
const cancelModel = (req: AiCompletionRequest) => {
  const results = toolResultsIn(req);
  const mine = results.filter((r) => r.name === 'list_my_appointments').pop()?.json;
  const cancel = results.filter((r) => r.name === 'cancel_appointment').pop()?.json;
  if (!mine) return { toolCalls: [call('list_my_appointments', {})] };
  const id = mine.appointments?.[0]?.appointmentId;
  if (!id) return { content: 'You have no upcoming appointment.' };
  if (!cancel) return { toolCalls: [call('cancel_appointment', { appointmentId: id })] };
  if (cancel.confirmationRequired) {
    return {
      content: `Cancel your appointment on ${cancel.appointment.local.date} at ${cancel.appointment.local.time}? Please confirm.`,
    };
  }
  return { content: cancel.success ? 'Your appointment is cancelled.' : `I could not do that: ${cancel.error}` };
};

describe('Phase 2 — appointment changes: ownership, change window, confirmation', () => {
  let rt: AuditRuntime;
  let reactive: ReactiveProvider;
  const observed: Record<string, any> = {};
  const q = (sql: string, p: unknown[] = []) => rt.harness.dataSource.query(sql, p);
  const sessions = () => rt.harness.app.get(ConversationSessionService);
  let turnSeq = 0;
  const turn = () => `turn-${(turnSeq += 1)}`;

  /**
   * A CONFIRMED appointment for `customerId` with omar, starting about `hoursAhead` from now (negative = past).
   * The double-booking guard is a DB exclusion constraint, so a slot an earlier test already holds is skipped
   * forward an hour rather than colliding.
   */
  async function newAppointment(customerId: string, hoursAhead: number, status = 'CONFIRMED'): Promise<string> {
    const { full } = rt.seed;
    for (let bump = 0; bump < 12; bump += 1) {
      const start = new Date(Date.now() + (hoursAhead + bump) * 3_600_000);
      start.setUTCMinutes(0, 0, 0);
      const end = new Date(start.getTime() + 45 * 60_000);
      try {
        const rows = await q(
          `INSERT INTO appointments (status,payment_status,currency,source,start_at,end_at,"tenantId","branchId","customerId","staffId")
           VALUES ($1,'UNPAID','SAR','MANUAL',$2,$3,$4,$5,$6,$7) RETURNING id`,
          [status, start.toISOString(), end.toISOString(), full.tenantId, full.branchId, customerId, full.doctorStaffIds.omar],
        );
        return rows[0].id;
      } catch (err) {
        if (!/appointments_no_overlap/.test(String(err))) throw err;
      }
    }
    throw new Error('no free slot for the test appointment');
  }
  /** A patient nobody else has touched: created by the real WhatsApp bridge on a first message. */
  async function freshPatient(): Promise<{ id: string; phone: string }> {
    const { full } = rt.seed;
    const phone = `9665${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    reactive.setHandler(() => ({ content: 'hello' }));
    await whatsappTurn(rt, full.tenantId, phone, 'hello');
    const rows = await q(`SELECT id FROM customers WHERE "tenantId"=$1 AND phone=$2`, [full.tenantId, phone]);
    return { id: rows[0].id, phone };
  }
  const row = async (id: string) => (await q(`SELECT status, start_at FROM appointments WHERE id=$1`, [id]))[0];
  const iso = (d: Date | string) => new Date(d).toISOString();
  const ledger = (tenantId: string, tool: string) =>
    q(`SELECT status FROM ai_tool_calls WHERE tenant_id=$1 AND tool_name=$2 ORDER BY created_at ASC`, [tenantId, tool]).then(
      (rows: { status: string }[]) => rows.map((r) => r.status),
    );
  /** The AI conversation the most recent tool call of this tenant ran in. */
  async function lastConversation(tenantId: string): Promise<string> {
    const rows = await q(`SELECT ai_conversation_id FROM ai_tool_calls WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [tenantId]);
    return rows[0].ai_conversation_id as string;
  }

  beforeAll(async () => {
    rt = await bootAudit();
    reactive = new ReactiveProvider();
    rt.use(reactive);
  }, 180_000);
  afterAll(async () => {
    saveEvidence('det-09-appointment-changes', observed);
    await rt?.close();
  }, 60_000);

  // ── the flow a patient actually goes through ────────────────────────────────
  it('F-27/F-06: a real cancel takes two messages — the first only asks, the "yes" in the NEXT message does it — with no token carried by the model', async () => {
    const { full } = rt.seed;
    const patient = await freshPatient();
    const appt = await newAppointment(patient.id, 72);
    reactive.setHandler(cancelModel);

    const first = await whatsappTurn(rt, full.tenantId, patient.phone, 'I want to cancel my appointment');
    const conv = await lastConversation(full.tenantId);
    const afterFirst = await row(appt);
    const pendingAfterFirst = (await sessions().get(full.tenantId, conv)).pendingConfirmations ?? {};
    const askedAbout = lastResult(reactive, 'cancel_appointment');

    expect(afterFirst.status).toBe('CONFIRMED'); // asking changed nothing
    expect(first.replies.join(' ')).toMatch(/Please confirm/);
    expect(Object.keys(pendingAfterFirst)).toEqual([`cancel:${appt}`]);
    expect(pendingAfterFirst[`cancel:${appt}`].turnId).toBeTruthy(); // the proposal remembers the message it was made in
    expect(askedAbout).toMatchObject({ success: false, confirmationRequired: true });
    // What the patient is asked to confirm is read from the appointment row, in the branch's own zone.
    expect(askedAbout.appointment).toMatchObject({ appointmentId: appt, status: 'CONFIRMED' });
    expect(askedAbout.appointment.local.timezone).toBeTruthy();

    reactive.setHandler(cancelModel); // a fresh turn: the model has no memory of the token
    const second = await whatsappTurn(rt, full.tenantId, patient.phone, 'yes');
    const afterSecond = await row(appt);
    const pendingAfterSecond = (await sessions().get(full.tenantId, conv)).pendingConfirmations ?? {};

    expect(afterSecond.status).toBe('CANCELLED');
    expect(second.replies.join(' ')).toMatch(/is cancelled/);
    expect(pendingAfterSecond[`cancel:${appt}`]).toBeUndefined(); // one "yes", one execution
    expect(await ledger(full.tenantId, 'cancel_appointment')).toEqual(expect.arrayContaining(['REFUSED', 'SUCCEEDED']));
    observed.flow = { pendingAfterFirst, askedAbout, afterSecond };
  });

  it('F-04: a model that redeems its own confirmation in the SAME turn is refused every time — only a later message can confirm', async () => {
    const { full } = rt.seed;
    const appt = await newAppointment(full.patientIds.y, 74);
    reactive.setHandler((req) => {
      const cancels = toolResultsIn(req).filter((r) => r.name === 'cancel_appointment');
      if (cancels.length >= 3) return { content: 'done' };
      const last = cancels[cancels.length - 1]?.json;
      return { toolCalls: [call('cancel_appointment', { appointmentId: appt, confirmationToken: last?.confirmationToken })] };
    });
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.y, 'cancel appointment please');
    const results = toolResultsIn(reactive.capturedRequests[reactive.capturedRequests.length - 1]).map((r) => r.json);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ success: false, confirmationRequired: true });
    expect(results[0].confirmationToken).toBeTruthy(); // it even HAS the token…
    expect(results[1]).toMatchObject({ success: false, confirmationRequired: true, awaitingPatientReply: true });
    expect(results[2]).toMatchObject({ success: false, awaitingPatientReply: true }); // …and still cannot use it
    expect((await row(appt)).status).toBe('CONFIRMED');
    observed.same_turn = results;
  });

  it('F-04: the confirmation is for THAT change — a "yes" to a move to 10:00 cannot be spent on a move to a different time', async () => {
    const { full } = rt.seed;
    const appt = await newAppointment(full.patientIds.y, 76);
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.y);
    const avail = await rt.dispatch.execute(ctx, call('check_availability', { branchId: full.branchId, staffId: full.doctorStaffIds.omar, daysAhead: 3, slotMinutes: 45 }));
    const slots = (avail.days as any[]).flatMap((d) => d.slots.map((s: any) => s.startAt as string));
    const [timeA, timeB] = [slots[2], slots[4]];
    const before = await row(appt);
    const move = (turnId: string, newStartAt: string) =>
      rt.dispatch.execute({ ...ctx, turnId }, call('reschedule_appointment', { appointmentId: appt, newStartAt }));

    const proposeA = await move('m1', timeA);
    const wrongTime = await move('m2', timeB); // next message, but a DIFFERENT time than the one proposed
    const unchanged = await row(appt);
    // Same instant written another way is still the same change: +00:00 instead of Z.
    const confirmB = await move('m3', iso(timeB).replace('Z', '+00:00'));
    const moved = await row(appt);

    expect(proposeA).toMatchObject({ success: false, confirmationRequired: true });
    expect(wrongTime).toMatchObject({ success: false, confirmationRequired: true }); // a NEW question, not an execution
    expect(iso(unchanged.start_at)).toBe(iso(before.start_at));
    expect(confirmB.success).toBe(true);
    expect(iso(moved.start_at)).toBe(iso(timeB));
    observed.bound = { timeA, timeB, proposeA, wrongTime, confirmB };
  });

  it('F-04: a proposal that has expired is not a confirmation, and a caller that cannot prove its turn can never confirm', async () => {
    const { full } = rt.seed;
    const appt = await newAppointment(full.patientIds.y, 78);
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.y);

    await rt.dispatch.execute({ ...ctx, turnId: 'e1' }, call('cancel_appointment', { appointmentId: appt }));
    const s = await sessions().get(full.tenantId, ctx.aiConversationId);
    const stale = { ...(s.pendingConfirmations ?? {}) };
    stale[`cancel:${appt}`] = { ...stale[`cancel:${appt}`], expiresAt: new Date(Date.now() - 1000).toISOString() };
    await sessions().patch(full.tenantId, ctx.aiConversationId, { pendingConfirmations: stale });
    const afterExpiry = await rt.dispatch.execute({ ...ctx, turnId: 'e2' }, call('cancel_appointment', { appointmentId: appt }));
    expect(afterExpiry).toMatchObject({ success: false, confirmationRequired: true });
    expect(afterExpiry.awaitingPatientReply).toBeUndefined(); // it is a fresh proposal, not "already asked"
    expect((await row(appt)).status).toBe('CONFIRMED');

    // no turnId at all: whatever was proposed can never be confirmed
    const noTurn = { ...ctx, turnId: undefined };
    await rt.dispatch.execute(noTurn, call('cancel_appointment', { appointmentId: appt }));
    const stillRefused = await rt.dispatch.execute(noTurn, call('cancel_appointment', { appointmentId: appt }));
    expect(stillRefused).toMatchObject({ success: false, awaitingPatientReply: true });
    expect((await row(appt)).status).toBe('CONFIRMED');
  });

  // ── F-03: whose appointment is it ───────────────────────────────────────────
  it('F-03: another patient\'s, another clinic\'s and a made-up id all get the SAME refusal, and none of them runs', async () => {
    const { full, b } = rt.seed;
    const y = await newAppointment(full.patientIds.y, 80);
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const bBefore = await row(b.appointmentIds.canary);
    const ids = { anotherPatient: y, anotherClinic: b.appointmentIds.canary, madeUp: '11111111-2222-4333-8444-555555555555' };

    const out: Record<string, any> = {};
    for (const [label, id] of Object.entries(ids)) {
      out[`cancel_${label}`] = await rt.dispatch.execute({ ...ctx, turnId: turn() }, call('cancel_appointment', { appointmentId: id }));
      out[`resched_${label}`] = await rt.dispatch.execute(
        { ...ctx, turnId: turn() },
        call('reschedule_appointment', { appointmentId: id, newStartAt: new Date(Date.now() + 200 * 3_600_000).toISOString() }),
      );
    }
    // The second call of each pair is a "confirmation" in a later message: still nothing.
    for (const label of Object.keys(ids)) {
      out[`cancel_${label}_again`] = await rt.dispatch.execute({ ...ctx, turnId: turn() }, call('cancel_appointment', { appointmentId: (ids as any)[label] }));
    }

    const messages = new Set(Object.values(out).map((r: any) => r.error));
    expect(messages.size).toBe(1); // no existence oracle: "not yours", "not here" and "someone else's clinic" read the same
    expect([...messages][0]).toMatch(NOT_YOURS);
    expect(Object.values(out).every((r: any) => r.success === false && r.confirmationRequired === undefined)).toBe(true);
    expect((await row(y)).status).toBe('CONFIRMED');
    expect((await row(b.appointmentIds.canary)).status).toBe(bBefore.status);
    expect(iso((await row(b.appointmentIds.canary)).start_at)).toBe(iso(bBefore.start_at));
    const denied = (await ledger(full.tenantId, 'cancel_appointment')).filter((s) => s === 'DENIED').length;
    expect(denied).toBeGreaterThanOrEqual(6); // every probe is on the record
    observed.uniform_refusal = [...messages];
  });

  it('F-03: a malformed id is refused before anything is looked up — no driver error reaches the model', async () => {
    const { full } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    for (const tool of ['cancel_appointment', 'reschedule_appointment']) {
      const res = await rt.dispatch.execute(
        { ...ctx, turnId: turn() },
        call(tool, { appointmentId: 'my appointment tomorrow', newStartAt: new Date(Date.now() + 200 * 3_600_000).toISOString() }),
      );
      expect(res.success).toBe(false);
      expect(String(res.error)).toMatch(/list_my_appointments/);
      expect(String(res.error)).not.toMatch(/invalid input|syntax|column|relation/i);
    }
  });

  it('F-03: a WhatsApp turn with NO bound patient is refused outright — the bot\'s tenant-wide permission never becomes "any patient"', async () => {
    const { full } = rt.seed;
    const y = await newAppointment(full.patientIds.y, 82);
    const ctx = { ...(await whatsappToolCtx(rt, full, undefined)), channel: 'WHATSAPP', turnId: turn() };
    const cancel = await rt.dispatch.execute(ctx, call('cancel_appointment', { appointmentId: y }));
    const resched = await rt.dispatch.execute(ctx, call('reschedule_appointment', { appointmentId: y, newStartAt: new Date(Date.now() + 300 * 3_600_000).toISOString() }));
    const list = await rt.dispatch.execute(ctx, call('list_my_appointments', {}));
    for (const r of [cancel, resched, list]) {
      expect(r.success).toBe(false);
      expect(String(r.error)).toMatch(/No patient is identified/);
    }
    expect((await row(y)).status).toBe('CONFIRMED');
  });

  it('CONTROL: a staff principal keeps its permission-based authority over the tenant — but its confirmation also needs a later turn', async () => {
    const { full } = rt.seed;
    const owner = await ownerPrincipal(rt, full);
    const conv = await rt.conversations.start(full.tenantId, {});
    const staffCtx = { tenantId: full.tenantId, actorUserId: owner.id, permissions: owner.permissions, aiConversationId: conv.id, principal: owner };
    const y = await newAppointment(full.patientIds.y, 84);

    const asked = await rt.dispatch.execute({ ...staffCtx, turnId: 's1' }, call('cancel_appointment', { appointmentId: y }));
    const sameTurn = await rt.dispatch.execute({ ...staffCtx, turnId: 's1' }, call('cancel_appointment', { appointmentId: y }));
    const laterTurn = await rt.dispatch.execute({ ...staffCtx, turnId: 's2' }, call('cancel_appointment', { appointmentId: y }));

    expect(asked).toMatchObject({ success: false, confirmationRequired: true });
    expect(asked.appointment).toBeUndefined(); // the patient-facing summary is for patient-bound turns
    expect(sameTurn).toMatchObject({ success: false, awaitingPatientReply: true });
    expect(laterTurn.success).toBe(true);
    expect((await row(y)).status).toBe('CANCELLED');
  });

  // ── F-05: the clinic's window ───────────────────────────────────────────────
  it('F-05: the window is the clinic\'s LIVE cancellation_hours — shrink it and a 2-hour-away appointment can be cancelled, widen it and a 72-hour one cannot', async () => {
    const { full } = rt.seed;
    const setHours = (h: number) => q(`UPDATE tenant_settings SET cancellation_hours=$2 WHERE tenant_id=$1`, [full.tenantId, h]);
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.y);
    const soon = await newAppointment(full.patientIds.y, 2);
    const later = await newAppointment(full.patientIds.y, 72);
    try {
      const closed = await rt.dispatch.execute({ ...ctx, turnId: turn() }, call('cancel_appointment', { appointmentId: soon }));
      expect(closed).toMatchObject({ success: false, blockedReason: 'WINDOW_CLOSED', changeWindowHours: 24 });

      await setHours(1);
      await rt.dispatch.execute({ ...ctx, turnId: 'w1' }, call('cancel_appointment', { appointmentId: soon }));
      const opened = await rt.dispatch.execute({ ...ctx, turnId: 'w2' }, call('cancel_appointment', { appointmentId: soon }));
      expect(opened.success).toBe(true);
      expect((await row(soon)).status).toBe('CANCELLED');

      await setHours(200);
      const widened = await rt.dispatch.execute({ ...ctx, turnId: turn() }, call('cancel_appointment', { appointmentId: later }));
      expect(widened).toMatchObject({ success: false, blockedReason: 'WINDOW_CLOSED', changeWindowHours: 200 });
      expect((await row(later)).status).toBe('CONFIRMED');
      // reschedule follows the same rule
      const resched = await rt.dispatch.execute({ ...ctx, turnId: turn() }, call('reschedule_appointment', { appointmentId: later, newStartAt: new Date(Date.now() + 400 * 3_600_000).toISOString() }));
      expect(resched).toMatchObject({ success: false, blockedReason: 'WINDOW_CLOSED' });
    } finally {
      await setHours(24);
    }
  });

  it('F-05: a finished or already-cancelled appointment cannot be "changed" — and the patient is not asked to confirm it', async () => {
    const { full } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.y);
    const done = await newAppointment(full.patientIds.y, 90, 'COMPLETED');
    const gone = await newAppointment(full.patientIds.y, 92, 'CANCELLED');
    for (const id of [done, gone]) {
      const res = await rt.dispatch.execute({ ...ctx, turnId: turn() }, call('cancel_appointment', { appointmentId: id }));
      expect(res.success).toBe(false);
      expect(res.confirmationRequired).toBeUndefined();
      expect(String(res.error)).toMatch(/can no longer be changed/);
    }
  });

  // ── replay ─────────────────────────────────────────────────────────────────
  it('FR-027 still holds: a retried cancel replays the stored success (one cancellation, not two) — and another patient cannot ride that ledger row', async () => {
    const { full } = rt.seed;
    const y = await newAppointment(full.patientIds.y, 94);
    const yCtx = await whatsappToolCtx(rt, full, full.patientIds.y);
    await rt.dispatch.execute({ ...yCtx, turnId: 'r1' }, call('cancel_appointment', { appointmentId: y }));
    const done = await rt.dispatch.execute({ ...yCtx, turnId: 'r2' }, call('cancel_appointment', { appointmentId: y }));
    const replay = await rt.dispatch.execute({ ...yCtx, turnId: 'r3' }, call('cancel_appointment', { appointmentId: y }));
    expect(done.success).toBe(true);
    expect(replay).toMatchObject({ idempotentReplay: true, status: 'CANCELLED' }); // the stored outcome, not "already cancelled"
    const cancellations = await q(`SELECT count(*)::int c FROM appointment_cancellations WHERE "appointmentId"=$1`, [y]);
    expect(cancellations[0].c).toBe(1);

    const xCtx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const ridden = await rt.dispatch.execute({ ...xCtx, turnId: 'r4' }, call('cancel_appointment', { appointmentId: y }));
    expect(ridden.success).toBe(false);
    expect(ridden.error).toMatch(NOT_YOURS);
  });

  // ── list_my_appointments ────────────────────────────────────────────────────
  it('F-27: list_my_appointments returns only THIS patient\'s upcoming, live appointments — soonest first, with the change-window verdict', async () => {
    const { full } = rt.seed;
    const patient = await freshPatient();
    const y1 = await newAppointment(patient.id, 100);
    const y2 = await newAppointment(patient.id, 150);
    const ySoon = await newAppointment(patient.id, 3);
    const yGone = await newAppointment(patient.id, 110, 'CANCELLED');
    const yPast = await newAppointment(patient.id, -60);
    const x1 = await newAppointment(full.patientIds.x, 120);

    reactive.setHandler((req) => (toolResultsIn(req).length ? { content: 'listed' } : { toolCalls: [call('list_my_appointments', {})] }));
    await whatsappTurn(rt, full.tenantId, patient.phone, 'what appointments do I have?');
    const listed = lastResult(reactive, 'list_my_appointments');
    const ids = (listed.appointments as any[]).map((a) => a.appointmentId);

    expect(listed.success).toBe(true);
    expect(ids).toEqual([ySoon, y1, y2]); // soonest first
    for (const excluded of [yGone, yPast, x1]) expect(ids).not.toContain(excluded);
    expect(listed.count).toBe(3);
    expect(listed.changeWindowHours).toBe(24);
    const byId = Object.fromEntries((listed.appointments as any[]).map((a) => [a.appointmentId, a]));
    expect(byId[ySoon].canChangeOnline).toBe(false); // inside the window
    expect(byId[y1].canChangeOnline).toBe(true);
    expect(byId[y1].doctor).toBeTruthy(); // named, so the patient can tell them apart
    expect(byId[y1].local.timezone).toBeTruthy();
    // The model is told not to show ids — and the list carries nothing about anyone else.
    expect(JSON.stringify(listed)).not.toMatch(/customerId|tenantId|patient x/i);
    expect(listed.guidance).toMatch(/never show the id/);
    observed.list = listed;
  });

  it('F-27: list_my_appointments needs the read permission and a bound patient; a guest never gets it', async () => {
    const { full } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.y);
    const noPermission = await rt.dispatch.execute({ ...ctx, permissions: [] }, call('list_my_appointments', {}));
    expect(noPermission.success).toBe(false);
    expect(String(noPermission.error)).toMatch(/^Forbidden:/);
    const guest = await rt.dispatch.execute(
      { ...ctx, principal: { ...ctx.principal, guest: true } as never, actorUserId: undefined },
      call('list_my_appointments', {}),
    );
    expect(guest.success).toBe(false);
  });
});

/** The most recent result of `tool` across the requests the model double has seen. */
function lastResult(provider: ReactiveProvider, tool: string): any {
  const requests = provider.capturedRequests;
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    const hit = toolResultsIn(requests[i]).filter((r) => r.name === tool).pop();
    if (hit) return hit.json;
  }
  return undefined;
}
