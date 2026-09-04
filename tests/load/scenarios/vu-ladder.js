/**
 * MASSIVE-SCALE VU LADDER — 100 → 10,000 concurrent users.
 *
 * WHY A VU LADDER AT ALL, given the existing arrival-rate sweep.
 * They answer different questions and the suite needs both:
 *   - `progressive-sweep.js` fixes OFFERED load and asks "what does the system
 *     do with N requests per second". That is the capacity number.
 *   - This file fixes the number of CONCURRENT USERS and asks "what does a user
 *     experience when N of them are on the system at once". That is the
 *     queueing number, and it is the one a capacity plan is stated in.
 *
 * THINK TIME IS THE WHOLE BALLGAME. A VU with no think time is not a user: it
 * is an infinite-speed robot, and 100 of them already offer more load than this
 * API can serve, so a ladder from 100 to 10,000 would report "saturated" at
 * every rung and measure nothing but queue depth. `THINK_MS` (default 3000)
 * makes one VU a user taking an action roughly every 3s + latency, so offered
 * action rate ≈ VUs / (THINK_MS/1000 + latency). Set `THINK_MS=0` deliberately
 * to reproduce the degenerate no-think-time case — the report runs that as an
 * explicit control rather than leaving the difference to interpretation.
 *
 * RECOVERY IS MEASURED, NOT ASSUMED. Each load level is followed by a low-rate
 * probe scenario at PROBE_RATE it/s, tagged `rec<level>`. Its p95 answers "how
 * quickly does the API come back after that burst" directly, instead of
 * inferring recovery from the tail of the burst itself.
 *
 * Run (from Ziyarati-back/):
 *   TEST_PASSWORD='...' TEST_TENANTS=50 MIX_PROFILE=prod-mix \
 *   docker compose -f tests/load/docker-compose.yml run --rm k6 \
 *     run /scripts/scenarios/vu-ladder.js
 */
import exec from 'k6/execution';
import { sleep } from 'k6';
import http from 'k6/http';
import { Rate, Counter } from 'k6/metrics';
import {
  BASE, buildSessions, sessionFor, otherTenantSession, authGet,
} from '../helpers/auth.js';
import { mixedIteration, mixDescription } from '../flows/mixed.js';
import { endpointReportingThresholds } from '../config/thresholds.js';

const LEVELS = __ENV.LEVELS
  ? __ENV.LEVELS.split(',').map(Number)
  : [100, 500, 1000, 2500, 5000, 10000];

const RAMP = __ENV.RAMP || '30s';
const HOLD = __ENV.HOLD || '60s';
const GAP = __ENV.GAP || '30s';
const PROBE_RATE = Number(__ENV.PROBE_RATE || 5);
const THINK_MS = Number(__ENV.THINK_MS === undefined ? 3000 : __ENV.THINK_MS);
const RUN_TAG = __ENV.RUN_TAG || 'vu-ladder';

const secs = (s) => {
  const m = /^(\d+)(s|m)$/.exec(String(s));
  if (!m) return Number(s) || 0;
  return Number(m[1]) * (m[2] === 'm' ? 60 : 1);
};

/**
 * Tenant isolation, asserted IN FLIGHT rather than only after the fact.
 * A fraction of iterations asks for an appointment id that belongs to a
 * DIFFERENT tenant. The only correct answers are 403 and 404; a 200 is a
 * cross-tenant read and the run's most severe possible finding.
 */
export const isolationViolation = new Counter('tenant_isolation_violation');
export const isolationProbe = new Counter('tenant_isolation_probe');
export const isolationOk = new Rate('tenant_isolation_ok');

const scenarios = {};
let t = 0;
const RAMP_S = secs(RAMP);
const HOLD_S = secs(HOLD);
const GAP_S = secs(GAP);

for (const level of LEVELS) {
  scenarios[`vu${level}`] = {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { target: level, duration: RAMP },   // ramp, never an instantaneous jump
      { target: level, duration: HOLD },   // steady state — the measured window
      { target: 0, duration: '10s' },
    ],
    startTime: `${t}s`,
    // A VU mid-iteration when the stage ends is allowed to finish, otherwise the
    // level's own tail latencies are truncated out of its own measurement.
    gracefulRampDown: '20s',
    tags: { step: `vu${level}`, run: RUN_TAG },
    exec: 'ladder',
  };
  t += RAMP_S + HOLD_S + 10;

  scenarios[`rec${level}`] = {
    executor: 'constant-arrival-rate',
    rate: PROBE_RATE,
    timeUnit: '1s',
    duration: GAP,
    preAllocatedVUs: Math.max(10, PROBE_RATE * 4),
    maxVUs: 200,
    startTime: `${t}s`,
    tags: { step: `rec${level}`, run: RUN_TAG },
    exec: 'probe',
  };
  t += GAP_S;
}

