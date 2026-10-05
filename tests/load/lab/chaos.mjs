#!/usr/bin/env node
/**
 * CONTROLLED DEPENDENCY DEGRADATION against the disposable lab — never production.
 *
 *   node tests/load/lab/chaos.mjs <action> [args] [--at SECONDS] [--for SECONDS]
 *
 * Run it in a second terminal while a steady scenario is running (e.g. business-mix at a
 * sustainable level), then read the k6 + monitor results across the injection window.
 * Each action logs UTC start/stop to run/chaos.log so it can be lined up with the series.
 *
 *   redis-pause  <s>        docker pause the lab Redis: commands HANG (the throttler/cache/lockout
 *                           clients have a 2 s command timeout; BullMQ producers block)
 *   redis-stop   <s>        stop Redis: connection REFUSED (fail-open vs fail-closed paths)
 *   redis-slow   <ms> <s>   CLIENT PAUSE <ms> repeatedly: Redis answers, but late
 *   flush-cache             delete analytics/dashboard cache keys (NOT BullMQ keys): cold-cache / stampede
 *   pg-hog       <n> <s>    hold n lab-DB connections busy: connection-pool PRESSURE on the server side
 *   pg-pause     <s>        docker pause the lab Postgres: every query hangs, then resumes
 *   tap-slow     <ms>       stub latency  |  tap-fail <rate> [status]  |  tap-hang <rate>  |  tap-reset
 *   worker-stop  <s>        stop the lab worker (queue BACKLOG / worker unavailable), then restart it
 *   malformed    <rps> <s>  burst of malformed requests (bad JSON, unknown fields, bad UUIDs,
 *                           oversized header, bad auth): must be clean 4xx, never 5xx
 *   throttle-hit <rps> <s>  hammer ONE route from one IP to trip the throttler (only meaningful
 *                           with production limits ON, i.e. NODE_ENV != test)
 *
 * SAFETY: acts only on containers named ziyarati-c20k-*, the loopback API, the loopback Tap stub
 * and run/pids.json processes. It refuses to run if lab.json is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadLab, LAB_DIR, RUN_DIR } from './make-lab-env.mjs';

const REPO = path.resolve(LAB_DIR, '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const lab = loadLab();
const argv = process.argv.slice(2);
const action = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); fs.appendFileSync(path.join(RUN_DIR, 'chaos.log'), l + '\n'); };
const dk = (a) => spawnSync('docker', a, { encoding: 'utf8' });
const PG = lab.db.container; const RD = lab.redis.container;
const api = `http://127.0.0.1:${lab.ports.api}`;
const stub = `http://127.0.0.1:${lab.ports.tapStub}`;
const stubCfg = (o) => fetch(`${stub}/__admin/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

const at = flag('at'); if (at) { log(`waiting ${at}s before ${action}`); await sleep(at * 1000); }

switch (action) {
  case 'redis-pause': { const s = Number(pos[0] || 30); log(`redis-pause START ${s}s`); dk(['pause', RD]); await sleep(s * 1000); dk(['unpause', RD]); log('redis-pause END'); break; }
  case 'redis-stop': { const s = Number(pos[0] || 30); log(`redis-stop START ${s}s`); dk(['stop', RD]); await sleep(s * 1000); dk(['start', RD]); log('redis-stop END (container restarted)'); break; }
  case 'redis-slow': {
    const ms = Number(pos[0] || 200); const s = Number(pos[1] || 30); log(`redis-slow START ${ms}ms for ${s}s`);
    const end = Date.now() + s * 1000;
    while (Date.now() < end) { dk(['exec', RD, 'redis-cli', 'CLIENT', 'PAUSE', String(ms), 'ALL']); await sleep(ms); }
    log('redis-slow END'); break;
  }
  case 'flush-cache': {
    const pattern = pos[0] || '*analytics:*';
    const r = dk(['exec', RD, 'sh', '-c', `redis-cli --scan --pattern '${pattern}' | xargs -r redis-cli del | tail -1`]);
    log(`flush-cache pattern=${pattern} deleted=${(r.stdout || '').trim()}`); break;
  }
  case 'pg-hog': {
    const n = Number(pos[0] || 20); const s = Number(pos[1] || 30);
    const { Client } = require('pg');
    const env = Object.fromEntries(fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    log(`pg-hog START ${n} connections for ${s}s`);
    const cs = [];
    for (let i = 0; i < n; i++) { const c = new Client({ connectionString: env.DATABASE_URL, application_name: 'lt-chaos-hog' }); await c.connect(); c.query(`select pg_sleep(${s})`).catch(() => {}); cs.push(c); }
    await sleep(s * 1000 + 500); for (const c of cs) await c.end().catch(() => {});
    log('pg-hog END'); break;
  }
  case 'pg-pause': { const s = Number(pos[0] || 15); log(`pg-pause START ${s}s`); dk(['pause', PG]); await sleep(s * 1000); dk(['unpause', PG]); log('pg-pause END'); break; }
  case 'tap-slow': { await stubCfg({ latencyMs: Number(pos[0] || 2000) }); log(`tap-slow latency=${pos[0] || 2000}ms`); break; }
  case 'tap-fail': { await stubCfg({ failRate: Number(pos[0] || 1), failStatus: Number(pos[1] || 503) }); log(`tap-fail rate=${pos[0] || 1} status=${pos[1] || 503}`); break; }
  case 'tap-hang': { await stubCfg({ hangRate: Number(pos[0] || 1) }); log(`tap-hang rate=${pos[0] || 1} (exercises TAP_REQUEST_TIMEOUT_MS)`); break; }
  case 'tap-reset': { await stubCfg({ latencyMs: 0, jitterMs: 0, failRate: 0, hangRate: 0 }); log('tap-reset'); break; }
  case 'worker-stop': {
    const s = Number(pos[0] || 60);
    const startLab = path.join(LAB_DIR, 'start-lab.mjs');
    log(`worker-stop START ${s}s (queue backlog builds; outbox rows stay PENDING)`);
    const pids = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'pids.json'), 'utf8'));
    if (pids.worker) spawnSync(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/PID', String(pids.worker), '/T', '/F'] : [String(pids.worker)]);
    delete pids.worker; fs.writeFileSync(path.join(RUN_DIR, 'pids.json'), JSON.stringify(pids, null, 2));
    await sleep(s * 1000);
    spawnSync(process.execPath, [startLab, 'worker'], { stdio: 'inherit' });
    log('worker-stop END (worker restarted; backlog drains)'); break;
  }
  case 'malformed': {
    const rps = Number(pos[0] || 50); const s = Number(pos[1] || 20);
    const uuid = '00000000-0000-4000-8000-000000000000';
    const shapes = [
      () => fetch(`${api}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }),
      () => fetch(`${api}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x', password: 1, extra: 'y' }) }),
      () => fetch(`${api}/api/v1/appointments/not-a-uuid`, { headers: { authorization: 'Bearer abc' } }),
      () => fetch(`${api}/api/v1/appointments/${uuid}`, { headers: { authorization: 'Bearer ' + 'A'.repeat(4000) } }),
      () => fetch(`${api}/api/v1/public/discovery/clinics?cityId=not-a-uuid`),
      () => fetch(`${api}/api/v1/public/payments/links/${'x'.repeat(200)}`),
      () => fetch(`${api}/api/v1/payments/webhooks/tap`, { method: 'POST', headers: { 'content-type': 'application/json', hashstring: 'deadbeef' }, body: '{}' }),
      () => fetch(`${api}/api/v1/whatsapp/webhooks/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{"entry":[]}' }),
      () => fetch(`${api}/api/v1/integrations/inbound/${uuid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      () => fetch(`${api}/api/v1/crm/customers/search?q=${'%'.repeat(50)}&page=-1`, { headers: { authorization: 'Bearer abc' } }),
    ];
    log(`malformed START ${rps}/s for ${s}s`);
    const tally = {}; const end = Date.now() + s * 1000; let i = 0;
    while (Date.now() < end) {
      const batch = []; for (let k = 0; k < rps / 10; k++) batch.push(shapes[i++ % shapes.length]().then((r) => { const c = r.status >= 500 ? '5xx' : r.status >= 400 ? '4xx' : 'other'; tally[c] = (tally[c] || 0) + 1; }).catch(() => { tally.error = (tally.error || 0) + 1; }));
      await Promise.all(batch); await sleep(100);
    }
    log(`malformed END ${JSON.stringify(tally)} ${tally['5xx'] ? '<-- 5xx on malformed input is a DEFECT to report' : ''}`); break;
  }
  case 'throttle-hit': {
    const rps = Number(pos[0] || 20); const s = Number(pos[1] || 20); const tally = {}; const end = Date.now() + s * 1000;
    log(`throttle-hit START ${rps}/s for ${s}s`);
    while (Date.now() < end) {
      await Promise.all(Array.from({ length: Math.max(1, rps / 10) }, () => fetch(`${api}/api/v1/public/discovery/cities`).then((r) => { tally[r.status] = (tally[r.status] || 0) + 1; }).catch(() => { tally.error = (tally.error || 0) + 1; })));
      await sleep(100);
    }
    log(`throttle-hit END ${JSON.stringify(tally)}`); break;
  }
  default:
    console.error('actions: redis-pause redis-stop redis-slow flush-cache pg-hog pg-pause tap-slow tap-fail tap-hang tap-reset worker-stop malformed throttle-hit');
    process.exit(2);
}
