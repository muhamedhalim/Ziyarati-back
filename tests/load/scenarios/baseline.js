/**
 * BASELINE — the comparability anchor.
 *
 * Deliberately reproduces the four-endpoint journey the previous Artillery
 * harness used (`scripts/perf/load/journeys.yml`): analytics dashboard ->
 * appointments -> CRM customers -> staff. Keeping that shape means this suite's
 * numbers can be diffed against the historical baseline instead of starting a
 * fresh, incomparable series.
 *
 * Run this BEFORE any stress scenario and again after any performance fix.
 * "No optimisation is successful without a measurable improvement" only means
 * something if the before and after are the same test.
 *
 * Run:
 *   docker compose -f tests/load/docker-compose.yml run --rm k6 \
 *     run /scripts/scenarios/baseline.js
 */
import http from 'k6/http';
import { BASE, buildSessions, sessionFor, authGet } from '../helpers/auth.js';
import { observe, journeyLatency } from '../helpers/metrics.js';
import { checkPagedList } from '../helpers/checks.js';
import { steadyStateThresholds } from '../config/thresholds.js';

const RATE = Number(__ENV.RATE || 8);

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: Math.max(10, RATE * 2),
      maxVUs: 200,
      tags: { step: 'baseline' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: steadyStateThresholds(),
};

export function setup() {
  // OWNER SESSIONS ONLY. `/analytics/dashboard` requires
  // `analytics.dashboard.read`, which receptionists do not hold — including
  // them made a correct 403 on 1 of the 4 requests look like a 12.25% error
  // rate. The historical Artillery baseline this scenario mirrors also ran as a
  // single owner cookie, so owner-only is both correct and comparable.
  const owners = buildSessions().filter((s) => s.role === 'owner');
  if (!owners.length) throw new Error('no owner session available for baseline');
  return { sessions: owners };
}

export default function (data) {
  const session = sessionFor(data.sessions, __VU);
  const p = authGet(session, { step: 'baseline' });
  const started = Date.now();

  const res = http.batch([
    ['GET', `${BASE}/api/v1/analytics/dashboard`, null, p],
    ['GET', `${BASE}/api/v1/appointments?limit=20`, null, p],
    ['GET', `${BASE}/api/v1/crm/customers?limit=20`, null, p],
    ['GET', `${BASE}/api/v1/staff`, null, p],
  ]);
  journeyLatency.add(Date.now() - started, { journey: 'baseline', step: 'baseline' });

  observe(res[0], 'analytics:dashboard', 'baseline');
  observe(res[1], 'appointments:list', 'baseline');
  observe(res[2], 'crm:list', 'baseline');
  observe(res[3], 'staff:list', 'baseline');

  checkPagedList(res[1], 'appointments', { step: 'baseline' });
  checkPagedList(res[2], 'crm', { step: 'baseline' });
  checkPagedList(res[3], 'staff', { step: 'baseline' });
}

export function handleSummary(data) {
  const v = data.metrics.http_req_duration.values;
  const out = {
    generatedAt: new Date().toISOString(),
    scenario: 'baseline',
    rate: RATE,
    duration: __ENV.DURATION || '5m',
    http_reqs: data.metrics.http_reqs.values.count,
    rps: data.metrics.http_reqs.values.rate,
    p50_ms: v.med, p90_ms: v['p(90)'], p95_ms: v['p(95)'], p99_ms: v['p(99)'], max_ms: v.max,
    error_rate: data.metrics.http_req_failed.values.rate,
    business_check_failed: data.metrics.business_check_failed
      ? data.metrics.business_check_failed.values.rate : null,
  };
  return {
    stdout: `\n  baseline @ ${RATE} it/s — p95 ${Math.round(out.p95_ms)}ms, `
      + `errors ${(out.error_rate * 100).toFixed(2)}%\n\n`,
    '/reports/baseline.json': JSON.stringify(out, null, 2),
  };
}
