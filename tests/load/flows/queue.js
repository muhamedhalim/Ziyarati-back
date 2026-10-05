/**
 * Patient queue — the clinic's highest-frequency page.
 *
 * Facts this flow is built on (verified against the controller/service, not assumed):
 *  - The queue page polls `GET /queue?branchId=` every 3 s per focused tab
 *    (features/clinic/queue.ts). The endpoint loads EVERY entry for the branch
 *    and day and slices in memory, so its cost grows with the day's volume.
 *  - There is no "call next" route and no `state` filter; the UI picks the first
 *    WAITING id client-side. A cycle is check-in -> call -> start -> complete.
 *  - Check-in accepts any non-terminal appointment (date is NOT checked) and the
 *    entry's business_date is "today in the branch timezone". One live entry per
 *    appointment (partial unique index) => a duplicate check-in is a clean 409.
 *  - COMPLETE is terminal for the appointment, so each pooled appointment supports
 *    exactly ONE full cycle. The pool (pack-queue.json) is sized to rate x duration;
 *    a drained pool shows up as rising `queue_conflict_409`, not as errors.
 *
 * 409 is an EXPECTED outcome here (race lost / already queued / terminal), so the
 * writes declare 409 as an expected status and count it separately.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE, authGet, authWrite } from '../helpers/auth.js';
import { observe, queueCycles, queueConflict409 } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { pack } from '../helpers/sessions.js';

const POOL = pack('queue'); // [{ tenantId, branchId, appts: [appointmentId...] }]
const EXPECT_WRITE = http.expectedStatuses({ min: 200, max: 299 }, 404, 409);

let _entry; // per-VU cache
function entryFor(session) {
  if (_entry !== undefined) return _entry;
  // session.queueIdx is precomputed by lab/mint-sessions.mjs (-1 = tenant has no
  // queue pool). Scanning the pack here would re-parse every element per VU.
  _entry = (session.queueIdx !== undefined && session.queueIdx >= 0) ? POOL[session.queueIdx] : null;
  return _entry || null;
}

function branchOf(session) {
  const e = entryFor(session);
  if (e && e.branchId) return e.branchId;
  return session.branchIds && session.branchIds.length ? session.branchIds[0] : null;
}

/** The 3-second board poll. `GET /queue` is the expensive in-memory-sliced read. */
export function queueView(session, step) {
  const branchId = branchOf(session);
  if (!branchId) return null;
  const res = http.get(`${BASE}/api/v1/queue?branchId=${branchId}`, authGet(session, { step }));
  observe(res, 'queue:list', step);
  const ok = res.status === 200 && (() => {
    try { const b = res.json(); return Array.isArray(b.data) && typeof b.total === 'number'; } catch (e) { return false; }
  })();
  businessErrors.add(!ok, { step });
  return res;
}

/** The branch picker the page loads once. */
export function queueBranches(session, step) {
  const res = http.get(`${BASE}/api/v1/queue/branches`, authGet(session, { step }));
  observe(res, 'queue:branches', step);
  return res;
}

function write(session, path, body, endpoint, step) {
  const p = authWrite(session, { step });
  p.responseCallback = EXPECT_WRITE;
  const res = http.post(`${BASE}/api/v1/queue/${path}`, body ? JSON.stringify(body) : null, p);
  observe(res, endpoint, step);
  if (res.status === 409) queueConflict409.add(1, { endpoint, step });
  return res;
}

/**
 * One full reception cycle on a pooled appointment. Returns the last response.
 * Needs a session with `appointments.update` or `appointments.status.update`.
 */
export function queueCycle(session, step) {
  const e = entryFor(session);
  if (!e || !e.appts || !e.appts.length) return null;
  const appointmentId = e.appts[((__VU * 104729) + (__ITER || 0) * 31) % e.appts.length];

  const ci = write(session, 'check-in', { appointmentId }, 'queue:check-in', step);
  if (ci.status !== 201) return ci;
  let id;
  try { id = ci.json().id; } catch (err) { return ci; }
  if (!id) return ci;

  sleep(0.2);
  const call = write(session, `${id}/call`, null, 'queue:call', step);
  if (call.status !== 200) return call;
  sleep(0.2);
  const start = write(session, `${id}/start`, null, 'queue:start', step);
  if (start.status !== 200) return start;
  sleep(0.2);
  const done = write(session, `${id}/complete`, null, 'queue:complete', step);
  if (done.status === 200) queueCycles.add(1, { step });
  return done;
}
