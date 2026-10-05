/**
 * Doctor personas: own dashboard, own appointments, `staff/me*`.
 *
 * A doctor session (`staff.read_own`, `appointments.read_own`) is confined to its
 * own appointments by StaffScopeService (Redis, 60 s, fails open to the DB). The
 * doctor dashboard fires `/appointments?from=today&order=ASC&limit=30`, the
 * queue branch list, the queue itself (3 s poll, see flows/queue.js) and
 * `/staff/me/schedules` — mirrored here.
 */
import http from 'k6/http';
import { BASE, authGet } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { queueBranches } from './queue.js';

export function doctorDashboard(session, step) {
  const p = authGet(session, { step });
  const today = new Date().toISOString().slice(0, 10);
  const res = http.batch([
    ['GET', `${BASE}/api/v1/appointments?from=${today}T00:00:00.000Z&order=ASC&limit=30`, null, p],
    ['GET', `${BASE}/api/v1/staff/me/schedules`, null, p],
    ['GET', `${BASE}/api/v1/dashboard/summary`, null, p],
  ]);
  observe(res[0], 'doctor:appointments', step);
  observe(res[1], 'staff:me:schedules', step);
  observe(res[2], 'dashboard', step);
  queueBranches(session, step);
  const ok = res[0].status === 200 && res[1].status === 200;
  businessErrors.add(!ok, { step });
  return res;
}

export function staffMe(session, step) {
  const p = authGet(session, { step });
  const res = http.batch([
    ['GET', `${BASE}/api/v1/staff/me`, null, p],
    ['GET', `${BASE}/api/v1/staff/me/time-off`, null, p],
  ]);
  observe(res[0], 'staff:me', step);
  observe(res[1], 'staff:me:time-off', step);
  const ok = res[0].status === 200;
  businessErrors.add(!ok, { step });
  return res;
}

/**
 * A doctor opening one of THEIR OWN appointments. Deliberately NOT appointmentDetail(): that
 * page view also loads /services and /staff lists a doctor is not necessarily permitted to
 * read, which would add correct 403s to the business-error rate and misstate doctor traffic.
 */
export function doctorAppointmentDetail(session, appointmentId, step) {
  const p = authGet(session, { step });
  const res = http.batch([
    ['GET', `${BASE}/api/v1/appointments/${appointmentId}`, null, p],
    ['GET', `${BASE}/api/v1/appointments/${appointmentId}/notes`, null, p],
    ['GET', `${BASE}/api/v1/appointments/${appointmentId}/timeline`, null, p],
  ]);
  observe(res[0], 'appointments:detail', step);
  observe(res[1], 'appointments:notes', step);
  observe(res[2], 'appointments:timeline', step);
  businessErrors.add(res[0].status !== 200, { step });
  return res;
}
