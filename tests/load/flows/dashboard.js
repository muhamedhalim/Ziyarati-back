/**
 * Clinic dashboard page view.
 *
 * Mirrors the exact fan-out asserted by the frontend's own
 * `dashboard-requests.test.tsx`: an owner issues 7 requests, of which
 * `/auth/me` fires once per session (cached in AuthProvider, not per view), and
 * the remaining 6 go out concurrently once auth resolves. We reproduce that
 * concurrency with http.batch rather than issuing them serially, because
 * serialising them would understate peak connection pressure.
 */
import http from 'k6/http';
import { BASE, authGet, can } from '../helpers/auth.js';
import { observe, journeyLatency } from '../helpers/metrics.js';
import { checkDashboardSummary, checkUnreadCount } from '../helpers/checks.js';

/** Trailing N-day range in YYYY-MM-DD, as the analytics hooks send it. */
export function trailingRange(days, offsetDays) {
  const shift = (offsetDays || 0) * 86400000;
  const to = new Date(Date.now() - shift);
  const from = new Date(to.getTime() - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export function dashboardPageView(session, step) {
  const p = authGet(session, { step });
  // CACHE_BUST rotates the analytics cache key so the 60s Redis cache does not
  // mask real aggregation cost. Off by default: the realistic user hits cache.
  const offset = __ENV.CACHE_BUST === 'true' ? (__VU * 7 + __ITER) % 300 : 0;
  const r = trailingRange(14, offset);

  // The real page issues the analytics trio ONLY to a principal holding
  // `analytics.reports.read` — an owner sends 7 requests, a receptionist 4.
  // Reproducing that split matters twice over: it keeps the traffic mix honest,
  // and it stops a receptionist VU from spending the run collecting correct 403s.
  const analytics = can(session, 'analytics.reports.read');

  const batch = [
    ['GET', `${BASE}/api/v1/tenants/me`, null, p],
    ['GET', `${BASE}/api/v1/notifications/inbox/unread-count`, null, p],
    ['GET', `${BASE}/api/v1/dashboard/summary`, null, p],
  ];
  if (analytics) {
    batch.push(['GET', `${BASE}/api/v1/tenants/me/targets`, null, p]);
    batch.push(['GET', `${BASE}/api/v1/analytics/trends/appointments?from=${r.from}&to=${r.to}`, null, p]);
    batch.push(['GET', `${BASE}/api/v1/analytics/trends/revenue?from=${r.from}&to=${r.to}`, null, p]);
  }

  const started = Date.now();
  const res = http.batch(batch);
  journeyLatency.add(Date.now() - started, { journey: 'dashboard', step });

  observe(res[0], 'tenants:me', step);
  observe(res[1], 'notifications:unread', step);
  observe(res[2], 'dashboard', step);
  if (analytics) {
    observe(res[3], 'tenants:targets', step);
    observe(res[4], 'analytics:trend:appointments', step);
    observe(res[5], 'analytics:trend:revenue', step);
  }

  checkDashboardSummary(res[2], { step });
  checkUnreadCount(res[1], { step });
  return res;
}

/**
 * The one uncached heavy analytics endpoint (`/analytics/performance/staff`):
 * 3 parallel 3-level-join GROUP BYs, deliberately never cached. Every request
 * is genuine database work, which makes it the best analytics load target.
 */
export function staffPerformanceReport(session, step) {
  if (!can(session, 'analytics.reports.read')) return null;
  const p = authGet(session, { step });
  const r = trailingRange(90, 0);
  const res = http.get(
    `${BASE}/api/v1/analytics/performance/staff?from=${r.from}&to=${r.to}&page=1&limit=20`, p);
  observe(res, 'analytics:performance:staff', step);
  return res;
}
