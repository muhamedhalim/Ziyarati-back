/**
 * High-volume appointment write paths for the 20K campaign (book, reschedule,
 * cancel, confirm) with explicit CONTENTION MODES.
 *
 * The invariant under test is the one the September campaign proved and the
 * migrations since must not have lost: the `appointments_no_overlap` gist
 * EXCLUDE constraint. Every mode therefore ends with the same post-run assertions
 * (lab SQL, not HTTP status): zero overlapping non-cancelled rows per staff, at
 * most one row per contended (staff, slot), zero 5xx, zero deadlocks.
 *
 * MODES (what the VUs fight over):
 *   spread       every VU books its own sparse slot            -> pure transaction throughput
 *   same-slot    all VUs aim at ONE (doctor, slot)              -> exactly 1x201, the rest clean 409
 *   same-doctor  one doctor, DIFFERENT slots per VU             -> lock/queueing on one staff row
 *   hot-branch   one branch, many doctors, different slots      -> branch + tenant usage-row contention
 *   multi-tenant each VU's own tenant, identical slot           -> must NOT collide (isolation of the guard)
 *
 * Expected outcomes are COUNTED, never failures: 201 created; 409 SLOT_ALREADY_BOOKED
 * (the exclusion constraint losing a real race); 409 STAFF_NOT_AVAILABLE (pre-check);
 * 422 is a quota refusal and IS an error in a lab whose quotas are not meant to bind.
 *
 * Slot geometry mirrors flows/appointments.js: fixtures schedule every doctor
 * 08:00-20:00 Asia/Riyadh (05:00-17:00 UTC), so slots are scattered over
 * (day, slot-in-shift) in a sparse ~5-year space; the index is a pure function of
 * (VU, iteration, runSeed), so a run is reproducible.
 */
import http from 'k6/http';
import { BASE, authWrite, pickPair } from '../helpers/auth.js';
import { observe, observeCreate, apptSlotTaken, apptNotAvailable, apptRescheduled, apptCancelled } from '../helpers/metrics.js';
import { checkAppointmentCreate, businessErrors } from '../helpers/checks.js';

const DURATION_MIN = 15;
const SHIFT_START_UTC_H = 5;
const SLOTS_PER_DAY = 44;
const DAY_SPACE = 1800;
const EXPECT = http.expectedStatuses({ min: 200, max: 299 }, 404, 409);
let notAvailableLogged = 0;

function slotAt(day, slotInDay) {
  const base = new Date(Date.now() + 400 * 86400000);
  base.setUTCHours(0, 0, 0, 0);
  const start = new Date(base.getTime() + day * 86400000 + SHIFT_START_UTC_H * 3600000 + slotInDay * DURATION_MIN * 60000);
  return { start, end: new Date(start.getTime() + DURATION_MIN * 60000) };
}

function uniqueSlot(session, salt) {
  const h = (((__VU * 7919) ^ (((__ITER || 0) + salt) * 104729) ^ ((session.runSeed || 0) * 15485863)) >>> 0);
  if (__ENV.LT_DEBUG_SLOTS === 'true' && (__ITER || 0) < 4) console.warn(`slot-debug vu=${__VU} iter=${__ITER} runSeed=${session.runSeed} h=${h}`);
  return slotAt(h % DAY_SPACE, Math.floor(h / DAY_SPACE) % SLOTS_PER_DAY);
}

