/**
 * Business-behaviour checks.
 *
 * An HTTP 200 is NOT success here. Several endpoints return 200 with an empty
 * envelope when nothing matched, and `/analytics/*` returns `empty: true` with
 * `data: []` for a tenant with no data — a status-only assertion would pass
 * against a completely empty system and report a meaningless "healthy" result.
 * Every check below asserts the response actually carries the business payload
 * the endpoint exists to produce.
 */
import { check } from 'k6';
import { Rate } from 'k6/metrics';

export const businessErrors = new Rate('business_check_failed');

function record(res, name, assertions, tags) {
  const ok = check(res, assertions, tags);
  businessErrors.add(!ok, tags);
  return ok;
}

const json = (res) => {
  try { return res.json(); } catch (e) { return null; }
};

/** `{ data: [], total, page, limit }` — the standard paged envelope. */
export function checkPagedList(res, name, tags) {
  return record(res, name, {
    [`${name}: 200`]: (r) => r.status === 200,
    [`${name}: has data array`]: (r) => { const b = json(r); return !!b && Array.isArray(b.data); },
    [`${name}: total is a number`]: (r) => { const b = json(r); return !!b && typeof b.total === 'number'; },
    // Guard the array before reading .length. Under saturation the body is an
    // error envelope (or nothing at all) with no `data` key, and an unguarded
    // `b.data.length` throws inside the check — which aborts the whole iteration
    // and silently distorts exactly the high-load steps we care most about.
    [`${name}: page is populated`]: (r) => {
      const b = json(r);
      return !!b && Array.isArray(b.data) && b.data.length > 0;
    },
  }, tags);
}

/** Dashboard summary: counts may legitimately be null (permission-scoped). */
export function checkDashboardSummary(res, tags) {
  return record(res, 'dashboard', {
    'dashboard: 200': (r) => r.status === 200,
    'dashboard: customers count present': (r) => {
      const b = json(r); return !!b && typeof b.customers === 'number';
    },
    'dashboard: scope resolved': (r) => {
      const b = json(r); return !!b && !!b.scope && typeof b.scope.appointments === 'string';
    },
  }, tags);
}

/** `{ count: n }` */
export function checkUnreadCount(res, tags) {
  return record(res, 'unread', {
    'unread: 200': (r) => r.status === 200,
    'unread: count is a number': (r) => { const b = json(r); return !!b && typeof b.count === 'number'; },
  }, tags);
}

/** Bare JSON array endpoints (services/lookup, branches, activity/actions). */
export function checkArray(res, name, tags, allowEmpty) {
  return record(res, name, {
    [`${name}: 200`]: (r) => r.status === 200,
    [`${name}: array`]: (r) => Array.isArray(json(r)),
    [`${name}: non-empty`]: (r) => allowEmpty || (Array.isArray(json(r)) && json(r).length > 0),
  }, tags);
}

/** Availability windows: `available` plus a real slot list. */
export function checkAvailability(res, tags) {
  return record(res, 'availability', {
    'availability: 200': (r) => r.status === 200,
    'availability: has windows array': (r) => {
      const b = json(r); return !!b && Array.isArray(b.windows);
    },
    'availability: bookable': (r) => {
      const b = json(r); return !!b && b.available === true && b.windows.length > 0;
    },
  }, tags);
}

/**
 * Appointment creation. 201 is success; 409 is a REAL and expected outcome
 * under contention (STAFF_NOT_AVAILABLE from the pre-check, or
 * SLOT_ALREADY_BOOKED from the gist exclusion constraint losing a race).
 * We count them separately rather than calling them failures.
 */
export function checkAppointmentCreate(res, tags) {
  return record(res, 'appt-create', {
    'appt-create: 201 or expected 409': (r) => r.status === 201 || r.status === 409,
    'appt-create: id returned on success': (r) => {
      if (r.status !== 201) return true;
      const b = json(r); return !!b && typeof b.id === 'string';
    },
  }, tags);
}

/** Classifies a response for the progressive-sweep report. */
export function classify(res) {
  if (res.status === 0) return 'timeout_or_conn';
  if (res.status === 429) return 'rate_limited';
  if (res.status >= 500) return 'server_5xx';
  if (res.status >= 400) return 'client_4xx';
  return 'ok';
}
