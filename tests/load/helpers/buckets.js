/**
 * MERGEABLE LATENCY HISTOGRAMS.
 *
 * A k6 Trend's p95 cannot be combined across several generator processes (a
 * 20K-VU campaign has to run as N k6 processes), and the average of N p95s is not
 * a p95. So alongside the normal Trend, every response also increments one plain
 * Counter per latency bucket. Counters ARE additive: lab/merge-summaries.mjs sums
 * them across generators and derives p50/p95/p99 from the merged histogram
 * (resolution = bucket width; linear interpolation inside a bucket).
 *
 * WHY DISTINCT METRIC NAMES, NOT TAGS. k6 only surfaces a tagged sub-metric in the
 * end-of-test summary when a threshold references it, and thousands of thresholds
 * make every sample slower. A counter per (series, bucket) appears in the summary
 * automatically and costs one array lookup per response.
 *
 * Families (names are sanitised to [A-Za-z0-9_]):
 *   lat_step_<step>_<le>  — overall latency per load step / ladder level
 *   lat_ep_<endpoint>_<le> — per endpoint across the run
 * `le` is the bucket's upper bound in ms (`inf` for the last). Steps and endpoints
 * must be REGISTERED at init; an unregistered one is still observed by the normal
 * Trend, it just has no histogram. LT_STEPS adds step names; LT_EP_BUCKETS selects
 * all | hot | none endpoint histograms.
 */
import { Counter } from 'k6/metrics';
import { ENDPOINTS } from '../config/thresholds.js';
import { CAMPAIGN_ENDPOINTS, HOT_ENDPOINTS } from '../config/campaign-endpoints.js';

export const BOUNDS = [5, 10, 25, 50, 100, 200, 300, 500, 800, 1200, 2000, 5000, 10000, 30000];
export const LABELS = BOUNDS.map(String).concat(['inf']);

const san = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);

const BASE_STEPS = ['smoke', 'baseline', 'mixed', 'steady', 'ramp', 'drain', 'probe', 'guest',
  'hold', 'spike', 'recovery', 'soak', 'calibrate', 'pre', 'surge'];
// Soak windows and ladder levels are registered ONLY in the mode that uses them: every VU
// registers every counter at init, so unused families are pure cost at 20K VUs.
if (__ENV.LT_MODE === 'soak') for (let i = 0; i < 36; i++) BASE_STEPS.push('w' + i);
// Ladder levels register themselves (`L5000`), so a scenario never has to list them.
const LEVEL_STEPS = __ENV.LT_MODE === 'ladder'
  ? String(__ENV.LT_LEVELS || '100,500,1000,2500,5000,10000,15000,20000,25000')
    .split(',').map((s) => s.trim()).filter(Boolean).map((l) => `L${l}`)
  : [];
const STEPS = BASE_STEPS.concat(LEVEL_STEPS,
  String(__ENV.LT_STEPS || '').split(',').map((s) => s.trim()).filter(Boolean));

const EP_MODE = __ENV.LT_EP_BUCKETS || 'all';
const EPS = EP_MODE === 'none' ? [] : (EP_MODE === 'hot' ? HOT_ENDPOINTS : ENDPOINTS.concat(CAMPAIGN_ENDPOINTS));

function family(prefix, names) {
  const out = {};
  for (const n of names) {
    if (out[n]) continue;
    out[n] = LABELS.map((l) => new Counter(`${prefix}_${san(n)}_${l}`));
  }
  return out;
}

const stepFam = family('lat_step', STEPS);
const epFam = family('lat_ep', EPS);

function indexFor(ms) {
  for (let i = 0; i < BOUNDS.length; i++) if (ms <= BOUNDS[i]) return i;
  return BOUNDS.length;
}

// Per-endpoint NON-2xx counters (additive across generators, like the histograms). Without them
// a failed-rate threshold says "something failed" but not where. `err_ep_<ep>_{4xx,429,5xx,net}`;
// 4xx excludes 429. Registered for the same endpoint set as the histograms.
const errFam = {};
for (const n of EPS) {
  if (errFam[n]) continue;
  const b = `err_ep_${san(n)}`;
  errFam[n] = { c4: new Counter(`${b}_4xx`), c429: new Counter(`${b}_429`), c5: new Counter(`${b}_5xx`), net: new Counter(`${b}_net`) };
}
// Status-code distribution for the whole run (what the 4xx actually are).
const STATUS_CODES = [200, 201, 202, 204, 301, 302, 304, 400, 401, 402, 403, 404, 405, 409, 410, 413, 415, 422, 423, 429, 500, 501, 502, 503, 504];
const statusFam = {};
for (const c of STATUS_CODES) statusFam[c] = new Counter(`http_status_${c}`);
const statusOther = new Counter('http_status_other');
const statusNone = new Counter('http_status_0');

/** Records one response latency into the step and endpoint histograms (when registered). */
export function recordBucket(ms, step, endpoint, status) {
  const i = indexFor(ms);
  const s = step && stepFam[step];
  if (s) s[i].add(1);
  const e = endpoint && epFam[endpoint];
  if (e) e[i].add(1);
  if (status !== undefined) {
    if (status === 0) statusNone.add(1);
    else (statusFam[status] || statusOther).add(1);
    const x = endpoint && errFam[endpoint];
    if (x) {
      if (status === 0) x.net.add(1);
      else if (status === 429) x.c429.add(1);
      else if (status >= 500) x.c5.add(1);
      else if (status >= 400) x.c4.add(1);
    }
  }
}

/** Registered step names (summary writer iterates these). */
export const REGISTERED_STEPS = Object.keys(stepFam);
export const REGISTERED_ENDPOINTS = Object.keys(epFam);
export const sanitize = san;
