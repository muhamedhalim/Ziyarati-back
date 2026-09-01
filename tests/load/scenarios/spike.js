/**
 * SPIKE — sudden surge and, more importantly, RECOVERY.
 *
 * Ramps from a calm baseline to a multiple of the measured knee in under a
 * minute, holds briefly, then drops back to the baseline and keeps running.
 * The interesting question is not "does it degrade under the spike" (it will)
 * but "does it come back" — the trailing calm segment is the actual test.
 *
 * Watch for, in the per-step output:
 *   - `recovery` p95 returning to `pre` p95. If it does not, something did not
 *     drain: the event loop is still working through a backlog, a pool is still
 *     saturated, or connections were never released.
 *   - `http_5xx` and `http_timeout_or_conn` during `spike` vs `recovery`.
 *   - dropped_iterations, which means k6 itself could not keep up — offered
 *     load below what the config asked for, so the spike was even shorter than
 *     it looks.
 */
import exec from 'k6/execution';
import { buildSessions, sessionFor } from '../helpers/auth.js';
import { mixedIteration } from '../flows/mixed.js';

const BASE_RATE = Number(__ENV.RATE || 10);
const PEAK_RATE = Number(__ENV.PEAK_RATE || 100);

export const options = {
  scenarios: {
    pre: {
      executor: 'constant-arrival-rate',
      rate: BASE_RATE, timeUnit: '1s', duration: '1m',
      preAllocatedVUs: 40, maxVUs: 600,
      tags: { step: 'pre' }, exec: 'run',
    },
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: BASE_RATE, timeUnit: '1s',
      preAllocatedVUs: 100, maxVUs: 800,
      startTime: '1m',
      stages: [
        { target: PEAK_RATE, duration: '30s' },  // surge
        { target: PEAK_RATE, duration: '1m' },   // hold
      ],
      tags: { step: 'spike' }, exec: 'run',
    },
    recovery: {
      executor: 'constant-arrival-rate',
      rate: BASE_RATE, timeUnit: '1s', duration: '2m',
      preAllocatedVUs: 40, maxVUs: 600,
      startTime: '2m40s',
      tags: { step: 'recovery' }, exec: 'run',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // Reporting sub-metrics; the recovery comparison is the real assertion and
    // is made explicit in handleSummary.
    'http_req_duration{step:pre}': ['p(95)<600000'],
    'http_req_duration{step:spike}': ['p(95)<600000'],
    'http_req_duration{step:recovery}': ['p(95)<600000'],
    'http_req_failed{step:recovery}': ['rate<=1'],
  },
};

export function setup() { return { sessions: buildSessions() }; }

export function run(data) {
  mixedIteration(sessionFor(data.sessions, __VU), exec.scenario.name);
}

export function handleSummary(data) {
  const p95 = (step) => {
    const m = data.metrics[`http_req_duration{step:${step}}`];
    return m ? m.values['p(95)'] : null;
  };
  const errs = (step) => {
    const m = data.metrics[`http_req_failed{step:${step}}`];
    return m ? m.values.rate : null;
  };

  const pre = p95('pre');
  const rec = p95('recovery');
  // "Recovered" = post-spike p95 within 1.5x of the pre-spike p95.
  const recovered = pre != null && rec != null && rec <= pre * 1.5;

  const out = {
    generatedAt: new Date().toISOString(),
    baseRate: BASE_RATE, peakRate: PEAK_RATE,
    pre: { p95_ms: pre, error_rate: errs('pre') },
    spike: { p95_ms: p95('spike'), error_rate: errs('spike') },
    recovery: { p95_ms: rec, error_rate: errs('recovery') },
    recovered,
    dropped_iterations: data.metrics.dropped_iterations
      ? data.metrics.dropped_iterations.values.count : 0,
    server_5xx: data.metrics.http_5xx ? data.metrics.http_5xx.values.count : 0,
    timeouts: data.metrics.http_timeout_or_conn
      ? data.metrics.http_timeout_or_conn.values.count : 0,
  };

  return {
    stdout: `\n  spike ${BASE_RATE} -> ${PEAK_RATE} it/s\n`
      + `    pre      p95 ${pre == null ? '-' : Math.round(pre) + 'ms'}\n`
      + `    spike    p95 ${out.spike.p95_ms == null ? '-' : Math.round(out.spike.p95_ms) + 'ms'}\n`
      + `    recovery p95 ${rec == null ? '-' : Math.round(rec) + 'ms'}  => `
      + `${recovered ? 'RECOVERED' : 'DID NOT RECOVER'}\n\n`,
    '/reports/spike.json': JSON.stringify(out, null, 2),
  };
}
