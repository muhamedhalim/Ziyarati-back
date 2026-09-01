/**
 * Appointments: list, detail, availability, and the booking write path.
 *
 * The write path is the marquee scenario. `POST /appointments` holds one
 * transaction across ~15-20 round trips (branch/customer/staff/service checks,
 * the full ~11-query availability engine, a usage-counter UPDATE, then four
 * INSERTs) and every concurrent booking for the SAME tenant queues behind one
 * usage-counter row lock. Two distinct 409s are expected and are signal, not
 * failure: STAFF_NOT_AVAILABLE (pre-check) and SLOT_ALREADY_BOOKED (the gist
 * exclusion constraint losing a genuine race).
 */
import http from 'k6/http';
import { BASE, authGet, authWrite, pickPair } from '../helpers/auth.js';
import { observe, observeCreate, journeyLatency } from '../helpers/metrics.js';
import { checkPagedList, checkAvailability, checkAppointmentCreate } from '../helpers/checks.js';

const pick = (arr, i) => arr[i % arr.length];

/** Appointments list page view — matches the frontend's 5-request fan-out. */
export function appointmentsPageView(session, step) {
  const p = authGet(session, { step });
  const started = Date.now();
  const res = http.batch([
    ['GET', `${BASE}/api/v1/notifications/inbox/unread-count`, null, p],
    ['GET', `${BASE}/api/v1/staff?role=doctor&limit=100`, null, p],
    // The page's real cold-load request is completely UNFILTERED (no status,
    // no staff, no date range) — verified in the page component. That is a very
    // different DB cost from a today-scoped query, so we reproduce it exactly.
    ['GET', `${BASE}/api/v1/appointments?page=1&limit=10`, null, p],
  ]);
  journeyLatency.add(Date.now() - started, { journey: 'appointments', step });

  observe(res[0], 'notifications:unread', step);
  observe(res[1], 'staff:doctors', step);
  observe(res[2], 'appointments:list', step);
  checkPagedList(res[2], 'appointments', { step });
  return res;
}

/** A filtered variant, to compare index usage against the unfiltered list. */
export function appointmentsFiltered(session, step) {
  const p = authGet(session, { step });
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 30 * 86400000).toISOString();
  const res = http.get(
    `${BASE}/api/v1/appointments?page=1&limit=20&status=CONFIRMED&from=${from}&to=${to}`, p);
  observe(res, 'appointments:list:filtered', step);
  return res;
}

/** Deep pagination — offset-based with no page cap, so OFFSET grows unbounded. */
export function appointmentsDeepPage(session, step, page) {
  const p = authGet(session, { step });
  const res = http.get(`${BASE}/api/v1/appointments?page=${page}&limit=20`, p);
  observe(res, 'appointments:list:deep', step);
  return res;
}

/** Availability windows — ~11 SQL, and the same engine every booking runs. */
export function availabilityWindows(session, step, dayOffset) {
  const pair = pickPair(session, __VU + (__ITER || 0));
  if (!pair) return null;
  const p = authGet(session, { step });
  const d = new Date(Date.now() + (dayOffset || 3) * 86400000).toISOString().slice(0, 10);
  const res = http.get(
    `${BASE}/api/v1/scheduling/availability/windows` +
    `?branchId=${pair.branchId}&staffId=${pair.staffId}&date=${d}&slotMinutes=30`, p);
  observe(res, 'availability:windows', step);
  checkAvailability(res, { step });
  return res;
}

/**
 * Books an appointment.
 *
 * Slot selection is deterministic and near-collision-free by default: each VU
 * owns a distinct minute offset far in the future, so the scenario measures
 * transaction throughput rather than degenerating into a 409 storm. Pass
 * `contend=true` to deliberately aim every VU at ONE shared slot — that is the
 * race-condition probe, and there 409 SLOT_ALREADY_BOOKED is the expected
 * result for all but one winner.
 */
