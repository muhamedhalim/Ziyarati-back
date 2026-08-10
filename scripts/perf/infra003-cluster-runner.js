'use strict';

/**
 * PERF-INFRA-003 — process-level-scaling EXPERIMENT ONLY.
 *
 * Forks N copies of the real, unmodified `dist/src/main.js` (the API
 * bootstrap) behind Node's built-in `cluster` module, all sharing one port,
 * to measure whether process-level scaling materially improves throughput
 * and tail latency versus one process. This script is NOT wired into any
 * npm script, Dockerfile, or start command — it exists only to produce
 * comparative evidence for PERF-INFRA-003 on the isolated
 * `ziyarati-perfaudit-*` stack. Shipping real clustering (graceful shutdown
 * per worker, sticky sessions if any WS/SSE path needs them, PM2/systemd
 * process supervision) is out of this investigation's scope — see the
 * finding's own `recommendedFix` for what a real rollout would still need.
 *
 * Safe to fork the API root specifically: `queue.module.ts`'s own docstring
 * confirms `@Processor` (job-consuming) classes exist ONLY in WorkerModule —
 * "the API never consumes" — so forking N API processes never multiplies
 * BullMQ repeatable-job registration or job processing, both of which stay
 * confined to the single, unforked worker.ts process this script never
 * touches.
 *
 * Usage:
 *   node scripts/perf/infra003-cluster-runner.js --workers=4
 * (env vars — PORT, DATABASE_URL, REDIS_URL, etc. — are inherited from the
 * shell that launches this script, exactly like running main.js directly.)
 */

const cluster = require('node:cluster');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const numWorkers = Number(args.workers || 2);
const port = Number(process.env.PORT || 3001);

if (cluster.isPrimary) {
  console.log(`[cluster-runner] primary pid=${process.pid} forking ${numWorkers} workers, port=${port}`);

  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(`[cluster-runner] worker ${worker.process.pid} online`);
  });
  cluster.on('exit', (worker, code, signal) => {
    console.log(`[cluster-runner] worker ${worker.process.pid} exited (code=${code}, signal=${signal})`);
  });

  // Poll the shared port until real requests succeed, then print a stable
  // marker line the launching harness can grep for.
  (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/health/readiness`);
        if (res.ok) {
          // Grace window for straggler workers to finish their own boot.
          await new Promise((r) => setTimeout(r, 3000));
          console.log('CLUSTER_READY');
          return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.error('[cluster-runner] readiness check never succeeded within 30s');
    process.exit(1);
  })();

  const shutdown = () => {
    console.log('[cluster-runner] shutting down all workers');
    for (const id in cluster.workers) cluster.workers[id]?.process.kill('SIGTERM');
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  // Worker process: the real, unmodified API bootstrap. main.ts's own
  // `void bootstrap()` self-invokes on require — nothing else to call here.
  require('../../dist/src/main.js');
}
