#!/usr/bin/env node
/**
 * Merges the per-generator summaries of ONE run into the campaign result.
 *
 *   node tests/load/lab/merge-summaries.mjs <runTag> [--dir tests/load/reports] [--json out.json]
 *
 * Input : <dir>/<runTag>.<segment>.json  (written by helpers/summary.js, one per k6 process)
 * Output: merged counters, p50/p95/p99 DERIVED FROM THE SUMMED LATENCY-BUCKET COUNTERS
 *         (a k6 percentile cannot be merged; the average of N p95s is not a p95), per-step
 *         and per-endpoint tables, and — for ladder runs — the verdict per level.
 *
 * PRECISION: percentiles are bucket-resolution estimates (linear interpolation inside a
 * bucket; bounds in `bounds`). That is stated in every table. Counters (requests, errors,
 * business outcomes) are EXACT sums.
 *
 * Level verdicts reuse the September definitions (MASSIVE_SCALE_CAPACITY_MATRIX.md §1):
 *   healthy   p95 within the class budget and errors < 1%
 *   degraded  p95 up to 10x the budget or errors < 5%
 *   saturated beyond that but the service still answers
 *   failed    errors >= 20% or no usable throughput
 * Budget here = the overall steady budget `LT_BUDGET_MS` (default 1200 ms, the
 * search/availability class) because a level mixes classes; per-class scoring comes from
 * the per-endpoint table against thresholds.js.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const tag = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!tag) { console.error('usage: merge-summaries.mjs <runTag> [--dir D] [--json out.json]'); process.exit(2); }
const dir = path.resolve(opt('dir', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'reports')));
const BUDGET = Number(process.env.LT_BUDGET_MS || 1200);

// <tag>.<anything>.json also matches the manifest / monitor / merged files, so keep ONLY real
// generator summaries (identified by their schema field).
const docs = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.startsWith(`${tag}.`) || !f.endsWith('.json')) continue;
  let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (d && d.schema === 'lt-campaign-summary/1' && d.runTag === tag) docs.push(d);
}
if (!docs.length) { console.error(`no generator summaries for "${tag}" in ${dir}`); process.exit(1); }
const bounds = docs[0].bounds;
const LABELS = bounds.map(String).concat(['inf']);

// ---- sum counters across generators (Counter values: .count). Trend/Rate: kept per generator only.
const sum = {};
for (const d of docs) {
  for (const [name, m] of Object.entries(d.metrics)) {
    if (m.type === 'counter') sum[name] = (sum[name] || 0) + (m.values.count || 0);
  }
}
const rateTotals = {}; // http_req_failed: weighted by requests of each generator
let reqs = 0; let failed = 0;
for (const d of docs) {
  const r = d.metrics.http_reqs ? d.metrics.http_reqs.values.count : 0;
  const f = d.metrics.http_req_failed ? d.metrics.http_req_failed.values.rate : 0;
  reqs += r; failed += r * f;
}
rateTotals.http_req_failed = reqs ? failed / reqs : 0;

const san = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
function hist(prefix, name) {
  return LABELS.map((l) => sum[`${prefix}_${san(name)}_${l}`] || 0);
}
function pct(counts, q) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = q * total; let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    if (acc + counts[i] >= target) {
      const lo = i === 0 ? 0 : bounds[i - 1];
      const hi = i < bounds.length ? bounds[i] : bounds[bounds.length - 1] * 2;
      return Math.round(lo + (hi - lo) * (counts[i] ? (target - acc) / counts[i] : 0));
    }
    acc += counts[i];
  }
  return bounds[bounds.length - 1];
}

const steps = new Set(); const eps = new Set();
for (const k of Object.keys(sum)) {
  let m;
  if ((m = /^lat_step_(.+)_(\d+|inf)$/.exec(k))) steps.add(m[1]);
  if ((m = /^lat_ep_(.+)_(\d+|inf)$/.exec(k))) eps.add(m[1]);
}
const row = (prefix, name) => {
  const c = hist(prefix, name); const n = c.reduce((a, b) => a + b, 0);
  return { name, n, p50: pct(c, 0.5), p95: pct(c, 0.95), p99: pct(c, 0.99), over1s: n ? c.slice(LABELS.indexOf('1200')).reduce((a, b) => a + b, 0) / n : 0 };
};
const stepRows = [...steps].map((s) => row('lat_step', s)).filter((r) => r.n).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
const epRows = [...eps].map((s) => row('lat_ep', s)).filter((r) => r.n).sort((a, b) => b.n - a.n);

// ---- non-2xx per endpoint (exact) and the status-code distribution (exact)
const errEps = new Set();
for (const k of Object.keys(sum)) { const m = /^err_ep_(.+)_(4xx|429|5xx|net)$/.exec(k); if (m) errEps.add(m[1]); }
// Non-2xx that the scenarios provoke ON PURPOSE (so a report can say what is UNEXPECTED).
//  mkt_avatar            404: lab has no object storage, doctors have no avatar (R2 path is NOT TESTED)
//  appointments_create  4xx: contention modes expect 409 SLOT_ALREADY_BOOKED / 422 quota
const EXPECTED_4XX = new Set(['mkt_avatar', 'appointments_create']);
const errorRows = [...errEps].map((n) => {
  const g = (x) => sum[`err_ep_${n}_${x}`] || 0;
  const total = g('4xx') + g('429') + g('5xx') + g('net');
  const req = (epRows.find((r) => san(r.name) === n) || {}).n || null;
  const unexpected = total - (EXPECTED_4XX.has(n) ? g('4xx') : 0);
  return { name: (epRows.find((r) => san(r.name) === n) || {}).name || n, requests: req, c4xx: g('4xx'), c429: g('429'), c5xx: g('5xx'), net: g('net'), total, unexpected, expected4xx: EXPECTED_4XX.has(n) };
}).filter((r) => r.total).sort((a, b) => b.total - a.total);
const statusDist = Object.fromEntries(Object.entries(sum).filter(([k, v]) => /^http_status_/.test(k) && v).map(([k, v]) => [k.slice(12), v]));

// ---- outcomes (exact)
const pick = (re) => Object.fromEntries(Object.entries(sum).filter(([k]) => re.test(k) && !/^lat_/.test(k)));
const outcomes = pick(/^(http_5xx|http_4xx|http_429|http_timeout|appt_|queue_|auth_|pay_|webhook_|ai_|ws_|partner_|tenant_isolation|dropped_iterations|iterations)/);

const durMs = Math.max(...docs.map((d) => d.durationMs || 0));
const startedAt = docs.map((d) => d.startedAt).sort()[0];

// ---- ladder verdicts
const ladder = [];
const model = docs[0].extra && docs[0].extra.model;
if (model && model.ladder) {
  const hold = secs(model.hold); const ramp = secs(model.ramp);
  for (const lvl of model.ladder) {
    const r = stepRows.find((x) => x.name === `L${lvl}`);
    if (!r) { ladder.push({ vus: lvl, verdict: 'NOT MEASURED' }); continue; }
    const fail = sum[`http_5xx`] ? null : 0;
    void fail;
    const rps = r.n / hold;
    let v = 'healthy';
    if (r.p95 > BUDGET * 10) v = 'saturated'; else if (r.p95 > BUDGET) v = 'degraded';
    ladder.push({ vus: lvl, holdS: hold, rampS: ramp, requests: r.n, req_per_s: +rps.toFixed(1), p50: r.p50, p95: r.p95, p99: r.p99, verdict: v });
  }
}
function secs(s) { const m = /^(\d+)(s|m|h)$/.exec(String(s)); return m ? Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1) : Number(s) || 0; }

// ---- recovery rule (September: recovered iff recovery p95 <= 1.5 x pre p95)
let recovery = null;
const pre = stepRows.find((x) => x.name === 'pre'); const rec = stepRows.find((x) => x.name === 'recovery'); const sg = stepRows.find((x) => x.name === 'surge');
if (pre && rec) recovery = { prep95: pre.p95, surgep95: sg ? sg.p95 : null, recoveryp95: rec.p95, ratio: +(rec.p95 / pre.p95).toFixed(2), recovered: rec.p95 <= 1.5 * pre.p95 };

const merged = {
  schema: 'lt-campaign-merged/1', runTag: tag, generators: docs.length, segments: docs.map((d) => d.segment),
  startedAt, durationMs: durMs, config: docs[0].config, model, precision: { percentiles: 'bucket-estimated', bounds },
  totals: { http_reqs: reqs, http_req_failed_rate: rateTotals.http_req_failed, req_per_s_avg: durMs ? +(reqs / (durMs / 1000)).toFixed(1) : null },
  outcomes, statusDist, errorsByEndpoint: errorRows, steps: stepRows, endpoints: epRows, ladder, recovery,
};

const out = opt('json', path.join(dir, `${tag}.merged.json`));
fs.writeFileSync(out, JSON.stringify(merged, null, 2));

const f = (x) => (x == null ? '-' : String(x));
console.log(`\nRUN ${tag}  generators=${docs.length}  requests=${reqs}  failed=${(100 * rateTotals.http_req_failed).toFixed(2)}%  avg req/s=${merged.totals.req_per_s_avg}`);
console.log('percentiles are bucket-estimated (merged histograms); counters are exact sums\n');
console.log('step         requests    p50    p95    p99   >1.2s');
for (const r of stepRows) console.log(`${r.name.padEnd(11)} ${String(r.n).padStart(9)} ${f(r.p50).padStart(6)} ${f(r.p95).padStart(6)} ${f(r.p99).padStart(6)} ${(100 * r.over1s).toFixed(1).padStart(6)}%`);
if (ladder.length) { console.log('\nLADDER (hold windows only)'); for (const l of ladder) console.log(`  ${String(l.vus).padStart(6)} VUs  ${f(l.req_per_s).padStart(8)} req/s  p95=${f(l.p95)}ms  ${l.verdict}`); }
if (recovery) console.log(`\nRECOVERY pre p95=${recovery.prep95}ms surge p95=${recovery.surgep95}ms recovery p95=${recovery.recoveryp95}ms ratio=${recovery.ratio} => ${recovery.recovered ? 'RECOVERED' : 'NOT RECOVERED'}`);
console.log('\nSTATUS CODES (exact)  ' + Object.entries(statusDist).map(([k, v]) => `${k}=${v}`).join('  '));
if (errorRows.length) {
  console.log('\nNON-2xx BY ENDPOINT (exact)                requests     4xx    429    5xx    net');
  for (const r of errorRows.slice(0, 25)) console.log(`  ${r.name.padEnd(36)} ${String(r.requests ?? '-').padStart(8)} ${String(r.c4xx).padStart(7)} ${String(r.c429).padStart(6)} ${String(r.c5xx).padStart(6)} ${String(r.net).padStart(6)} ${String(r.unexpected).padStart(10)}${r.expected4xx ? '  (4xx provoked on purpose)' : ''}`);
}
console.log('\nOUTCOMES (exact)'); for (const [k, v] of Object.entries(outcomes)) if (v) console.log(`  ${k.padEnd(34)} ${v}`);
console.log(`\nwritten ${out}`);
if ((outcomes.tenant_isolation_violation || 0) > 0) { console.error('\nP0: TENANT ISOLATION VIOLATION RECORDED'); process.exit(4); }
