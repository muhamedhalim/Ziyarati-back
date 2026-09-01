/**
 * PROGRESSIVE SWEEP — the load-characterisation run.
 *
 * Answers, from measurement rather than inference:
 *   - at what load does latency degradation begin?
 *   - at what load do errors begin?
 *   - at what load is the system unhealthy / broken?
 *
 * WHY ARRIVAL RATE, NOT VUs. This API is single-threaded Node; a prior audit
 * settled the saturating component as CPU/event-loop, not the DB pool (which
 * peaked at 2-4 of 10 connections). Past saturation, adding VUs does not add
 * load — it just grows a queue, and every VU-based "stage" past the knee
 * reports the same thing: timeouts. `constant-arrival-rate` keeps offered load
 * fixed and lets the queue form where it really forms, which is what makes the
 * per-step numbers comparable.
 *
 * Each step is a separate scenario with its own `step` tag, so k6 prints
 * per-step sub-metrics and handleSummary can build the degradation table
 * directly from them.
 *
 * Run:
 *   docker compose -f tests/load/docker-compose.yml run --rm k6 \
 *     run /scripts/scenarios/progressive-sweep.js
 */
import exec from 'k6/execution';
import { buildSessions, sessionFor } from '../helpers/auth.js';
import { mixedIteration, mixDescription } from '../flows/mixed.js';
import { sweepReportingThresholds } from '../config/thresholds.js';

/**
 * Rates in ITERATIONS/s (one iteration = one user action = 1-6 HTTP requests).
 * Concentrated between 20 and 60 because a calibration probe located the knee
 * there; the tails exist to prove healthy and broken behaviour respectively.
 */
const RATES = __ENV.RATES
  ? __ENV.RATES.split(',').map(Number)
  : [5, 10, 20, 40, 60, 70, 80, 90, 100, 110];
const STEP_DURATION = __ENV.STEP_DURATION || '40s';
const STEP_GAP = 5; // seconds of quiet between steps so queues drain

const scenarios = {};
let t = 0;
for (const rate of RATES) {
  scenarios[`r${rate}`] = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    duration: STEP_DURATION,
    preAllocatedVUs: Math.max(20, rate * 2),
    maxVUs: 600,
    startTime: `${t}s`,
    tags: { step: `r${rate}` },
    exec: 'sweep',
    gracefulStop: '10s',
  };
  t += parseInt(STEP_DURATION, 10) + STEP_GAP;
}

export const options = {
  scenarios,
  // p99 is not in k6's default trend stats, and the degradation table needs it.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Reporting-only: the sweep deliberately drives past breaking point, so
  // pass/fail here would be meaningless. These force per-step sub-metric output.
  thresholds: sweepReportingThresholds(RATES.map((r) => `r${r}`)),
};

export function setup() {
  const sessions = buildSessions();
  console.log(`sweep: profile=${mixDescription()} sessions=${sessions.length} rates=${RATES.join(',')}`);
  return { sessions };
}

export function sweep(data) {
  const session = sessionFor(data.sessions, __VU);
  // The scenario name IS the step label (r5, r10, ...), so every metric this
  // iteration records is attributed to the arrival rate that produced it.
  mixedIteration(session, exec.scenario.name);
}

/**
 * Emits the degradation table as JSON so the analysis step is reading real
 * numbers instead of re-typing them out of the console.
 */
export function handleSummary(data) {
  const rows = [];
  for (const rate of RATES) {
    const step = `r${rate}`;
    const dur = data.metrics[`http_req_duration{step:${step}}`];
    const fail = data.metrics[`http_req_failed{step:${step}}`];
    if (!dur) continue;
    rows.push({
      rate_iterations_per_s: rate,
      requests: fail ? fail.values.passes + fail.values.fails : null,
      p50_ms: dur.values.med,
      p90_ms: dur.values['p(90)'],
      p95_ms: dur.values['p(95)'],
      p99_ms: dur.values['p(99)'],
      max_ms: dur.values.max,
      error_rate: fail ? fail.values.rate : null,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    profile: mixDescription(),
    rates: RATES,
    stepDuration: STEP_DURATION,
    steps: rows,
    totals: {
      http_reqs: data.metrics.http_reqs ? data.metrics.http_reqs.values.count : null,
      http_req_failed_rate: data.metrics.http_req_failed
        ? data.metrics.http_req_failed.values.rate : null,
      business_check_failed_rate: data.metrics.business_check_failed
        ? data.metrics.business_check_failed.values.rate : null,
      rate_limited_429: data.metrics.http_429_rate_limited
        ? data.metrics.http_429_rate_limited.values.count : 0,
      server_5xx: data.metrics.http_5xx ? data.metrics.http_5xx.values.count : 0,
      timeouts: data.metrics.http_timeout_or_conn
        ? data.metrics.http_timeout_or_conn.values.count : 0,
      dropped_iterations: data.metrics.dropped_iterations
        ? data.metrics.dropped_iterations.values.count : 0,
    },
  };

  // Per-endpoint latency, so the report can rank the slowest endpoints.
  const endpoints = {};
  for (const key of Object.keys(data.metrics)) {
    const m = /^endpoint_latency\{endpoint:([^,}]+)\}$/.exec(key);
    if (m) {
      endpoints[m[1]] = {
        p95_ms: data.metrics[key].values['p(95)'],
        med_ms: data.metrics[key].values.med,
        count: data.metrics[key].values.count,
      };
    }
  }
  summary.endpoints = endpoints;

  return {
    stdout: textTable(rows),
    '/reports/progressive-sweep.json': JSON.stringify(summary, null, 2),
  };
}

function textTable(rows) {
  let out = '\n  PROGRESSIVE SWEEP — measured degradation curve\n';
  out += '  ---------------------------------------------------------------\n';
  out += '   iters/s |   p50   |   p95   |   p99   |    max   | error rate\n';
  out += '  ---------------------------------------------------------------\n';
  for (const r of rows) {
    const f = (v) => (v == null ? '     -' : `${Math.round(v)}ms`.padStart(7));
    out += `  ${String(r.rate_iterations_per_s).padStart(8)} |${f(r.p50_ms)} |${f(r.p95_ms)} |`
      + `${f(r.p99_ms)} |${f(r.max_ms)} | ${(r.error_rate * 100).toFixed(2)}%\n`;
  }
  out += '  ---------------------------------------------------------------\n';
  out += '  Full report: tests/load/reports/progressive-sweep.json\n\n';
  return out;
}