export const options = {
  scenarios,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // 100 accounts x bcrypt cost-12 login + a tenant-context fan-out each. The
  // 60s default is not close to enough and fails the run in setup().
  setupTimeout: '600s',
  // The ladder deliberately drives past breaking point, so pass/fail thresholds
  // would be meaningless. These exist to force per-step sub-metrics into the
  // summary, which is what the capacity matrix is built from. The ONE real
  // assertion is tenant isolation: a single violation fails the run.
  thresholds: Object.assign(endpointReportingThresholds(), {
    tenant_isolation_violation: ['count<1'],
    ...Object.fromEntries(
      LEVELS.flatMap((l) => [
        [`http_req_duration{step:vu${l}}`, ['p(95)<600000']],
        [`http_req_failed{step:vu${l}}`, ['rate<=1']],
        [`http_reqs{step:vu${l}}`, ['count>=0']],
        [`http_req_duration{step:rec${l}}`, ['p(95)<600000']],
        [`http_req_failed{step:rec${l}}`, ['rate<=1']],
        [`http_reqs{step:rec${l}}`, ['count>=0']],
      ]),
    ),
  }),
};

export function setup() {
  const sessions = buildSessions();
  const tenants = {};
  for (const s of sessions) tenants[s.tenantId] = true;
  console.log(
    `vu-ladder: levels=${LEVELS.join(',')} think=${THINK_MS}ms ` +
    `profile=${mixDescription()} sessions=${sessions.length} ` +
    `tenants=${Object.keys(tenants).length} skew=${__ENV.TENANT_SKEW || 0}`,
  );

  // One appointment id per session, harvested once, so the isolation probe has
  // a REAL foreign id to ask for. Asking for a random uuid would prove nothing:
  // a 404 would be correct for a nonexistent row regardless of tenancy.
  for (const s of sessions) {
    const res = http.get(`${BASE}/api/v1/appointments?page=1&limit=1`, authGet(s, { name: 'setup/probe-id' }));
    try {
      const b = res.json();
      s.probeAppointmentId = b.data && b.data.length ? b.data[0].id : null;
    } catch (e) { s.probeAppointmentId = null; }
  }
  return { sessions };
}

function think() {
  if (THINK_MS > 0) sleep(THINK_MS / 1000);
}

export function ladder(data) {
  const session = sessionFor(data.sessions, __VU);
  mixedIteration(session, exec.scenario.name);

  if (__ENV.ISOLATION_PROBE !== 'false' && (__ITER || 0) % 20 === 0) {
    crossTenantProbe(data.sessions, session, exec.scenario.name);
  }
  think();
}

export function probe(data) {
  const session = sessionFor(data.sessions, __VU);
  mixedIteration(session, exec.scenario.name);
}

/**
 * Reads another tenant's appointment with THIS session's credentials.
 *
 * `responseCallback` is not cosmetic. This probe's CORRECT outcome is a 403 or
 * 404, and k6's default `expected_response` treats every >=400 as a failure —
 * so without it the probe injected its own ~3.5% into `http_req_failed` at
 * every level, which is exactly the number the healthy/degraded classification
 * is read off. Measured in the dry run: 100 probes of 2,902 requests reported
 * as a 3.48% error rate on an otherwise clean system.
 */
const ISOLATION_EXPECTED = http.expectedStatuses(403, 404);

function crossTenantProbe(sessions, session, step) {
  const foreign = otherTenantSession(sessions, session);
  if (!foreign || !foreign.probeAppointmentId) return;
  const params = authGet(session, { step, endpoint: 'isolation:probe' });
  params.responseCallback = ISOLATION_EXPECTED;
  const res = http.get(
    `${BASE}/api/v1/appointments/${foreign.probeAppointmentId}`,
    params,
  );
  isolationProbe.add(1, { step });
  const denied = res.status === 403 || res.status === 404;
  isolationOk.add(denied, { step });
  if (res.status === 200) isolationViolation.add(1, { step });
}

