'use strict';

/**
 * PERF-INFRA-003 verification helper (measurement-only, not wired into any
 * npm script). Spawns `dist/src/main` as this script's OWN direct child (a
 * real parent->child relationship, the same one `cluster.fork()` creates
 * internally) and sends it SIGTERM/SIGINT via `child.kill()`, confirming the
 * graceful-shutdown log line appears and the process exits within budget.
 *
 * Distinct from an external `process.kill(otherPid, sig)` against an
 * unrelated/detached process, which this session confirmed hard-kills
 * without invoking any handler on this Windows machine — a known Node-on-
 * Windows limitation (already documented in this repo's own T014 finding),
 * not something this probe needs to route around: production runs Linux
 * (ECS on Linux), where POSIX signal delivery works as designed, and this exact
 * `process.on('SIGTERM')` pattern is what the current unclustered app
 * already relies on today.
 *
 * Usage:
 *   node scripts/perf/cluster-shutdown-probe.js --signal=SIGTERM [--workers=4]
 *   (DATABASE_URL/REDIS_URL/PORT/NODE_ENV/TYPEORM_SYNCHRONIZE inherited from
 *   the launching shell, same convention as start-local-stack.md step 4.)
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const signal = args.signal || 'SIGTERM';
const workers = args.workers ? String(args.workers) : undefined;
const port = Number(process.env.PORT || 3001);

async function waitForReady(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/health/readiness`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const env = { ...process.env };
  if (workers) env.API_CLUSTER_WORKERS = workers;

  console.log(`[shutdown-probe] spawning dist/src/main (API_CLUSTER_WORKERS=${env.API_CLUSTER_WORKERS ?? '1 (default)'})`);
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'dist', 'src', 'main.js')], {
    cwd: path.join(__dirname, '..', '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, sig) => resolve({ code, sig }));
  });

  const ready = await waitForReady(30_000);
  if (!ready) {
    console.error('[shutdown-probe] FAILED: never became ready');
    child.kill('SIGKILL');
    process.exit(1);
  }
  console.log('[shutdown-probe] ready — sending', signal);

  const t0 = Date.now();
  child.kill(signal);

  const result = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 30_000)),
  ]);
  const elapsedMs = Date.now() - t0;

  if (result.timedOut) {
    console.error(`[shutdown-probe] FAILED: did not exit within 30s of ${signal}`);
    console.log('--- captured output (last 3000 chars) ---');
    console.log(out.slice(-3000));
    child.kill('SIGKILL');
    process.exit(1);
  }

  const sawGracefulLog = /Received (SIGTERM|SIGINT)|shutting down|shut down cleanly|primary received/i.test(out);
  console.log(`[shutdown-probe] exited after ${elapsedMs}ms — code=${result.code} signal=${result.sig} sawGracefulLog=${sawGracefulLog}`);
  console.log('--- captured output (last 3000 chars) ---');
  console.log(out.slice(-3000));

  process.exit(sawGracefulLog ? 0 : 2);
}

main().catch((err) => {
  console.error('[shutdown-probe] ERROR', err);
  process.exit(1);
});
