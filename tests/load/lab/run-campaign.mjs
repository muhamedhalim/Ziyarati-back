#!/usr/bin/env node
/**
 * THE ONLY SUPPORTED WAY TO START A CAMPAIGN RUN.
 *
 *   node tests/load/lab/run-campaign.mjs <scenario> [--tag TAG] [--segments N]
 *        [--segment i/N] [--no-monitor] [--no-verify] [--dry-run] [--env K=V ...]
 *
 * <scenario> = a file in tests/load/scenarios/ without .js (smoke-campaign, business-mix,
 * appointment-stress, auth-herd, dashboard-reporting, crm-search, queue-workload, public-api,
 * whatsapp-webhook, payment-webhook, ai-workload, stress-20k, soak-20k, recovery, calibrate).
 *
 * WHAT IT ENFORCES BEFORE k6 STARTS (any failure = hard stop, nothing is sent):
 *   1. target host is loopback / private / explicitly allow-listed AND confirmed
 *      (same rule as helpers/guard.js, evaluated here first, in Node);
 *   2. the lab API and worker were started by start-lab.mjs (pids.json), i.e. with the
 *      from-scratch environment — otherwise only with --external-api AND the confirm env;
 *   3. the API is ready, and /api/v1/metrics answers WITHOUT a token (a production boot
 *      refuses that) — proof of a non-production process;
 *   4. the DATABASE is the lab one: name matches, the `lt_lab_sentinel` row exists, the
 *      migration table has every migration file of THIS checkout, and `dist/` is not older
 *      than `src/`;
 *   5. scenario-specific: ai-workload needs a blank OPENAI key (guaranteed by the lab env);
 *      payment-webhook needs the Tap stub up; whatsapp-webhook refuses LT_WA_MESSAGES=true
 *      unless the worker's WhatsApp accounts are tokenless (checked in the DB).
 *
 * THEN: k6 runs in a container from an image PINNED BY ID (recorded in run/k6-image.json and
 * in the manifest), with secrets passed through a temporary 0600 --env-file (never argv),
 * one container per execution segment; the lab monitor runs alongside; afterwards the
 * per-generator summaries are merged and (for write scenarios) the database integrity
 * assertions run. A manifest (git commit, dist age, lab knobs, image id, env minus secrets,
 * timings) is written beside the results so every number identifies its configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadLab, LAB_DIR, RUN_DIR, backendRoot } from './make-lab-env.mjs';

const LOAD = path.resolve(LAB_DIR, '..');
const REPO = backendRoot();
const PINNED = REPO !== path.resolve(LOAD, '..', '..');
const REPORTS = path.join(LOAD, 'reports');
const DATA = path.join(LOAD, 'data', 'generated');
const require = createRequire(path.join(REPO, 'package.json'));

const argv = process.argv.slice(2);
const scenario = argv[0];
const has = (k) => argv.includes(`--${k}`);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const fail = (msg, code = 3) => { console.error(`\nSTOP: ${msg}\n`); process.exit(code); };

if (!scenario || scenario.startsWith('--')) fail('usage: run-campaign.mjs <scenario> [--tag T] [--segments N]', 2);
if (!fs.existsSync(path.join(LOAD, 'scenarios', `${scenario}.js`))) fail(`no such scenario: ${scenario}`, 2);

const lab = loadLab();
const secrets = lab.secrets;
const DENY = ['ziyaratech', 'ziyarati.com', 'railway.app', 'vercel.app', 'amazonaws.com', 'cloudfront.net', 'onrender.com', 'fly.dev',
  'herokuapp.com', 'azurewebsites.net', 'run.app', 'cloudflare', 'netlify.app'];
const MODE = { 'stress-20k': 'ladder', 'soak-20k': 'soak', recovery: 'phases' };
const WRITES = new Set(['smoke-campaign', 'business-mix', 'appointment-stress', 'queue-workload', 'payment-webhook', 'public-api', 'stress-20k', 'soak-20k', 'recovery', 'whatsapp-webhook']);

// ------------------------------------------------------------------ 1. target
const apiPort = lab.ports.api;
const baseUrl = opt('base-url', `http://host.docker.internal:${apiPort}`);       // as seen FROM the k6 container
const hostFromHere = opt('local-url', `http://127.0.0.1:${apiPort}`);              // as seen from this process
function hostOf(u) { const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(u); return m ? m[1].toLowerCase().replace(/^\[|\]$/g, '') : ''; }
function isPrivate(h) {
  return h === 'localhost' || h === '::1' || h === 'host.docker.internal' || /\.(localhost|test)$/.test(h)
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}
for (const u of [baseUrl, hostFromHere]) {
  const h = hostOf(u);
  if (!h) fail(`invalid URL ${u}`);
  for (const bad of DENY) if (h.includes(bad)) fail(`host "${h}" matches protected domain "${bad}"`);
  if (!isPrivate(h)) {
    const allowed = String(process.env.LOADTEST_ALLOWED_HOSTS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(h) || String(process.env.LOADTEST_CONFIRM_TARGET || '').toLowerCase() !== h) {
      fail(`host "${h}" is not loopback/private: set BOTH LOADTEST_ALLOWED_HOSTS and LOADTEST_CONFIRM_TARGET to exactly "${h}"`);
    }
  }
}

// ------------------------------------------------------------------ 2-4. environment
const pids = (() => { try { return JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'pids.json'), 'utf8')); } catch { return {}; } })();
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
if (!(pids.api && alive(pids.api)) && !has('external-api')) fail('the lab API was not started by start-lab.mjs (no live pid). Start it with: node tests/load/lab/start-lab.mjs api  — or pass --external-api (needs LOADTEST_CONFIRM_TARGET)');

async function http(url, o) { try { return await fetch(url, o); } catch (e) { return { status: 0, error: e.message }; } }
const ready = await http(`${hostFromHere}/api/v1/system/health/readiness`);
if (ready.status !== 200) fail(`readiness returned ${ready.status || ready.error}`);
const metrics = await http(`${hostFromHere}/api/v1/metrics`);
if (metrics.status !== 200) fail(`/api/v1/metrics answered ${metrics.status} without a token — that is how a PRODUCTION boot behaves`);

let pgClient;
try {
  const { Client } = require('pg');
  const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  pgClient = new Client({ connectionString: env.DATABASE_URL });
  await pgClient.connect();
  const db = (await pgClient.query('select current_database() d')).rows[0].d;
  if (db !== lab.db.name) fail(`database is "${db}", expected the lab database "${lab.db.name}"`);
  const sentinel = await pgClient.query(`select 1 from information_schema.tables where table_name='lt_lab_sentinel'`);
  if (!sentinel.rowCount) fail('lab sentinel table missing — the database was not created by seed-campaign.mjs');
  const s2 = (await pgClient.query(`select value from lt_lab_sentinel where key='lab'`)).rows[0];
  if (!s2 || s2.value !== 'ziyarati-c20k') fail('lab sentinel value mismatch');
  const files = fs.readdirSync(path.join(REPO, 'src', 'migrations')).filter((f) => /^\d+-.*\.ts$/.test(f) && !f.endsWith('.spec.ts')).length;
  const applied = Number((await pgClient.query('select count(*)::int c from migrations')).rows[0].c);
  if (applied !== files) fail(`migrations applied=${applied} but this checkout has ${files} — migrate the lab (start-lab.mjs migrate) and rebuild dist`);
  globalThis.__counts = (await pgClient.query(`select (select count(*) from tenants)::int tenants, (select count(*) from appointments)::int appointments, (select count(*) from customers)::int customers, (select count(*) from users)::int users`)).rows[0];
  if (scenario === 'whatsapp-webhook' && process.env.LT_WA_MESSAGES === 'true') {
    const tokened = await pgClient.query(`select count(*)::int c from whatsapp_accounts where deleted_at is null and access_token is not null and access_token <> ''`);
    if (tokened.rows[0].c) fail(`LT_WA_MESSAGES=true but ${tokened.rows[0].c} whatsapp_accounts carry an access token — a worker could try a real send`);
  }
} catch (e) { fail(`database preflight failed: ${e.message}`); } finally { try { await pgClient.end(); } catch { /* ignore */ } }

