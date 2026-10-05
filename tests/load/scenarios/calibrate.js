/**
 * GENERATOR CALIBRATION — how much can ONE k6 process drive, with the application taken
 * OUT of the question?
 *
 * Targets the raw `GET /api/v1/health` Express handler, which bypasses every guard, the
 * throttler, the DB and Redis (main.ts). Whatever ceiling this hits is the GENERATOR's
 * (CPU, memory per VU, ephemeral ports, the host network stack) — never the application's.
 * Run it BEFORE any 20K stage to learn: max VUs per process, max req/s per process, memory
 * per VU, VU init time, and how many generator processes/hosts the ladder needs.
 *
 * It also ramps connections: each VU holds a keep-alive connection, so the VU count at
 * which `dial: i/o timeout` / connect errors appear is the source-port ceiling, measured.
 *
 *   LT_CAL_LEVELS=500,1000,2500,5000,8000 node lab/run-campaign.mjs calibrate
 *
 * Read `http_req_connecting`, `http_req_failed`, `dropped_iterations` and the generator's
 * own CPU/RSS (lab monitor --gen). A level is "generator-clean" only if connect errors = 0,
 * dropped iterations = 0 and the generator is below ~70% of its CPU.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { TARGET } from '../helpers/guard.js';
import { preflight } from '../helpers/guard.js';
import { observe } from '../helpers/metrics.js';
import { makeSummary } from '../helpers/boot.js';
import { num, str, secs } from '../config/kit.js';

const LEVELS = str('LT_CAL_LEVELS', '500,1000,2500,5000').split(',').map(Number);
const RAMP = str('LT_CAL_RAMP', '60s');
const HOLD = str('LT_CAL_HOLD', '60s');
const THINK = num('LT_CAL_THINK_S', 1);

const stages = [];
for (const l of LEVELS) { stages.push({ duration: RAMP, target: l }); stages.push({ duration: HOLD, target: l }); }
stages.push({ duration: '30s', target: 0 });

export const options = {
  setupTimeout: '60s',
  scenarios: { calibrate: { executor: 'ramping-vus', startVUs: 0, stages, gracefulRampDown: '30s', exec: 'calibrate' } },
  thresholds: { http_req_failed: ['rate<=1'] }, // reporting only
};

export function setup() { preflight(); return {}; }

export function calibrate() {
  const res = http.get(`${TARGET}/api/v1/health`, { tags: { name: 'health/raw' }, responseCallback: http.expectedStatuses({ min: 200, max: 399 }) });
  observe(res, 'health:raw', 'calibrate');
  sleep(THINK);
}

export const handleSummary = makeSummary({ scenario: 'calibrate', levels: LEVELS, ramp: RAMP, hold: HOLD, totalS: LEVELS.length * (secs(RAMP) + secs(HOLD)) });
