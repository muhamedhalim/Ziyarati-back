/**
 * Shared end-of-test summary for the campaign scenarios.
 *
 * Writes /reports/<RUN_TAG>.<segment>.json — a SLIM, MERGEABLE record:
 *   - every Counter family (additive across generators): the lat_step_* / lat_ep_*
 *     histogram buckets, status/outcome counters, tenant-isolation counters;
 *   - the process's own Trend/Rate values (informational ONLY — percentiles of one
 *     generator are not the campaign's percentiles; merge-summaries.mjs derives
 *     those from the summed buckets);
 *   - the exact run configuration (LT_* env, never a secret), so every number is
 *     reproducible and identifies its configuration.
 *
 * Secrets are never copied: only LT_* variables on an allow-list are recorded and
 * anything that looks like a key/secret/password/token is dropped.
 */
import { BOUNDS, LABELS, REGISTERED_STEPS, sanitize } from './buckets.js';

const KEEP = /^(lat_step_|lat_ep_|err_ep_|http_status_|http_reqs$|http_req_failed$|http_req_duration$|http_req_waiting$|http_req_blocked$|http_req_connecting$|http_5xx|http_4xx|http_429|http_timeout|appt_|queue_|auth_|pay_|webhook_|ai_|ws_|partner_|business_check_failed|dropped_iterations|iterations$|vus$|vus_max$|data_sent$|data_received$|checks$|tenant_isolation|ai_turn_latency_ms|endpoint_latency$|journey_latency$)/;
const SECRET = /(key|secret|password|pass|token|hash)/i;

function configFromEnv() {
  const out = {};
  for (const k of Object.keys(__ENV)) {
    if (!/^(LT_|RUN_TAG|MIX_PROFILE|BASE_URL|TENANT_SKEW|THINK_MS|BOOKING_CONFIRM|CACHE_BUST|CRM_PATHOLOGICAL)/.test(k)) continue;
    if (SECRET.test(k)) continue;
    out[k] = __ENV[k];
  }
  return out;
}

/** Percentile from one step's bucket counts (linear interpolation inside a bucket). */
function pct(counts, q) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    if (acc + counts[i] >= target) {
      const lo = i === 0 ? 0 : BOUNDS[i - 1];
      const hi = i < BOUNDS.length ? BOUNDS[i] : BOUNDS[BOUNDS.length - 1] * 2;
      const frac = counts[i] ? (target - acc) / counts[i] : 0;
      return Math.round(lo + (hi - lo) * frac);
    }
    acc += counts[i];
  }
  return BOUNDS[BOUNDS.length - 1];
}

function stepRows(data) {
  const rows = [];
  for (const step of REGISTERED_STEPS) {
    const counts = LABELS.map((l) => {
      const m = data.metrics[`lat_step_${sanitize(step)}_${l}`];
      return m ? m.values.count : 0;
    });
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) continue;
    rows.push({ step, n, p50: pct(counts, 0.5), p95: pct(counts, 0.95), p99: pct(counts, 0.99) });
  }
  return rows;
}

export function campaignSummary(data, extra) {
  const tag = __ENV.RUN_TAG || 'campaign';
  const seg = __ENV.LT_SEGMENT || 'single';
  const metrics = {};
  for (const name of Object.keys(data.metrics)) {
    if (!KEEP.test(name)) continue;
    const m = data.metrics[name];
    const v = m.values || {};
    if (name.indexOf('lat_') === 0 && !v.count) continue; // drop empty buckets
    metrics[name] = { type: m.type, values: v };
  }
  const startedAt = new Date(Date.now() - (data.state ? data.state.testRunDurationMs : 0)).toISOString();
  const record = {
    schema: 'lt-campaign-summary/1',
    runTag: tag,
    segment: seg,
    startedAt,
    generatedAt: new Date().toISOString(),
    durationMs: data.state ? data.state.testRunDurationMs : null,
    config: configFromEnv(),
    extra: extra || {},
    bounds: BOUNDS,
    metrics,
  };

  const rows = stepRows(data);
  const g = (n, k) => (data.metrics[n] ? data.metrics[n].values[k] : 0);
  let out = `\n  CAMPAIGN ${tag} [segment ${seg}]  requests=${g('http_reqs', 'count')}  ` +
    `failed=${(100 * (g('http_req_failed', 'rate') || 0)).toFixed(2)}%  5xx=${g('http_5xx', 'count') || 0}  ` +
    `429=${g('http_429_rate_limited', 'count') || 0}  dropped_iters=${g('dropped_iterations', 'count') || 0}\n`;
  out += '  (percentiles below are THIS generator only, bucket-estimated; use merge-summaries for the campaign)\n';
  out += '  step        |  requests |  p50ms |  p95ms |  p99ms\n';
  for (const r of rows) {
    out += `  ${String(r.step).padEnd(11)} |${String(r.n).padStart(10)} |${String(r.p50).padStart(7)} |${String(r.p95).padStart(7)} |${String(r.p99).padStart(7)}\n`;
  }
  return {
    stdout: out,
    [`/reports/${tag}.${seg}.json`]: JSON.stringify(record),
  };
}