// stale dist
{
  const main = path.join(REPO, 'dist', 'src', 'main.js');
  if (fs.existsSync(main)) {
    const t = fs.statSync(main).mtimeMs; let newest = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) newest = Math.max(newest, fs.statSync(p).mtimeMs); } };
    walk(path.join(REPO, 'src'));
    if (newest > t) fail('dist/ is older than src/ — rebuild (npm run build) and restart the lab API; a stale build tests code that is not in the repo');
  }
}
if (scenario === 'payment-webhook') {
  const st = await http(`http://127.0.0.1:${lab.ports.tapStub}/__admin/stats`);
  if (st.status !== 200) fail('the Tap stub is not running (start-lab.mjs stub)');
}
if (['smoke-campaign', 'business-mix', 'appointment-stress', 'dashboard-reporting', 'crm-search', 'queue-workload', 'ai-workload', 'stress-20k', 'soak-20k', 'recovery'].includes(scenario)
    && !fs.existsSync(path.join(DATA, 'sessions.json'))) fail('tests/load/data/generated/sessions.json missing — run seed-campaign.mjs then mint-sessions.mjs');

// ------------------------------------------------------------------ k6 image (pinned by ID)
const dk = (a) => spawnSync('docker', a, { encoding: 'utf8' });
const imgFile = path.join(RUN_DIR, 'k6-image.json');
let img;
try { img = JSON.parse(fs.readFileSync(imgFile, 'utf8')); } catch { img = null; }
if (!img) {
  const ref = process.env.LT_K6_IMAGE || 'grafana/k6:latest';
  const id = dk(['image', 'inspect', ref, '--format', '{{.Id}}']);
  if (id.status !== 0) fail(`k6 image "${ref}" not present locally (docker pull it once; the runner then pins it by ID with --pull never)`);
  const ver = dk(['run', '--rm', '--pull', 'never', id.stdout.trim(), 'version']);
  img = { ref, id: id.stdout.trim(), version: (ver.stdout || '').trim().split('\n')[0], pinnedAt: new Date().toISOString() };
  fs.writeFileSync(imgFile, JSON.stringify(img, null, 2));
}