export function handleSummary(data) {
  const m = (name) => data.metrics[name];
  const v = (name, key) => (m(name) ? m(name).values[key] : null);

  const levels = LEVELS.map((l) => {
    const step = `vu${l}`;
    const dur = m(`http_req_duration{step:${step}}`);
    const fail = m(`http_req_failed{step:${step}}`);
    const reqs = fail ? fail.values.passes + fail.values.fails : 0;
    const rec = m(`http_req_duration{step:rec${l}}`);
    const recFail = m(`http_req_failed{step:rec${l}}`);
    return {
      vus: l,
      requests: reqs,
      // The measured window is ramp + hold + drain; achieved RPS is reported
      // against that same window so it is comparable across levels.
      achieved_rps: reqs / (RAMP_S + HOLD_S + 10),
      p50_ms: dur ? dur.values.med : null,
      p95_ms: dur ? dur.values['p(95)'] : null,
      p99_ms: dur ? dur.values['p(99)'] : null,
      max_ms: dur ? dur.values.max : null,
      error_rate: fail ? fail.values.rate : null,
      recovery_p95_ms: rec ? rec.values['p(95)'] : null,
      recovery_error_rate: recFail ? recFail.values.rate : null,
    };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    runTag: RUN_TAG,
    config: {
      levels: LEVELS,
      ramp: RAMP,
      hold: HOLD,
      gap: GAP,
      probeRate: PROBE_RATE,
      thinkMs: THINK_MS,
      profile: mixDescription(),
      tenantSkew: Number(__ENV.TENANT_SKEW || 0),
      baseUrl: BASE,
    },
    levels,
    totals: {
      http_reqs: v('http_reqs', 'count'),
      http_req_failed_rate: v('http_req_failed', 'rate'),
      business_check_failed_rate: v('business_check_failed', 'rate'),
      rate_limited_429: v('http_429_rate_limited', 'count') || 0,
      client_4xx: v('http_4xx', 'count') || 0,
      server_5xx: v('http_5xx', 'count') || 0,
      timeouts_or_conn: v('http_timeout_or_conn', 'count') || 0,
      // GENERATOR-SIDE, not server-side. A dropped iteration means k6 could not
      // start work it had scheduled, so offered load was BELOW target — the
      // opposite of a server failure, and the two must never be conflated.
      dropped_iterations: v('dropped_iterations', 'count') || 0,
      appt_created: v('appt_created', 'count') || 0,
      appt_conflict_409: v('appt_conflict_409', 'count') || 0,
      appt_quota_422: v('appt_quota_422', 'count') || 0,
      vus_max: v('vus_max', 'max'),
      iterations: v('iterations', 'count'),
    },
    tenantIsolation: {
      probes: v('tenant_isolation_probe', 'count') || 0,
      violations: v('tenant_isolation_violation', 'count') || 0,
      denied_rate: v('tenant_isolation_ok', 'rate'),
    },
  };

  const endpoints = {};
  for (const key of Object.keys(data.metrics)) {
    const mm = /^endpoint_latency\{endpoint:([^,}]+)\}$/.exec(key);
    if (mm) {
      endpoints[mm[1]] = {
        p95_ms: data.metrics[key].values['p(95)'],
        med_ms: data.metrics[key].values.med,
        count: data.metrics[key].values.count,
      };
    }
  }
  summary.endpoints = endpoints;

  return {
    stdout: table(levels, summary),
    [`/reports/${RUN_TAG}.json`]: JSON.stringify(summary, null, 2),
  };
}

function table(rows, summary) {
  let out = `\n  VU LADDER — ${summary.runTag} (think=${THINK_MS}ms, profile=${summary.config.profile})\n`;
  out += '  --------------------------------------------------------------------------------\n';
  out += '      VUs |  req/s |   p50   |   p95   |   p99   | err %  | recovery p95\n';
  out += '  --------------------------------------------------------------------------------\n';
  for (const r of rows) {
    const f = (x) => (x == null ? '      -' : `${Math.round(x)}ms`.padStart(7));
    out += `  ${String(r.vus).padStart(7)} |${String(Math.round(r.achieved_rps)).padStart(7)} |`
      + `${f(r.p50_ms)} |${f(r.p95_ms)} |${f(r.p99_ms)} | `
      + `${((r.error_rate || 0) * 100).toFixed(2).padStart(6)} |${f(r.recovery_p95_ms)}\n`;
  }
  out += '  --------------------------------------------------------------------------------\n';
  out += `  5xx=${summary.totals.server_5xx}  timeouts=${summary.totals.timeouts_or_conn}  `
    + `dropped_iters(generator-side)=${summary.totals.dropped_iterations}\n`;
  out += `  tenant isolation: ${summary.tenantIsolation.probes} probes, `
    + `${summary.tenantIsolation.violations} VIOLATIONS\n`;
  out += `  report: tests/load/reports/${summary.runTag}.json\n\n`;
  return out;
}
