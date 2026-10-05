/**
 * Marketplace discovery (public, read-only) — the surface book.<domain> reads.
 *
 * Contract facts (from the controller, not assumed):
 *  - It uses individual @Query params, so UNKNOWN keys are silently ignored.
 *    The page-size param is `pageSize` (never `limit`); a wrong name would be
 *    ignored and quietly return the default page, hiding the intended load.
 *  - Per-route throttles: cities/specialties 60/min, detail+lists 30/min,
 *    avatar 120/min, per tracker. The tracker is per-IP unless the request carries
 *    a PLATFORM API key (scope marketplace:discovery) AND `X-ZT-Visitor-Id`
 *    (16-128 hex chars), in which case it is per key+visitor. The key is a secret:
 *    it comes from LT_MARKETPLACE_KEY at run time and is never logged.
 *  - `marketplaceClinic` fans out 6 queries in parallel (6 pool connections for
 *    one request) and nothing here is cached server-side.
 *  - Doctors without an avatar_storage_key answer 404 on /avatar with NO object
 *    store call, so that 404 is an expected outcome (the R2 path is NOT TESTED).
 *
 * pack-marketplace.json: [{ clinicSlugs[], doctorSlugs[], specialtySlugs[],
 *   serviceRoutes:[{c,s}], cityIds[] }]  (one element)
 */
import http from 'k6/http';
import { BASE } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { pack } from '../helpers/sessions.js';

const DATA = pack('marketplace');
const KEY = __ENV.LT_MARKETPLACE_KEY || '';
const EXPECT_AVATAR = http.expectedStatuses(200, 404);

function hex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}
const visitorId = hex(32); // one visitor identity per VU (module state is per-VU)

function params(step, name, extra) {
  const headers = {};
  if (KEY) { headers['X-API-Key'] = KEY; headers['X-ZT-Visitor-Id'] = visitorId; }
  return Object.assign({ headers, tags: { step, name } }, extra || {});
}

const at = (arr, i) => (arr && arr.length ? arr[Math.abs(i) % arr.length] : null);

function ok200(res, name, step, fn) {
  let pass = res.status === 200;
  if (pass && fn) { try { pass = !!fn(res.json()); } catch (e) { pass = false; } }
  businessErrors.add(!pass, { step });
  return pass;
}

let _d; // one parse per VU, not per iteration
/** One visitor browsing: specialties -> doctors -> doctor -> clinic -> service. */
export function marketplaceBrowse(step) {
  if (!DATA.length) return null;
  if (!_d) _d = DATA[0];
  const d = _d;
  const n = __VU + (__ITER || 0);

  const spec = http.get(`${BASE}/api/v1/public/discovery/specialties`, params(step, 'mkt/specialties'));
  observe(spec, 'mkt:specialties', step);
  ok200(spec, 'specialties', step, (b) => Array.isArray(b));

  const specialty = at(d.specialtySlugs, n);
  if (specialty) {
    const r = http.get(`${BASE}/api/v1/public/discovery/specialties/${specialty}?doctorsPageSize=12&clinicsPageSize=12`,
      params(step, 'mkt/specialty'));
    observe(r, 'mkt:specialty', step);
    ok200(r, 'specialty', step, (b) => b.clinics && b.doctors);
  }

  const docs = http.get(`${BASE}/api/v1/public/discovery/doctors?page=1&pageSize=24`, params(step, 'mkt/doctors'));
  observe(docs, 'mkt:doctors', step);
  ok200(docs, 'doctors', step, (b) => Array.isArray(b.items));

  const doctor = at(d.doctorSlugs, n * 3);
  if (doctor) {
    const r = http.get(`${BASE}/api/v1/public/discovery/doctors/${doctor}`, params(step, 'mkt/doctor'));
    observe(r, 'mkt:doctor', step);
    ok200(r, 'doctor', step, (b) => !!b.clinic);
    const av = http.get(`${BASE}/api/v1/public/discovery/doctors/${doctor}/avatar`,
      params(step, 'mkt/avatar', { responseCallback: EXPECT_AVATAR }));
    observe(av, 'mkt:avatar', step);
  }

  const clinic = at(d.clinicSlugs, n * 5);
  if (clinic) {
    const r = http.get(`${BASE}/api/v1/public/discovery/marketplace/clinics/${clinic}`, params(step, 'mkt/clinic'));
    observe(r, 'mkt:clinic', step);
    ok200(r, 'clinic', step, (b) => !!b.clinic && !!b.branches);
  }

  const route = at(d.serviceRoutes, n * 7);
  if (route) {
    const r = http.get(`${BASE}/api/v1/public/discovery/clinics/${route.c}/services/${route.s}`, params(step, 'mkt/service'));
    observe(r, 'mkt:service', step);
    ok200(r, 'service', step, (b) => !!b.service);
  }

  const q = ['derma', 'dental', 'general', 'lab', 'laser'][n % 5];
  const svcs = http.get(`${BASE}/api/v1/public/discovery/services?q=${q}&page=1&pageSize=24`, params(step, 'mkt/services'));
  observe(svcs, 'mkt:services', step);
  return svcs;
}