// ------------------------------------------------------------------ run configuration
const tag = opt('tag', `${scenario}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`);
const segmentsN = Number(opt('segments', 1));
const oneSeg = opt('segment', null); // "i/N": run only that segment on THIS machine (multi-host)
const forward = {};
for (const [k, v] of Object.entries(process.env)) if (/^(LT_|RUN_TAG$|BOOKING_CONFIRM$|CACHE_BUST$|CRM_PATHOLOGICAL$|MIX_PROFILE$|TENANT_SKEW$|THINK_MS$|VUS$|DURATION$|RATE$|TEST_)/.test(k)) forward[k] = v;
for (let i = argv.indexOf('--env'); i >= 0 && i < argv.length; i = argv.indexOf('--env', i + 1)) { const [k, ...r] = String(argv[i + 1]).split('='); forward[k] = r.join('='); }
Object.assign(forward, {
  BASE_URL: baseUrl, RUN_TAG: tag,
  LT_RUN_SEED: forward.LT_RUN_SEED || String(Math.floor(Date.now() / 60000) % 100000),
  LT_TAP_SECRET: secrets.tapSecret, LT_META_APP_SECRET: secrets.metaAppSecret, LT_LOGIN_PASSWORD: secrets.loginPassword,
  TEST_PASSWORD: forward.TEST_PASSWORD || secrets.loginPassword,
});
if (MODE[scenario] && !forward.LT_MODE) forward.LT_MODE = MODE[scenario];
if (MODE[scenario] && !forward.LT_EP_BUCKETS) forward.LT_EP_BUCKETS = 'hot';
// Optional secrets produced by build-packs (never required by every scenario).
const mk = path.join(RUN_DIR, 'marketplace-key.txt');
if (fs.existsSync(mk) && !forward.LT_MARKETPLACE_KEY && has('marketplace-key')) forward.LT_MARKETPLACE_KEY = fs.readFileSync(mk, 'utf8').trim();

const segs = oneSeg ? [oneSeg.split('/').map(Number)] : Array.from({ length: segmentsN }, (_, i) => [i, segmentsN]);
const seq = (n) => Array.from({ length: n + 1 }, (_, i) => (i === 0 ? '0' : i === n ? '1' : `${i}/${n}`)).join(',');

const manifest = {
  schema: 'lt-run-manifest/1', tag, scenario, startedAt: new Date().toISOString(),
  git: spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  backendRoot: PINNED ? 'pinned worktree (isolated build of one commit)' : 'shared checkout',
  gitDirty: spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout.trim().length > 0,
  k6: img, lab: { ports: lab.ports, knobs: lab.knobs, db: lab.db.name, queuePrefix: lab.queuePrefix },
  dataset: globalThis.__counts, segments: segs.length, host: { cpus: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), platform: os.platform() },
  env: Object.fromEntries(Object.entries(forward).filter(([k]) => !/(SECRET|PASSWORD|KEY|TOKEN)/i.test(k))),
  throttleMode: forward.LT_ALLOW_429 === 'true' ? 'production-limits-ON (429 expected)' : 'lifted via NODE_ENV=test',
};

