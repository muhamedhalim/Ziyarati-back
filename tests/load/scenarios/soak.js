/**
 * SOAK — sustained moderate load, looking for drift rather than a peak.
 *
 * Runs BELOW the knee on purpose. A soak that saturates tells you nothing new;
 * the point is to hold a comfortable rate long enough for slow problems to
 * appear: memory growth, event-loop lag creeping up, connections not being
 * returned, queue depth accumulating, caches degrading.
 *
 * READ THE METRICS ENDPOINT ALONGSIDE THIS RUN — k6 alone cannot see a leak.
 * Sample the API's Prometheus endpoint on an interval for the whole window:
 *
 *   watch -n 30 'curl -s localhost:3001/api/v1/metrics | grep -E \
 *     "nodejs_heap_size_used_bytes|nodejs_eventloop_lag_seconds|process_resident_memory_bytes|nodejs_active_handles_total"'
 *
 * A leak looks like monotonically rising `nodejs_heap_size_used_bytes` and
 * `process_resident_memory_bytes` that do NOT fall after a GC, together with a
 * flat request rate. Rising `nodejs_eventloop_lag_seconds` at constant load is
 * the same story from the scheduler's side.
 *
 * TOKEN LIFETIME CAVEAT: access tokens live 15 minutes and this suite
 * deliberately never refreshes mid-run (refresh rotation is single-use, so
 * concurrent refreshes across VUs would produce 401s and eventually revoke the
 * family). A soak longer than 15 minutes therefore needs re-authentication —
 * `SOAK_RELOGIN=true` re-logs each VU in on a timer, staggered so the bcrypt
 * cost does not arrive as one thundering herd.
 */
import exec from 'k6/execution';
import { sleep } from 'k6';
import { buildSessions, sessionFor, login, loadTenantContext, accountList } from '../helpers/auth.js';
import { mixedIteration } from '../flows/mixed.js';

const RATE = Number(__ENV.RATE || 15);
const RELOGIN_AFTER_MS = Number(__ENV.RELOGIN_AFTER_MS || 10 * 60 * 1000);

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60m',
      preAllocatedVUs: Math.max(30, RATE * 3),
      maxVUs: 400,
      tags: { step: 'soak' },
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // 100 accounts x bcrypt cost-12 login + a tenant-context fan-out each: the 60s
  // default kills the run in setup() at TEST_TENANTS=50, with no results at all.
  setupTimeout: '600s',
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'business_check_failed': ['rate<0.01'],
  },
};

export function setup() {
  const sessions = buildSessions();
  console.log(`soak: rate=${RATE}/s duration=${__ENV.DURATION || '60m'} sessions=${sessions.length}`);
  return { sessions, startedAt: Date.now() };
}

/** Per-VU refreshed session, used only when SOAK_RELOGIN is on. */
let vuSession = null;
let vuSessionAt = 0;

export default function (data) {
  let session = sessionFor(data.sessions, __VU);

  if (__ENV.SOAK_RELOGIN === 'true') {
    const now = Date.now();
    // Stagger by VU so 400 VUs do not all pay bcrypt in the same second.
    const jitter = (__VU % 60) * 1000;
    // The clock starts at SETUP, not at this VU's first iteration.
    //
    // `!vuSession ||` used to force a login the first time every VU ran — even
    // though setup() had already handed it a perfectly valid session. With
    // `preAllocatedVUs = RATE * 3` that is a few hundred bcrypt cost-12 logins
    // in the opening seconds, and bcrypt BLOCKS the single event loop: measured
    // at RATE=80, the soak delivered 12-17 it/s against a target of 80 for its
    // first five minutes while the API's own event-loop lag read ~0 (it was not
    // overloaded — it was serialised behind bcrypt), and VUs that timed out
    // retried the login every iteration, sustaining the storm.
    //
    // Anchoring to `data.startedAt` means the first re-login happens one full
    // RELOGIN_AFTER_MS into the run, staggered, which is what the jitter was
    // always for.
    if (!vuSessionAt) vuSessionAt = data.startedAt;
    if (now - vuSessionAt > RELOGIN_AFTER_MS + jitter) {
      const accounts = accountList();
      const fresh = login(accounts[(__VU - 1) % accounts.length]);
      if (fresh && fresh.access) {
        vuSession = loadTenantContext(fresh);
        vuSession.runSeed = session.runSeed;
        vuSessionAt = now;
      }
    }
    if (vuSession) session = vuSession;
  }

  mixedIteration(session, 'soak');
  sleep(0.1);
}

export function handleSummary(data) {
  const v = data.metrics.http_req_duration.values;
  const out = {
    generatedAt: new Date().toISOString(),
    rate: RATE,
    duration: __ENV.DURATION || '60m',
    http_reqs: data.metrics.http_reqs.values.count,
    rps: data.metrics.http_reqs.values.rate,
    p50_ms: v.med, p95_ms: v['p(95)'], p99_ms: v['p(99)'], max_ms: v.max,
    error_rate: data.metrics.http_req_failed.values.rate,
    business_check_failed: data.metrics.business_check_failed
      ? data.metrics.business_check_failed.values.rate : null,
    server_5xx: data.metrics.http_5xx ? data.metrics.http_5xx.values.count : 0,
    timeouts: data.metrics.http_timeout_or_conn
      ? data.metrics.http_timeout_or_conn.values.count : 0,
    note: 'Memory/event-loop drift is NOT visible here — correlate with the '
      + '/api/v1/metrics samples taken during this window.',
  };
  return {
    stdout: `\n  soak @ ${RATE} it/s — p95 ${Math.round(out.p95_ms)}ms, `
      + `errors ${(out.error_rate * 100).toFixed(2)}%\n\n`,
    '/reports/soak.json': JSON.stringify(out, null, 2),
  };
}
