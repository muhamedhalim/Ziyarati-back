#!/usr/bin/env node
/**
 * Lab lifecycle: datastores, migrations, RBAC seed, API, worker, Tap stub.
 *
 *   node tests/load/lab/start-lab.mjs <command> [options]
 *
 *   up            docker compose up (pgvector Postgres + Redis, pinned, loopback)
 *   down          docker compose down (keeps volumes)   |  destroy: also drops volumes
 *   migrate       run migrations on the lab DB (dist/src/migrate.js run)
 *   seed-rbac     seed roles/permissions (src/seed/seed.ts) into the lab DB
 *   api           start the API   [--workers N --pool N]   (regenerates run/.env first)
 *   worker        start the worker (WORKER_ROLE=all, all providers noop)
 *   stub          start the Tap stub
 *   all           up + migrate + seed-rbac + stub + api + worker (idempotent)
 *   stop          stop api, worker, stub (not the datastores)
 *   status        what is running, readiness, migration count
 *
 * ISOLATION (the point of this file). Lab processes are spawned with
 *   - cwd = tests/load/lab/run/   so `ConfigModule`'s hard-coded `.env` is the LAB's .env;
 *   - an environment built FROM SCRATCH: PATH/SystemRoot/TEMP only, plus the lab variables
 *     (passed explicitly as well as in .env, because some rate-limit constants read
 *     NODE_ENV at module-import time, before dotenv runs).
 * Nothing from the developer's shell or the tracked .env is inherited. Secrets are never
 * printed. Every command refuses to run if the lab config points outside loopback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLab, loadLab, LAB_DIR, RUN_DIR, backendRoot } from './make-lab-env.mjs';

const REPO = backendRoot();
const LOGS = path.join(RUN_DIR, 'logs');
const PIDS = path.join(RUN_DIR, 'pids.json');
const COMPOSE = ['compose', '-p', 'ziyarati-c20k', '-f', path.join(LAB_DIR, 'docker-compose.lab.yml'), '--env-file', path.join(RUN_DIR, 'compose.env')];

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

function readEnvFile() {
  const out = {};
  for (const line of fs.readFileSync(path.join(RUN_DIR, '.env'), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Environment built from scratch: only what a Node process needs to run, plus the lab file. */
function cleanEnv(extra) {
  const base = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'COMSPEC', 'windir', 'NUMBER_OF_PROCESSORS']) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return Object.assign(base, readEnvFile(), extra || {});
}

function assertLoopbackLab(lab) {
  const env = readEnvFile();
  for (const key of ['DATABASE_URL', 'REDIS_URL']) {
    const host = /@?([^@/:]+)(?::\d+)?(?:\/|$)/.exec(env[key].replace(/^[a-z]+:\/\/([^@]*@)?/, '$1'));
    const h = (/^[a-z]+:\/\/(?:[^@]*@)?([^:/]+)/.exec(env[key]) || [])[1];
    if (h !== '127.0.0.1' && h !== 'localhost') throw new Error(`lab ${key} host is "${h}" — lab datastores must be loopback`);
    void host;
  }
  if (/sk_live_/.test(JSON.stringify(env))) throw new Error('lab env contains a live key prefix — refusing');
  if (env.NODE_ENV !== 'test') throw new Error('lab NODE_ENV must be "test"');
  void lab;
}

const sh = (bin, args, o = {}) => spawnSync(bin, args, Object.assign({ encoding: 'utf8', windowsHide: true }, o));
const docker = (args, o) => sh('docker', args, o);

function readPids() { try { return JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch { return {}; } }
function writePids(p) { fs.writeFileSync(PIDS, JSON.stringify(p, null, 2)); }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') sh('taskkill', ['/PID', String(pid), '/T', '/F']);
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
}

function distFresh() {
  const main = path.join(REPO, 'dist', 'src', 'main.js');
  if (!fs.existsSync(main)) return { ok: false, why: 'dist/src/main.js missing — run `npm run build`' };
  const distT = fs.statSync(main).mtimeMs;
  let newest = 0; let newestFile = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) { const t = fs.statSync(p).mtimeMs; if (t > newest) { newest = t; newestFile = p; } }
    }
  };
  walk(path.join(REPO, 'src'));
  return newest > distT
    ? { ok: false, why: `dist is OLDER than ${path.relative(REPO, newestFile)} — run \`npm run build\` (a stale dist would test code that is not in the repo)` }
    : { ok: true };
}

