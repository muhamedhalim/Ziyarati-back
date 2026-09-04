/**
 * MIXED WORKLOAD — the realistic steady-state run.
 *
 * Drives the evidence-derived traffic mix (see flows/mixed.js) at a fixed
 * arrival rate, with thresholds that MUST pass. This is the scenario to run
 * before and after any performance fix: it is the comparable baseline.
 *
 * Run:
 *   docker compose -f tests/load/docker-compose.yml run --rm k6 \
 *     run /scripts/scenarios/mixed-workload.js
 *
 * Tunables:  RATE (iterations/s, default 20)   DURATION (default 5m)
 *            MIX_PROFILE = default | write-heavy | read-only
 */
import exec from 'k6/execution';
import { buildSessions, sessionFor } from '../helpers/auth.js';
import { mixedIteration, mixDescription } from '../flows/mixed.js';
import { steadyStateThresholds } from '../config/thresholds.js';

const RATE = Number(__ENV.RATE || 20);

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: Math.max(20, RATE * 2),
      maxVUs: 600,
      tags: { step: 'mixed' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // 100 accounts x bcrypt cost-12 login + a tenant-context fan-out each: the 60s
  // default kills the run in setup() at TEST_TENANTS=50, with no results at all.
  setupTimeout: '600s',
  thresholds: steadyStateThresholds(),
};

export function setup() {
  const sessions = buildSessions();
  console.log(`mixed-workload: rate=${RATE}/s profile=${mixDescription()} sessions=${sessions.length}`);
  return { sessions };
}

export default function (data) {
  mixedIteration(sessionFor(data.sessions, __VU), 'mixed');
}

export function handleSummary(data) {
  const endpoints = {};
  const allKeys = Object.keys(data.metrics);
  for (const key of allKeys) {
    const m = /^endpoint_latency\{endpoint:([^,}]+)\}$/.exec(key);
    if (m) {
      const v = data.metrics[key].values;
      // k6 Trend values expose avg/min/med/max/percentiles but NO `count`, so
      // an endpoint that was never exercised shows up as all-zeros rather than
      // being absent. Filter on that instead of on a count that does not exist.
      if (!v.max) continue;
      endpoints[m[1]] = {
        avg_ms: v.avg, med_ms: v.med, p95_ms: v['p(95)'], p99_ms: v['p(99)'], max_ms: v.max,
      };
    }
  }
  const out = {
    generatedAt: new Date().toISOString(),
    rate: RATE,
    profile: mixDescription(),
    duration: __ENV.DURATION || '5m',
    http_reqs: data.metrics.http_reqs.values.count,
    rps: data.metrics.http_reqs.values.rate,
    error_rate: data.metrics.http_req_failed.values.rate,
    business_check_failed: data.metrics.business_check_failed
      ? data.metrics.business_check_failed.values.rate : null,
    p50_ms: data.metrics.http_req_duration.values.med,
    p95_ms: data.metrics.http_req_duration.values['p(95)'],
    p99_ms: data.metrics.http_req_duration.values['p(99)'],
    appt_created: data.metrics.appt_created ? data.metrics.appt_created.values.count : 0,
    appt_conflict_409: data.metrics.appt_conflict_409 ? data.metrics.appt_conflict_409.values.count : 0,
    rate_limited_429: data.metrics.http_429_rate_limited ? data.metrics.http_429_rate_limited.values.count : 0,
    server_5xx: data.metrics.http_5xx ? data.metrics.http_5xx.values.count : 0,
    endpoints,
  };
  return {
    stdout: `\n  mixed-workload @ ${RATE} it/s — p95 ${Math.round(out.p95_ms)}ms, `
      + `errors ${(out.error_rate * 100).toFixed(2)}%, ${Math.round(out.rps)} req/s\n`
      + `  report: tests/load/reports/mixed-workload.json\n\n`,
    '/reports/mixed-workload.json': JSON.stringify(out, null, 2),
  };
}
