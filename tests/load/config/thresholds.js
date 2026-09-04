/**
 * Thresholds, differentiated by endpoint class.
 *
 * Every number below is justified by the endpoint's MEASURED cost or its known
 * query shape, not by a generic SLO. Single-request warm latencies measured on
 * this lab (T1, single API process) are quoted alongside each class.
 *
 *  cached_read   — /dashboard/summary is wrapped in a 60s Redis cache with a
 *                  single-flight lease. Measured warm: 48ms. A cache hit should
 *                  never approach 300ms; if it does, the lease is queueing
 *                  (losers poll up to 4.5s) and that is the finding.
 *  list_read     — /appointments (~3 SQL, 5 joined tables), /staff (~6 round
 *                  trips), /activity (2 queries + LATERAL join). Measured warm:
 *                  18-50ms. 800ms leaves ~16x headroom for queueing before it
 *                  is called degraded.
 *  search_read   — /crm/customers/search is `ILIKE '%q%'` across 3 columns with
 *                  NO trigram index — a sequential scan by construction, plus a
 *                  3-query hydrate for tags. Given a deliberately wider budget.
 *  availability  — ~11-12 SQL per call, and the same engine runs inside every
 *                  booking transaction. This is the read most likely to gate
 *                  write throughput.
 *  write         — POST /appointments holds a transaction across ~15-20 round
 *                  trips and serializes per-tenant on the usage-counter row.
 *  auth          — bcrypt cost factor 12 puts a hard ~410ms floor under login.
 *                  A threshold below that would fail on correct behaviour.
 *
 * Error budgets: the platform's own guard chain returns 401/403/429 as normal
 * control-flow, so `http_req_failed` is deliberately NOT the primary gate —
 * `business_check_failed` is, because it asserts the payload, not the status.
 */

export const LATENCY = {
  cached_read: 300,
  list_read: 800,
  search_read: 1200,
  availability: 1200,
  write: 1500,
  auth: 1000,
};

/**
 * Every endpoint label the flows emit.
 *
 * k6 only MATERIALISES a sub-metric that some threshold references — an
 * `endpoint_latency{endpoint:x}` series simply does not exist in the summary
 * unless it is named here. Without this list the per-endpoint ranking comes
 * back empty, which is exactly what happened before it was added.
 */
export const ENDPOINTS = [
  'auth:login', 'tenants:me', 'tenants:targets', 'dashboard',
  'analytics:trend:appointments', 'analytics:trend:revenue',
  'analytics:performance:staff', 'analytics:dashboard',
  'appointments:list', 'appointments:list:filtered', 'appointments:list:deep',
  'appointments:detail', 'appointments:notes', 'appointments:timeline',
  'appointments:reminders', 'appointments:create', 'appointments:status',
  'availability:windows',
  'crm:list', 'crm:search', 'crm:search:term', 'crm:search:pathological', 'crm:tags',
  'staff:list', 'staff:list:role', 'staff:doctors', 'staff:lookup',
  'activity:list', 'activity:list:search', 'activity:actions',
  'notifications:unread', 'notifications:inbox',
  'branches:list', 'services:list',
  'public:cities', 'public:clinics', 'public:clinic:detail',
  'public:booking:session', 'public:booking:select-clinic',
  'public:booking:select-branch', 'public:booking:services',
  'public:booking:select-service', 'public:booking:doctors',
  'public:booking:select-doctor', 'public:booking:availability',
  'public:booking:select-slot', 'public:booking:confirm',
];

/**
 * Reporting-only thresholds that exist purely to make each endpoint's
 * sub-metric appear in the summary so the report can rank them.
 */
export function endpointReportingThresholds() {
  const t = {};
  for (const e of ENDPOINTS) {
    t[`endpoint_latency{endpoint:${e}}`] = ['p(95)<600000'];
  }
  return t;
}

/** Thresholds for the steady-state scenarios (smoke / baseline / mixed). */
export function steadyStateThresholds() {
  return Object.assign(endpointReportingThresholds(), {
    'http_req_failed': ['rate<0.01'],
    'business_check_failed': ['rate<0.01'],

    'endpoint_latency{endpoint:dashboard}': [`p(95)<${LATENCY.cached_read}`],
    'endpoint_latency{endpoint:appointments:list}': [`p(95)<${LATENCY.list_read}`],
    'endpoint_latency{endpoint:staff:list}': [`p(95)<${LATENCY.list_read}`],
    'endpoint_latency{endpoint:activity:list}': [`p(95)<${LATENCY.list_read}`],
    'endpoint_latency{endpoint:crm:search}': [`p(95)<${LATENCY.search_read}`],
    'endpoint_latency{endpoint:availability:windows}': [`p(95)<${LATENCY.availability}`],
    'endpoint_latency{endpoint:appointments:create}': [`p(95)<${LATENCY.write}`],
    'endpoint_latency{endpoint:auth:login}': [`p(95)<${LATENCY.auth}`],

    // Critical reads get a tighter error budget than the global one.
    'http_429_rate_limited': ['count<1'],
  });
}

/**
 * The sweep deliberately drives the system past breaking point, so pass/fail
 * thresholds would be meaningless. These exist ONLY to force k6 to print the
 * per-step sub-metrics that the degradation table is built from.
 */
export function sweepReportingThresholds(steps) {
  const t = endpointReportingThresholds();
  for (const s of steps) {
    t[`http_req_duration{step:${s}}`] = ['p(95)<600000'];
    t[`http_req_failed{step:${s}}`] = ['rate<=1'];
    t[`endpoint_latency{step:${s}}`] = ['p(95)<600000'];
    // Per-endpoint AND per-step, for the SLO-bearing endpoints only.
    //
    // Without this cross product a sweep can say "p95 degraded at rate N" but
    // not "which endpoint class breached its own SLO at rate N" — and the SLOs
    // in LATENCY above are per class, not global, so the aggregate cannot be
    // scored against them at all. Restricted to the eight endpoints that carry
    // a class SLO: the full 47-endpoint cross product would be ~470 sub-metrics
    // for no extra answer.
    for (const e of SLO_ENDPOINTS) {
      t[`endpoint_latency{step:${s},endpoint:${e}}`] = ['p(95)<600000'];
    }
  }
  return t;
}

/** The endpoints that carry a class SLO, and the class each is measured against. */
export const SLO_ENDPOINTS = [
  'dashboard',
  'appointments:list',
  'staff:list',
  'activity:list',
  'crm:search:term',
  'availability:windows',
  'appointments:create',
  'auth:login',
];

export const SLO_CLASS_OF = {
  'dashboard': 'cached_read',
  'appointments:list': 'list_read',
  'staff:list': 'list_read',
  'activity:list': 'list_read',
  'crm:search:term': 'search_read',
  'availability:windows': 'availability',
  'appointments:create': 'write',
  'auth:login': 'auth',
};