function startProc(name, script, args, extraEnv) {
  const pids = readPids();
  if (pids[name] && alive(pids[name])) { console.log(`${name}: already running (pid ${pids[name]})`); return; }
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, `${name}.log`), 'a');
  const child = spawn(process.execPath, [script, ...(args || [])], {
    cwd: RUN_DIR, env: cleanEnv(extraEnv), detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  pids[name] = child.pid;
  writePids(pids);
  console.log(`${name}: started (pid ${child.pid}), log ${path.relative(REPO, path.join(LOGS, `${name}.log`))}`);
}

async function waitHttp(url, label, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status === 200) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`${label}: not ready after ${tries * 2}s — see logs`);
  return false;
}

async function main() {
  const regen = ['api', 'worker', 'all'].includes(cmd);
  let lab;
  if (regen || !fs.existsSync(path.join(RUN_DIR, 'lab.json'))) {
    ({ lab } = buildLab({ workers: opt('workers'), pool: opt('pool'), 'worker-pool': opt('worker-pool'), payments: opt('payments') }));
  } else lab = loadLab();
  assertLoopbackLab(lab);

  switch (cmd) {
    case 'up': {
      const r = docker([...COMPOSE, 'up', '-d', '--wait'], { stdio: 'inherit' });
      process.exit(r.status || 0);
      break;
    }
    case 'down': process.exit(docker([...COMPOSE, 'down'], { stdio: 'inherit' }).status || 0); break;
    case 'destroy': process.exit(docker([...COMPOSE, 'down', '-v'], { stdio: 'inherit' }).status || 0); break;
    case 'migrate': {
      const f = distFresh(); if (!f.ok) { console.error(f.why); process.exit(3); }
      const r = sh(process.execPath, [path.join(REPO, 'dist', 'src', 'migrate.js'), 'run'], { cwd: RUN_DIR, env: cleanEnv(), stdio: 'inherit' });
      process.exit(r.status || 0);
      break;
    }
    case 'seed-rbac': {
      const ts = path.join(REPO, 'node_modules', 'ts-node', 'dist', 'bin.js');
      const r = sh(process.execPath, [ts, '--project', path.join(REPO, 'tsconfig.seed.json'), path.join(REPO, 'src', 'seed', 'seed.ts')], { cwd: RUN_DIR, env: cleanEnv(), stdio: 'inherit' });
      process.exit(r.status || 0);
      break;
    }
    case 'stub': {
      startProc('tap-stub', path.join(LAB_DIR, 'tap-stub.mjs'), ['--port', String(lab.ports.tapStub), '--pack-dir', path.join(LAB_DIR, '..', 'data', 'generated')]);
      break;
    }
    case 'api': {
      const f = distFresh(); if (!f.ok) { console.error(f.why); process.exit(3); }
      startProc('api', path.join(REPO, 'dist', 'src', 'main.js'));
      await waitHttp(`http://127.0.0.1:${lab.ports.api}/api/v1/system/health/readiness`, 'api');
      break;
    }
    case 'worker': {
      const f = distFresh(); if (!f.ok) { console.error(f.why); process.exit(3); }
      startProc('worker', path.join(REPO, 'dist', 'src', 'worker.js'));
      break;
    }
    case 'all': {
      for (const step of [['up'], ['migrate'], ['seed-rbac'], ['stub'], ['api'], ['worker']]) {
        const r = sh(process.execPath, [fileURLToPath(import.meta.url), ...step, ...argv.slice(1)], { stdio: 'inherit', env: process.env });
        if (r.status) { console.error(`step "${step[0]}" failed (${r.status})`); process.exit(r.status); }
      }
      break;
    }
    case 'stop': {
      const pids = readPids();
      for (const [n, pid] of Object.entries(pids)) { if (alive(pid)) { killTree(pid); console.log(`${n}: stopped`); } delete pids[n]; }
      writePids(pids);
      break;
    }
    case 'status': {
      const pids = readPids();
      for (const n of ['api', 'worker', 'tap-stub']) console.log(`${n.padEnd(9)} ${pids[n] && alive(pids[n]) ? `running pid ${pids[n]}` : 'stopped'}`);
      const ps = docker(['ps', '--filter', 'name=ziyarati-c20k', '--format', '{{.Names}} {{.Status}}']);
      console.log(ps.stdout.trim() || '(no lab containers running — is Docker Desktop started?)');
      try { const r = await fetch(`http://127.0.0.1:${lab.ports.api}/api/v1/system/health/readiness`); console.log(`readiness: ${r.status}`); } catch { console.log('readiness: unreachable'); }
      const f = distFresh(); console.log(f.ok ? 'dist: fresh' : `dist: ${f.why}`);
      break;
    }
    default:
      console.error('usage: start-lab.mjs up|down|destroy|migrate|seed-rbac|api|worker|stub|all|stop|status [--workers N --pool N --worker-pool N --payments tap|noop]');
      process.exit(2);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
