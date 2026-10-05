/**
 * Tenant isolation, asserted IN FLIGHT at campaign scale.
 *
 * A fraction of iterations asks for an appointment that belongs to a DIFFERENT
 * tenant, using THIS session's credentials. The only correct answers are 403 and
 * 404; a 200 is a cross-tenant read, the most severe finding the campaign can
 * produce (P0). `responseCallback` marks 403/404 as the EXPECTED outcome so the
 * probe does not inject its own errors into http_req_failed (that bug was found
 * and fixed in vu-ladder.js).
 *
 * Needs `probeAppointmentId` on each session (written by lab/mint-sessions.mjs).
 */
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';
import { BASE, authGet } from '../helpers/auth.js';
import { sessionsArr, sessionIndex } from '../helpers/sessions.js';

export const isolationViolation = new Counter('tenant_isolation_violation');
export const isolationProbe = new Counter('tenant_isolation_probe');
export const isolationOk = new Rate('tenant_isolation_ok');

const EXPECTED = http.expectedStatuses(403, 404);

/** A session guaranteed NOT to share `session`'s tenant (and holding a probe id). */
function foreignSession(session) {
  const n = sessionIndex().count;
  for (let t = 0; t < 12; t++) {
    const i = ((__VU * 40503) + (__ITER || 0) * 7919 + t * 104729) % n;
    const s = sessionsArr[i];
    if (s.tenantId !== session.tenantId && s.probeAppointmentId) return s;
  }
  return null;
}

export function crossTenantProbe(session, step) {
  if (!session.tenantId) return null; // super-admin has no tenant
  const foreign = foreignSession(session);
  if (!foreign) return null;
  const params = authGet(session, { step, endpoint: 'isolation:probe' });
  params.responseCallback = EXPECTED;
  const res = http.get(`${BASE}/api/v1/appointments/${foreign.probeAppointmentId}`, params);
  isolationProbe.add(1, { step });
  isolationOk.add(res.status === 403 || res.status === 404, { step });
  if (res.status === 200) isolationViolation.add(1, { step });
  return res;
}
