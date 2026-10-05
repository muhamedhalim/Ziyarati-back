/**
 * Campaign thresholds, in three severities (the plan's P0/P1/P2).
 *
 * Nothing here is invented from thin air:
 *   - latency budgets are the EXISTING class SLOs in thresholds.js (LATENCY), set
 *     from measured September baselines;
 *   - the error-rate ceilings are explicit, env-tunable defaults (LT_MAX_*), and
 *     every report prints the value used.
 *
 * P0  HARD FAILURE (abortOnFail where stopping is the safe thing):
 *       tenant isolation violation, unexpected 5xx above the ceiling.
 *       Business-correctness P0s that need the database (duplicate appointment,
 *       overlapping slot, duplicate payment/outbox row, tenant leakage in rows) are
 *       asserted by lab/verify-integrity.mjs AFTER the run — k6 cannot see them.
 * P1  p95/p99 regression vs the class SLO, pool saturation, queue backlog.
 *       (k6 side: SLO thresholds, enabled with LT_SLO=true. Pool/queue: lab monitor.)
 * P2  informational: elevated memory, retry growth (lab monitor).
 *
 * Ladder / stress / soak stages deliberately drive past the knee, so they carry
 * ONLY the P0 isolation guard — latency thresholds there would fail by design.
 */
import { LATENCY } from './thresholds.js';

const num = (k, d) => (__ENV[k] === undefined || __ENV[k] === '' ? d : Number(__ENV[k]));

export const MAX_5XX_RATE = num('LT_MAX_5XX_RATE', 0.005);
export const MAX_FAILED_RATE = num('LT_MAX_FAILED_RATE', 0.01);
export const MAX_BUSINESS_FAIL = num('LT_MAX_BUSINESS_FAIL', 0.02);

/** P0 only: the guard every campaign scenario carries, including the ones past the knee. */
export function p0Guard() {
  return {
    tenant_isolation_violation: [{ threshold: 'count<1', abortOnFail: true }],
  };
}

/** Steady-state scenarios: P0 + error ceilings (+ P1 SLOs when LT_SLO=true). */
export function steadyThresholds() {
  const t = Object.assign(p0Guard(), {
    server_error_rate: [`rate<${MAX_5XX_RATE}`],
    http_req_failed: [`rate<${MAX_FAILED_RATE}`],
    business_check_failed: [`rate<${MAX_BUSINESS_FAIL}`],
  });
  // With production limits ON, 429 is the measured behaviour; with them lifted it is a defect.
  if (__ENV.LT_ALLOW_429 !== 'true') t.http_429_rate_limited = ['count<1'];
  if (__ENV.LT_SLO === 'true') {
    t['endpoint_latency{endpoint:dashboard}'] = [`p(95)<${LATENCY.cached_read}`];
    t['endpoint_latency{endpoint:appointments:list}'] = [`p(95)<${LATENCY.list_read}`];
    t['endpoint_latency{endpoint:staff:list}'] = [`p(95)<${LATENCY.list_read}`];
    t['endpoint_latency{endpoint:crm:search:term}'] = [`p(95)<${LATENCY.search_read}`];
    t['endpoint_latency{endpoint:availability:windows}'] = [`p(95)<${LATENCY.availability}`];
    t['endpoint_latency{endpoint:appointments:create}'] = [`p(95)<${LATENCY.write}`];
    t['endpoint_latency{endpoint:auth:login}'] = [`p(95)<${LATENCY.auth}`];
  }
  return t;
}
