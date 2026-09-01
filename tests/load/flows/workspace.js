/**
 * Staff, activity log, and the notification poll.
 *
 * ACTIVITY LOG is the read most sensitive to data volume: 2 queries in parallel
 * (an UNBOUNDED COUNT plus the page), both over the same joins — `users`,
 * `branches`, and a LATERAL role lookup. A `q=` search additionally ORs in
 * `entity_type`, `branch.name` and `entity_id::text`, none of which has a
 * trigram index, so a searched page is materially more expensive than a plain
 * one. Both shapes are exercised.
 *
 * THE NOTIFICATION POLL is the single highest-frequency request in the product:
 * `/notifications/inbox/unread-count` fires every 30s on every authenticated
 * page in all four shells. Steady-state background load is essentially
 * (open tabs / 30s) of this endpoint, so it is modelled explicitly.
 */
import http from 'k6/http';
import { BASE, authGet, can } from '../helpers/auth.js';
import { observe, journeyLatency } from '../helpers/metrics.js';
import { checkPagedList, checkUnreadCount, checkArray } from '../helpers/checks.js';

/**
 * `/activity*` requires `audit.read`, which the `owner` role holds and
 * `receptionist` does not. Calling it as a receptionist returns a correct 403 —
 * counting that as a failure would report a permission model working exactly as
 * designed as a load-test error, so the flow is skipped for principals that
 * cannot use it. This also mirrors real traffic: receptionists never load the
 * activity page, so including it would overstate that endpoint's real share.
 */
export function canReadActivity(session) {
  return can(session, 'audit.read');
}

export function staffPageView(session, step) {
  const p = authGet(session, { step });
  const started = Date.now();
  const res = http.batch([
    ['GET', `${BASE}/api/v1/notifications/inbox/unread-count`, null, p],
    ['GET', `${BASE}/api/v1/staff?page=1&limit=10`, null, p],
  ]);
  journeyLatency.add(Date.now() - started, { journey: 'staff', step });
  observe(res[0], 'notifications:unread', step);
  observe(res[1], 'staff:list', step);
  checkPagedList(res[1], 'staff', { step });
  return res;
}

/** Filter variants that trigger the unpaginated pre-queries in StaffService. */
export function staffFiltered(session, step) {
  const p = authGet(session, { step });
  // `?role=` loads every user_roles row for the slug then intersects in JS.
  const res = http.get(`${BASE}/api/v1/staff?role=doctor&page=1&limit=10`, p);
  observe(res, 'staff:list:role', step);
  return res;
}

/** Activity page view — the frontend issues 7 requests here. */
export function activityPageView(session, step) {
  if (!canReadActivity(session)) return null;
  const p = authGet(session, { step });
  const started = Date.now();
  const res = http.batch([
    ['GET', `${BASE}/api/v1/notifications/inbox/unread-count`, null, p],
    ['GET', `${BASE}/api/v1/activity?page=1&limit=20`, null, p],
    ['GET', `${BASE}/api/v1/staff?limit=100`, null, p],
    ['GET', `${BASE}/api/v1/branches`, null, p],
    ['GET', `${BASE}/api/v1/activity/actions`, null, p],
  ]);
  journeyLatency.add(Date.now() - started, { journey: 'activity', step });

  observe(res[0], 'notifications:unread', step);
  observe(res[1], 'activity:list', step);
  observe(res[2], 'staff:lookup', step);
  observe(res[3], 'branches:list', step);
  observe(res[4], 'activity:actions', step);
  checkPagedList(res[1], 'activity', { step });
  checkArray(res[3], 'branches', { step }, false);
  return res;
}

/** Searched activity — hits the un-indexed OR arms. */
export function activitySearch(session, step) {
  if (!canReadActivity(session)) return null;
  const p = authGet(session, { step });
  const terms = ['appointment', 'customer', 'invoice', 'payment', 'staff'];
  const q = terms[(__VU + (__ITER || 0)) % terms.length];
  const res = http.get(`${BASE}/api/v1/activity?page=1&limit=20&q=${q}`, p);
  observe(res, 'activity:list:search', step);
  return res;
}

/** The 30s background poll every open tab performs. */
export function notificationPoll(session, step) {
  const p = authGet(session, { step });
  const res = http.get(`${BASE}/api/v1/notifications/inbox/unread-count`, p);
  observe(res, 'notifications:unread', step);
  checkUnreadCount(res, { step });
  return res;
}

/** Opened notification inbox — 3 SQL with an explicit locale, 4 without. */
export function notificationInbox(session, step) {
  const p = authGet(session, { step });
  const res = http.get(
    `${BASE}/api/v1/notifications/inbox?status=all&limit=8&locale=en`, p);
  observe(res, 'notifications:inbox', step);
  return res;
}
