/**
 * PUBLIC BOOKING + DISCOVERY — the unauthenticated surface.
 *
 * This is the most exposed part of the platform: no JWT, no CAPTCHA, and the
 * only protection is per-IP throttling that `trust proxy` being unset makes
 * impossible to spread across sources. It is therefore both the easiest thing
 * for a real attacker to hammer and the cheapest thing for us to characterise.
 *
 * Two arms:
 *   `discovery` — cities + clinic search. `/public/discovery/clinics` is an
 *                 `ILIKE %q%` plus correlated subqueries; it is the cheapest
 *                 request to send and among the more expensive to serve, which
 *                 is the asymmetry that matters for abuse.
 *   `funnel`    — the full 11-step booking flow ending at slot selection. The
 *                 availability step is the heavyweight: `rangeWindows` loops the
 *                 ~11-query engine once PER DAY across the requested horizon.
 *
 * THROTTLES (per IP, ttl 60s): funnel steps 60/min, confirm 10/min. Under
 * NODE_ENV=test these lift to 1e6 — so a run WITHOUT that env measures the
 * throttler, and a run WITH it measures the application. Both are legitimate;
 * be explicit about which one you ran.
 *
 * `confirm` is a real write and is OFF unless BOOKING_CONFIRM=true.
 */
import exec from 'k6/execution';
import { publicDiscovery, bookingFunnel, bookingConfirm } from '../flows/booking.js';
import { endpointReportingThresholds } from '../config/thresholds.js';

const RATE = Number(__ENV.RATE || 10);

export const options = {
  scenarios: {
    discovery: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: Math.max(10, RATE * 2),
      maxVUs: 300,
      tags: { step: 'public-discovery' },
      exec: 'discovery',
    },
    funnel: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.floor(RATE / 2)),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      startTime: '10s',
      preAllocatedVUs: Math.max(10, RATE * 2),
      maxVUs: 300,
      tags: { step: 'public-funnel' },
      exec: 'funnel',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: Object.assign(endpointReportingThresholds(), {
    'business_check_failed': ['rate<0.02'],
    'http_5xx': ['count<1'],
  }),
};

export function discovery() {
  publicDiscovery('public-discovery');
}

export function funnel() {
  const ctx = bookingFunnel('public-funnel');
  if (ctx) bookingConfirm(ctx, 'public-funnel');
}

export function handleSummary(data) {
  const endpoints = {};
  for (const key of Object.keys(data.metrics)) {
    const m = /^endpoint_latency\{endpoint:(public[^,}]*)\}$/.exec(key);
    if (m) {
      const v = data.metrics[key].values;
      endpoints[m[1]] = { count: v.count, med_ms: v.med, p95_ms: v['p(95)'], max_ms: v.max };
    }
  }
  const out = {
    generatedAt: new Date().toISOString(),
    rate: RATE,
    confirmEnabled: __ENV.BOOKING_CONFIRM === 'true',
    http_reqs: data.metrics.http_reqs.values.count,
    error_rate: data.metrics.http_req_failed.values.rate,
    rate_limited_429: data.metrics.http_429_rate_limited
      ? data.metrics.http_429_rate_limited.values.count : 0,
    server_5xx: data.metrics.http_5xx ? data.metrics.http_5xx.values.count : 0,
    endpoints,
  };
  return {
    stdout: `\n  public surface: ${out.http_reqs} reqs, ${out.rate_limited_429} x 429, `
      + `${out.server_5xx} x 5xx\n  report: tests/load/reports/public-booking.json\n\n`,
    '/reports/public-booking.json': JSON.stringify(out, null, 2),
  };
}
