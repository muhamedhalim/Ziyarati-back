/**
 * Public (unauthenticated) booking funnel + discovery.
 *
 * COOKIES ARE LOAD-BEARING. Every route calls resolve(), which mints a
 * `guest_token` JWT and a `booking_session_id` (a real Conversation row) if the
 * request arrives without them. Reusing one VU-wide jar across iterations would
 * therefore under-count session creation; using no jar at all would create a
 * new guest AND a new conversation row on EVERY request. We give each funnel
 * run its own jar, which is what one real visitor does.
 *
 * SERVER-SIDE SELECTION STATE: no resource id is ever trusted from the caller —
 * each `select/*` call validates against live data and stores the choice on the
 * session. The funnel must therefore run in order; steps cannot be shuffled.
 *
 * RATE LIMITS (per IP, and `trust proxy` is off so they cannot be spread):
 *   steps 1-11        60/min
 *   POST .../confirm  10/min   <-- the binding constraint
 * With NODE_ENV=test these lift to 1e6; without it, the funnel self-throttles.
 *
 * SAFETY: `confirm` creates a real Customer + Appointment and fires the
 * appointment.created listeners. In this lab that is provably inert
 * (notification_rules / webhook_endpoints / workflows / whatsapp_accounts are
 * all empty and no worker runs), but it is still a write, so it is OFF by
 * default and must be enabled explicitly with BOOKING_CONFIRM=true.
 */
import http from 'k6/http';
import { BASE } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { checkArray } from '../helpers/checks.js';

const jsonParams = (jar, step, name) => ({
  jar,
  headers: { 'Content-Type': 'application/json' },
  tags: { step, name },
});

/** Discovery only — the cheapest public read, and the likeliest DoS target. */
export function publicDiscovery(step) {
  const jar = new http.CookieJar();
  const cities = http.get(`${BASE}/api/v1/public/discovery/cities`,
    jsonParams(jar, step, 'public/cities'));
  observe(cities, 'public:cities', step);
  checkArray(cities, 'public-cities', { step }, false);
  if (cities.status !== 200) return null;

  const list = cities.json();
  if (!Array.isArray(list) || list.length === 0) return null;
  const city = list[(__VU + (__ITER || 0)) % list.length];

  const clinics = http.get(
    `${BASE}/api/v1/public/discovery/clinics?cityId=${city.id}`,
    jsonParams(jar, step, 'public/clinics'));
  observe(clinics, 'public:clinics', step);
  return { jar, clinics };
}

/**
 * The full funnel up to slot selection. Returns the jar + chosen slot so a
 * caller may optionally confirm.
 */
export function bookingFunnel(step) {
  const jar = new http.CookieJar();
  const P = (name) => jsonParams(jar, step, name);

  const session = http.post(`${BASE}/api/v1/public/booking/session`, null, P('booking/session'));
  observe(session, 'public:booking:session', step);
  if (session.status !== 200 && session.status !== 201) return null;

  const cities = http.get(`${BASE}/api/v1/public/discovery/cities`, P('public/cities'));
  observe(cities, 'public:cities', step);
  if (cities.status !== 200) return null;
  const cityList = cities.json();
  if (!cityList.length) return null;
  const city = cityList[(__VU + (__ITER || 0)) % cityList.length];

  const clinics = http.get(
    `${BASE}/api/v1/public/discovery/clinics?cityId=${city.id}`, P('public/clinics'));
  observe(clinics, 'public:clinics', step);
  if (clinics.status !== 200) return null;
  const clinicBody = clinics.json();
  const clinicList = Array.isArray(clinicBody) ? clinicBody : (clinicBody.data || clinicBody.clinics || []);
  if (!clinicList.length) return null;
  const clinic = clinicList[0];

  const selClinic = http.post(`${BASE}/api/v1/public/booking/select/clinic`,
    JSON.stringify({ clinicId: clinic.id }), P('booking/select-clinic'));
  observe(selClinic, 'public:booking:select-clinic', step);
  if (selClinic.status >= 400) return null;

  // Selecting a clinic auto-selects the branch ONLY when that clinic has
  // exactly one. The perf tenants have two, so skipping this step makes every
  // later call fail with 422 "No branch has been selected for this booking yet."
  // Branch ids come from the clinic detail document, which is also a real step
  // in the funnel (the visitor sees the branch list before choosing).
  const detail = http.get(
    `${BASE}/api/v1/public/discovery/clinics/${clinic.id}`, P('public/clinic-detail'));
  observe(detail, 'public:clinic:detail', step);
  if (detail.status !== 200) return null;
  const branches = detail.json().branches || [];
  if (!branches.length) return null;

  const selBranch = http.post(`${BASE}/api/v1/public/booking/select/branch`,
    JSON.stringify({ branchId: branches[(__VU + (__ITER || 0)) % branches.length].id }),
    P('booking/select-branch'));
  observe(selBranch, 'public:booking:select-branch', step);
  if (selBranch.status >= 400) return null;

  const services = http.get(`${BASE}/api/v1/public/booking/services`, P('booking/services'));
  observe(services, 'public:booking:services', step);
  if (services.status !== 200) return null;
  const svc = (services.json().services) || [];
  if (!svc.length) return null;

  const selService = http.post(`${BASE}/api/v1/public/booking/select/service`,
    JSON.stringify({ serviceIds: [svc[0].id] }), P('booking/select-service'));
  observe(selService, 'public:booking:select-service', step);
  if (selService.status >= 400) return null;

  const doctors = http.get(`${BASE}/api/v1/public/booking/doctors`, P('booking/doctors'));
  observe(doctors, 'public:booking:doctors', step);
  if (doctors.status !== 200) return null;
  const docs = (doctors.json().doctors) || [];
  if (!docs.length) return null;

  const selDoctor = http.post(`${BASE}/api/v1/public/booking/select/doctor`,
    JSON.stringify({ staffId: docs[0].id }), P('booking/select-doctor'));
  observe(selDoctor, 'public:booking:select-doctor', step);
  if (selDoctor.status >= 400) return null;

  // The heaviest public read: rangeWindows loops the ~11-query availability
  // engine once PER DAY, capped at a 14-day horizon.
  const from = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const avail = http.get(
    `${BASE}/api/v1/public/booking/availability?from=${from}&to=${to}`, P('booking/availability'));
  observe(avail, 'public:booking:availability', step);
  if (avail.status !== 200) return null;
  const slots = (avail.json().slots) || [];
  if (!slots.length) return { jar, slot: null };

  const slot = slots[0];
  const selSlot = http.post(`${BASE}/api/v1/public/booking/select/slot`,
    JSON.stringify({ startAt: slot.startAt }), P('booking/select-slot'));
  observe(selSlot, 'public:booking:select-slot', step);

  return { jar, slot, P };
}

/** Opt-in write step. Throttled to 10/min per IP unless NODE_ENV=test. */
export function bookingConfirm(ctx, step) {
  if (!ctx || !ctx.slot || __ENV.BOOKING_CONFIRM !== 'true') return null;
  const res = http.post(`${BASE}/api/v1/public/booking/confirm`,
    JSON.stringify({
      fullName: `Load Test Guest ${__VU}-${__ITER}`,
      phone: `+96650${String(1000000 + (__VU * 1000 + (__ITER || 0)) % 8999999)}`,
    }),
    ctx.P('booking/confirm'));
  observe(res, 'public:booking:confirm', step);
  return res;
}