console.log(`\nRUN ${tag}\n  scenario  ${scenario}\n  target    ${baseUrl} (lab db ${lab.db.name}, ${JSON.stringify(globalThis.__counts)})\n  generators ${segs.length} segment(s)  k6 ${img.version || img.id.slice(0, 19)}\n  throttle  ${manifest.throttleMode}`);
if (has('dry-run')) { console.log('\n--dry-run: all preflight checks passed; not starting k6.'); process.exit(0); }

fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(path.join(REPORTS, `${tag}.manifest.json`), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------------ monitor
let monitor = null;
if (!has('no-monitor')) {
  monitor = spawn(process.execPath, [path.join(LAB_DIR, 'monitor-campaign.mjs'), '--tag', tag, '--interval', String(opt('monitor-interval', 5))], { stdio: ['ignore', 'inherit', 'inherit'] });
}

// ------------------------------------------------------------------ k6 containers
const envFiles = [];
const procs = segs.map(([i, n]) => new Promise((resolve) => {
  const seg = `${i}of${n}`;
  const envFile = path.join(RUN_DIR, `k6.${tag}.${seg}.env`);
  const lines = Object.entries(Object.assign({}, forward, { LT_SEGMENT: seg })).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`);
  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  envFiles.push(envFile);
  const name = `lt-k6-${tag}-${seg}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  const args = ['run', '--rm', '--pull', 'never', '--name', name, '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${LOAD}:/scripts:ro`, '-v', `${REPORTS}:/reports`, '--env-file', envFile, '-w', '/scripts',
    ...(opt('cpus') ? ['--cpus', opt('cpus')] : []), ...(opt('memory') ? ['--memory', opt('memory')] : []),
    img.id, 'run', ...(n > 1 ? ['--execution-segment', `${i}/${n}:${i + 1}/${n}`, '--execution-segment-sequence', seq(n)] : []),
    ...(process.env.LT_K6_ARGS ? process.env.LT_K6_ARGS.split(' ') : []), `/scripts/scenarios/${scenario}.js`];
  const p = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('close', (code) => resolve({ seg, code }));
}));

process.on('SIGINT', () => { for (const [i, n] of segs) dk(['stop', `lt-k6-${tag}-${i}of${n}`.replace(/[^A-Za-z0-9_.-]/g, '-')]); });
const results = await Promise.all(procs);
for (const f of envFiles) { try { fs.rmSync(f); } catch { /* ignore */ } }
if (monitor) {
  // A stop FILE, not a signal: Windows cannot deliver SIGTERM handlers to a Node child.
  fs.writeFileSync(path.join(RUN_DIR, `monitor.${tag}.stop`), '1');
  await new Promise((resolve) => { const t = setTimeout(resolve, 20000); monitor.on('close', () => { clearTimeout(t); resolve(); }); });
}

manifest.endedAt = new Date().toISOString();
manifest.k6ExitCodes = results;
fs.writeFileSync(path.join(REPORTS, `${tag}.manifest.json`), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------------ merge + verify
const merge = spawnSync(process.execPath, [path.join(LAB_DIR, 'merge-summaries.mjs'), tag, '--dir', REPORTS], { stdio: 'inherit' });
let verifyCode = 0;
if (!has('no-verify') && WRITES.has(scenario) && fs.existsSync(path.join(LAB_DIR, 'verify-integrity.mjs'))) {
  verifyCode = spawnSync(process.execPath, [path.join(LAB_DIR, 'verify-integrity.mjs'), '--tag', tag, '--scenario', scenario], { stdio: 'inherit' }).status || 0;
}
// k6 exit 99 = a threshold failed (an expected, reportable outcome); anything else non-zero is a run problem.
const bad = results.filter((r) => r.code && r.code !== 99);
console.log(`\nDONE ${tag}: k6 exit codes ${results.map((r) => `${r.seg}=${r.code}`).join(' ')}; merge=${merge.status}; integrity=${verifyCode}`);
process.exit(bad.length ? 5 : (merge.status || verifyCode || 0));
