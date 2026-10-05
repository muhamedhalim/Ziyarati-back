/**
 * QUEUE WORKLOAD — the patient queue (HTTP side) and the asynchronous side that
 * HTTP 200s do not prove.
 *
 *   board     closed population polling `GET /queue` every 3 s (the real page behaviour;
 *             the endpoint loads every entry for the branch+day and slices in memory)
 *   cycles    open-model reception cycles: check-in -> call -> start -> complete
 *   import    1-5 concurrent services-import PREVIEWs (event-loop blocking characterisation)
 *   drain     sampling only: the lab monitor records outbox PENDING, queue depth,
 *             `payments`/`notifications` job latency and DLQ growth while this runs
 *
 * REQUIRES the lab worker (WORKER_ROLE=all, all providers noop, tokenless accounts, no
 * workflows/webhook endpoints): the booking transaction writes an outbox row that only
 * a worker publishes, so without one the "reminders.schedule" backlog silently grows in
 * Postgres. Eventual-processing correctness (every outbox row reaches PUBLISHED, no
 * FAILED, no duplicates) is asserted AFTER the run by lab/verify-integrity.mjs.
 *
 * The queue pack is finite: each appointment supports ONE full cycle, so a drained
 * pool shows up as rising `queue_conflict_409`, never as errors.
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { pickSession } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { queueView, queueBranches, queueCycle } from '../flows/queue.js';
import { BASE, authWrite } from '../helpers/auth.js';
import { observe } from '../helpers/metrics.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, constantVus, arrival, startAt } from '../config/kit.js';

const PARTS = str('LT_QUEUE_PARTS', 'board,cycles,import').split(',');
const DUR = str('LT_DURATION', '5m');
const GAP = secs(str('LT_GAP', '30s'));
// A tiny pre-built services.xlsx written by lab/mint-sessions.mjs (binary, so not a JSON pack).
const XLSX_PATH = (__ENV.LT_DATA_DIR || '/scripts/data/generated') + '/services.xlsx';
let XLSX = null;
try { XLSX = open(XLSX_PATH, 'b'); } catch (e) { XLSX = null; }

const DEFS = {
  board: () => constantVus('board', num('LT_BOARD_VUS', 500), DUR, { part: 'board' }),
  cycles: () => arrival('cycles', num('LT_CYCLE_RATE', 10), DUR, { part: 'cycles' }),
  import: () => constantVus('importRun', num('LT_IMPORT_VUS', 3), '2m', { part: 'import' }),
};
const LENGTH = { board: secs(DUR), cycles: secs(DUR), import: 120 };

const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  scenarios[p === 'import' ? 'import_run' : p] = startAt(DEFS[p](), t);
  t += LENGTH[p] + GAP;
}
// 'board' and 'cycles' are meant to OVERLAP (a working clinic does both at once).
if (PARTS.indexOf('board') !== -1 && PARTS.indexOf('cycles') !== -1) {
  scenarios.cycles = startAt(DEFS.cycles(), 0);
}

export const options = { setupTimeout: '300s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('queue-workload'); }

const front = () => pickSession(__VU, ['receptionist', 'manager'], 0);

export function board() {
  const s = front();
  if (!s) return;
  queueView(s, 'steady');
  sleep(3);
}
export function cycles() {
  const s = front();
  if (!s) return;
  queueCycle(s, 'steady');
  if (Math.random() < 0.1) queueBranches(s, 'steady');
}
export function importRun() {
  const s = pickSession(__VU, ['owner', 'manager'], 0);
  if (!s || !XLSX) { sleep(5); return; }
  const bin = http.file(XLSX, 'services.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const p = authWrite(s, { step: 'steady' });
  delete p.headers['Content-Type']; // multipart boundary is set by k6
  const res = http.post(`${BASE}/api/v1/services/import/preview`, { file: bin }, p);
  observe(res, 'services:import:preview', 'steady');
  sleep(5);
}

export const handleSummary = makeSummary({ scenario: 'queue-workload', parts: PARTS });