export function createAppointment(session, step, contend) {
  // Contention mode deliberately collapses everyone onto pair 0 + slot 0.
  const pair = pickPair(session, contend ? 0 : __VU);
  if (!pair || !session.customerIds.length) return null;
  const branch = pair.branchId;
  const staff = pair.staffId;
  const customer = pick(session.customerIds, __VU + (__ITER || 0));

  // SLOT GEOMETRY.
  //
  // Appointments carry a gist EXCLUDE on ("staffId", tstzrange(start,end)) for
  // non-cancelled rows, so any two bookings for one staff member that overlap in
  // time produce 409 SLOT_ALREADY_BOOKED. Packing (run, VU, iteration) into
  // contiguous bands does not survive contact with reality: a long run needs
  // thousands of slots per VU, so the bands must be enormous, and a repeat run
  // lands back on the previous run's slots.
  //
  // Instead we scatter deterministically across a large sparse space — ~5 years
  // of 15-minute slots per staff member. The index is a pure function of
  // (VU, iteration, runSeed), so a run is reproducible, while the occupancy of
  // the space stays low enough that accidental collisions are negligible and
  // any 409 that does appear is a genuine race worth reporting.
  // The slot must also fall INSIDE the staff member's schedule, or the
  // availability engine refuses it with 409 STAFF_NOT_AVAILABLE
  // (reasonCode OUTSIDE_WORKING_HOURS) — a different 409 from the exclusion
  // constraint's SLOT_ALREADY_BOOKED, and one that says nothing about
  // concurrency. Scattering across all 24 hours put ~half the bookings outside
  // the window; we therefore scatter over (day, slot-within-shift) instead.
  //
  // The fixture schedules every staff member 08:00-20:00 in the branch's
  // timezone, Asia/Riyadh = UTC+3 with no DST, so the bookable band is
  // 05:00-17:00 UTC. We stop at 19:00 local to leave margin for the duration.
  const DURATION_MIN = 15;
  const SHIFT_START_UTC_H = 5;   // 08:00 Asia/Riyadh
  const SLOTS_PER_DAY = 44;      // 15-min slots from 08:00 to 19:00 local
  const DAY_SPACE = 1800;        // ~5 years of calendar => ~79k slots per staff

  const base = new Date(Date.now() + 400 * 86400000);
  base.setUTCHours(0, 0, 0, 0);

  const h = (((__VU * 7919) ^ ((__ITER || 0) * 104729) ^ ((session.runSeed || 0) * 15485863)) >>> 0);
  const day = contend ? 0 : (h % DAY_SPACE);
  const slotInDay = contend ? 0 : (Math.floor(h / DAY_SPACE) % SLOTS_PER_DAY);

  const start = new Date(
    base.getTime()
    + day * 86400000
    + SHIFT_START_UTC_H * 3600000
    + slotInDay * DURATION_MIN * 60000,
  );
  const end = new Date(start.getTime() + DURATION_MIN * 60000);

  const body = {
    branchId: branch,
    customerId: customer,
    staffId: staff,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    // Marker so tests/load/data/cleanup.sql can remove exactly what the suite
    // created, without touching the 60k seeded appointments.
    notes: 'k6-load-test',
  };

  const res = http.post(`${BASE}/api/v1/appointments`, JSON.stringify(body),
    authWrite(session, { step }));
  observeCreate(res, step);
  checkAppointmentCreate(res, { step });
  return res;
}

/** Status transition on an appointment we just created (200, not 201). */
export function updateStatus(session, appointmentId, status, step) {
  const res = http.post(`${BASE}/api/v1/appointments/${appointmentId}/status`,
    JSON.stringify({ status: status || 'CONFIRMED' }),
    authWrite(session, { step }));
  observe(res, 'appointments:status', step);
  return res;
}

/** Detail page wave B — 5 dependent requests once the detail resolves. */
export function appointmentDetail(session, appointmentId, step) {
  const p = authGet(session, { step });
  const detail = http.get(`${BASE}/api/v1/appointments/${appointmentId}`, p);
  observe(detail, 'appointments:detail', step);
  if (detail.status !== 200) return detail;

  const res = http.batch([
    ['GET', `${BASE}/api/v1/services?isActive=true&limit=100`, null, p],
    ['GET', `${BASE}/api/v1/appointments/${appointmentId}/notes`, null, p],
    ['GET', `${BASE}/api/v1/appointments/${appointmentId}/timeline`, null, p],
    ['GET', `${BASE}/api/v1/appointments/${appointmentId}/reminders`, null, p],
  ]);
  observe(res[0], 'services:list', step);
  observe(res[1], 'appointments:notes', step);
  observe(res[2], 'appointments:timeline', step);
  observe(res[3], 'appointments:reminders', step);
  return detail;
}
