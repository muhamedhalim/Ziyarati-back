#!/usr/bin/env node
/**
 * Generates the LAB's private configuration — the thing that makes it impossible for a
 * lab API/worker process to inherit the tracked `.env` (which holds live-looking Tap,
 * Meta, R2, OpenAI and Resend credentials).
 *
 * WHY THIS EXISTS. The app hard-codes `ConfigModule.forRoot({ envFilePath: '.env' })`
 * (app.module.ts:91, worker.module.ts:244) — relative to the PROCESS WORKING DIRECTORY.
 * Entities/migrations resolve via __dirname, so the app is cwd-independent apart from that
 * one file. start-lab.mjs therefore runs every lab process with cwd = tests/load/lab/run/,
 * where THIS script writes a `.env` containing ONLY lab values, and spawns it with an
 * environment built from scratch (no inheritance). Default-deny: any variable not written
 * here is simply absent (Joi defaults / unconfigured providers), so there is nothing to
 * scrub and nothing to forget.
 *
 * Outputs (all under tests/load/lab/run/, gitignored; secrets are NEVER printed):
 *   lab.json   ports, database, generated secrets, queue prefix, knobs
 *   .env       the process env file the API and worker read
 *
 * Usage: node make-lab-env.mjs [--workers N] [--pool N] [--worker-pool N]
 *                              [--payments tap|noop] [--pg-port N] [--redis-port N]
 *                              [--api-port N] [--regen-secrets]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const LAB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const RUN_DIR = path.join(LAB_DIR, 'run');
export const LAB_JSON = path.join(RUN_DIR, 'lab.json');

const rnd = (n) => crypto.randomBytes(n).toString('hex');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true; else { o[k] = next; i++; }
  }
  return o;
}

export function loadLab() {
  if (!fs.existsSync(LAB_JSON)) throw new Error(`lab config missing: run node ${path.join('tests/load/lab/make-lab-env.mjs')} first`);
  return JSON.parse(fs.readFileSync(LAB_JSON, 'utf8'));
}

export function buildLab(opts = {}) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(LAB_JSON, 'utf8')); } catch { /* first run */ }
  const keep = prev && !opts['regen-secrets'];
  const lab = {
    schema: 'lt-lab/1',
    createdAt: keep ? prev.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ports: {
      api: Number(opts['api-port'] || prev?.ports?.api || 3101),
      pg: Number(opts['pg-port'] || prev?.ports?.pg || 5436),
      redis: Number(opts['redis-port'] || prev?.ports?.redis || 6382),
      tapStub: Number(prev?.ports?.tapStub || 4477),
      workerMetrics: Number(prev?.ports?.workerMetrics || 9191),
    },
    db: { name: 'ziyarati_c20k', user: 'postgres', password: keep ? prev.db.password : rnd(12), container: 'ziyarati-c20k-postgres' },
    redis: { container: 'ziyarati-c20k-redis' },
    queuePrefix: 'c20k',
    knobs: {
      workers: Number(opts.workers || prev?.knobs?.workers || 1),
      pool: Number(opts.pool || prev?.knobs?.pool || 15),
      workerPool: Number(opts['worker-pool'] || prev?.knobs?.workerPool || 10),
      payments: String(opts.payments || prev?.knobs?.payments || 'tap'),
      pgMaxConnections: Number(prev?.knobs?.pgMaxConnections || 300),
    },
    secrets: keep ? prev.secrets : {
      jwtAccess: rnd(32), jwtRefresh: rnd(32), credKey: rnd(32),
      loginPassword: `Lt!${rnd(9)}a1`, tapSecret: `sk_test_${rnd(16)}`, tapSegment: `sk_test_${rnd(16)}`,
      metaAppSecret: rnd(16), metaVerifyToken: rnd(8),
    },
  };
  fs.writeFileSync(LAB_JSON, JSON.stringify(lab, null, 2), { mode: 0o600 });

  const s = lab.secrets;
  const k = lab.knobs;
  const env = {
    // ---- identity of the process: this is a LAB, never production
    NODE_ENV: 'test',
    PORT: String(lab.ports.api),
    // ---- datastores: loopback lab containers only
    DATABASE_URL: `postgres://${lab.db.user}:${lab.db.password}@127.0.0.1:${lab.ports.pg}/${lab.db.name}`,
    REDIS_URL: `redis://127.0.0.1:${lab.ports.redis}`,
    QUEUE_ENV_PREFIX: lab.queuePrefix,
    DB_MAX_CONNECTIONS: String(k.pgMaxConnections),
    API_DB_POOL_MAX: String(k.pool),
    WORKER_DB_POOL_MAX: String(k.workerPool),
    ...(k.workers > 1 ? { API_CLUSTER_WORKERS: String(k.workers) } : {}),
    // ---- never let a boot mutate the lab schema/data on its own
    TYPEORM_SYNCHRONIZE: 'false',
    TYPEORM_LOGGING: 'false',
    SEED_ON_STARTUP: 'false',
    PLATFORM_API_LOG_ENABLED: 'false',
    // ---- lab-only secrets (generated; the real ones are never read)
    JWT_ACCESS_SECRET: s.jwtAccess,
    JWT_REFRESH_SECRET: s.jwtRefresh,
    CREDENTIALS_ENCRYPTION_KEY: s.credKey,
    // ---- websocket / CORS origin allow-list (a raw k6 socket sends NO Origin and no Cookie)
    FRONTEND_ORIGIN: 'http://localhost:3000,http://127.0.0.1:3000',
    APP_URL: 'http://localhost:3000',
    COOKIE_SAMESITE: 'lax',
    // ---- external providers: OFF by omission, and explicitly blank where a default exists
    OPENAI_API_KEY: '',
    RESEND_API_KEY: '',
    EMAIL_ENABLED: 'false',
    EMAIL_PROVIDER: 'noop',
    MOYASAR_SECRET_KEY: '',
    // ---- Tap: a FAKE sandbox key against the LOCAL stub (see tap-stub.mjs)
    ...(k.payments === 'tap' ? {
      PAYMENT_PROVIDER: 'tap',
      TAP_ENV: 'sandbox',
      TAP_TEST_SECRET_KEY: s.tapSecret,
      TAP_API_BASE: `http://127.0.0.1:${lab.ports.tapStub}`,
      TAP_MERCHANT_ID: 'lab-platform-merchant',
      TAP_WEBHOOK_URL: 'https://lab.example.test/api/v1/payments/webhooks/tap',
      TAP_BOOKING_PAYMENTS_ENABLED: 'true',
      TAP_PLATFORM_ID: 'commerce_platform_LabNotReal',
      TAP_SEGMENT_SECRET_KEY: s.tapSegment,
      TAP_RECURRING_ENABLED: 'true',
      TAP_REQUEST_TIMEOUT_MS: '15000',
    } : { PAYMENT_PROVIDER: 'noop' }),
    // ---- Meta: a FAKE app secret so signed synthetic webhooks verify; no token anywhere
    META_APP_SECRET: s.metaAppSecret,
    META_WEBHOOK_VERIFY_TOKEN: s.metaVerifyToken,
    // ---- worker
    WORKER_ROLE: 'all',
    WORKER_METRICS_PORT: String(lab.ports.workerMetrics),
  };
  const lines = ['# GENERATED by tests/load/lab/make-lab-env.mjs — LAB ONLY. Do not edit, do not commit.'];
  for (const [key, val] of Object.entries(env)) lines.push(`${key}=${val}`);
  fs.writeFileSync(path.join(RUN_DIR, '.env'), lines.join('\n') + '\n', { mode: 0o600 });
  // docker compose interpolation file (password lives here, never on a command line)
  const compose = [
    `LAB_PG_PASSWORD=${lab.db.password}`,
    `LAB_PG_PORT=${lab.ports.pg}`,
    `LAB_REDIS_PORT=${lab.ports.redis}`,
    `PG_MAX_CONNECTIONS=${k.pgMaxConnections}`,
  ];
  fs.writeFileSync(path.join(RUN_DIR, 'compose.env'), compose.join('\n') + '\n', { mode: 0o600 });
  return { lab, envKeys: Object.keys(env) };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('make-lab-env.mjs')) {
  const { lab, envKeys } = buildLab(parseArgs(process.argv.slice(2)));
  console.log(`lab config written to ${RUN_DIR}`);
  console.log(`  ports api=${lab.ports.api} pg=${lab.ports.pg} redis=${lab.ports.redis} tapStub=${lab.ports.tapStub}`);
  console.log(`  knobs  workers=${lab.knobs.workers} pool=${lab.knobs.pool} workerPool=${lab.knobs.workerPool} payments=${lab.knobs.payments}`);
  console.log(`  .env defines ${envKeys.length} variables (names only): ${envKeys.join(', ')}`);
  console.log('  secrets: generated and stored in lab.json (not printed)');
}

/**
 * The backend tree the lab BUILDS AND RUNS (dist/, src/migrations, node_modules). Default: this checkout.
 * `run/backend-root.txt` pins it to another directory (an isolated `git worktree` of one commit), so a
 * shared working tree that other people are editing cannot change the code under test mid-campaign.
 */
export function backendRoot() {
  const f = path.join(RUN_DIR, 'backend-root.txt');
  try { const p = fs.readFileSync(f, 'utf8').trim(); if (p && fs.existsSync(path.join(p, 'dist', 'src', 'main.js'))) return path.resolve(p); } catch { /* default */ }
  return path.resolve(LAB_DIR, '..', '..', '..');
}