/** Resolves {branchId, staffId, slot} for a mode. Returns null when the session cannot play it. */
function plan(session, mode) {
  if (!session.pairs || !session.pairs.length || !session.customerIds || !session.customerIds.length) return null;
  const customerId = session.customerIds[(__VU + (__ITER || 0)) % session.customerIds.length];
  if (mode === 'same-slot') {
    const pr = pickPair(session, 0);
    // A FIXED day/slot per run (not per VU) — everyone collides on purpose.
    return { branchId: pr.branchId, staffId: pr.staffId, customerId, slot: slotAt(((session.runSeed || 0) % DAY_SPACE), 0) };
  }
  if (mode === 'same-doctor') {
    const pr = pickPair(session, 0);
    return { branchId: pr.branchId, staffId: pr.staffId, customerId, slot: uniqueSlot(session, 0) };
  }
  if (mode === 'hot-branch') {
    // The widest branch (most doctors) — pairs are ordered as discovered, so pick by size.
    let best = session.pairs[0];
    for (const p of session.pairs) if (p.staffIds.length > best.staffIds.length) best = p;
    return { branchId: best.branchId, staffId: best.staffIds[(__VU + (__ITER || 0)) % best.staffIds.length], customerId, slot: uniqueSlot(session, 0) };
  }
  if (mode === 'multi-tenant') {
    const pr = pickPair(session, 0);
    return { branchId: pr.branchId, staffId: pr.staffId, customerId, slot: slotAt(((session.runSeed || 0) % DAY_SPACE), 1) };
  }
  const pr = pickPair(session, __VU);
  return { branchId: pr.branchId, staffId: pr.staffId, customerId, slot: uniqueSlot(session, 0) };
}

/** Books once in the given mode. Returns the response (201 body has `id`). */
export function book(session, step, mode) {
  const p = plan(session, mode || 'spread');
  if (!p) return null;
  const res = http.post(`${BASE}/api/v1/appointments`, JSON.stringify({
    branchId: p.branchId, customerId: p.customerId, staffId: p.staffId,
    startAt: p.slot.start.toISOString(), endAt: p.slot.end.toISOString(), notes: 'k6-load-test',
  }), Object.assign(authWrite(session, { step }), { responseCallback: http.expectedStatuses(201, 409) }));
  observeCreate(res, step);
  checkAppointmentCreate(res, { step });
  if (res.status === 409) {
    let code = '';
    let message = '';
    try { const b = res.json(); code = b.code || ''; message = b.message || ''; } catch (e) { /* ignore */ }
    if (code === 'SLOT_ALREADY_BOOKED') apptSlotTaken.add(1, { mode, step });
    else {
      apptNotAvailable.add(1, { mode, step, code });
      // Bounded sample (2 per VU) so a "not available" is attributable without a per-request log.
      if (notAvailableLogged++ < 2) console.warn(`appointments:create 409 code=${code} message="${String(message).slice(0, 160)}" mode=${mode} staff=${p.staffId} start=${p.slot.start.toISOString()}`);
    }
  }
  return res;
}

/** Moves a booking we created to a fresh slot (own or cross-staff). 200 / 409 expected. */
export function reschedule(session, appointmentId, step) {
  const s = uniqueSlot(session, 7919);
  const p = authWrite(session, { step });
  p.responseCallback = EXPECT;
  const res = http.post(`${BASE}/api/v1/appointments/${appointmentId}/reschedule`, JSON.stringify({
    newStartAt: s.start.toISOString(), newEndAt: s.end.toISOString(), reason: 'k6 reschedule',
  }), p);
  observe(res, 'appointments:reschedule', step);
  if (res.status === 200) apptRescheduled.add(1, { step });
  businessErrors.add(res.status >= 500, { step });
  return res;
}

export function cancel(session, appointmentId, step) {
  const p = authWrite(session, { step });
  p.responseCallback = EXPECT;
  const res = http.post(`${BASE}/api/v1/appointments/${appointmentId}/cancel`, JSON.stringify({ reason: 'k6 cancel' }), p);
  observe(res, 'appointments:cancel', step);
  if (res.status === 200) apptCancelled.add(1, { step });
  businessErrors.add(res.status >= 500, { step });
  return res;
}

/** book -> (maybe reschedule) -> (maybe cancel): the full lifecycle a receptionist drives. */
export function lifecycle(session, step, mode, rescheduleP, cancelP) {
  const res = book(session, step, mode);
  if (!res || res.status !== 201) return res;
  let id;
  try { id = res.json().id; } catch (e) { return res; }
  if (Math.random() < (rescheduleP || 0)) reschedule(session, id, step);
  if (Math.random() < (cancelP || 0)) cancel(session, id, step);
  return res;
}
