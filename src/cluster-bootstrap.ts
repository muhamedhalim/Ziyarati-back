import cluster from 'node:cluster';
import { Logger } from '@nestjs/common';

const logger = new Logger('ClusterBootstrap');

/** Crash-loop guard: if more than this many *unexpected* worker exits happen
 *  within CRASH_WINDOW_MS, stop respawning (a persistently broken deploy
 *  should not spin the primary forever) — the remaining healthy workers keep
 *  serving instead of the container looping forever on a dead configuration. */
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_PER_WINDOW_PER_WORKER = 4;

/** Bound on how long the primary waits for workers to exit cleanly on
 *  SIGTERM/SIGINT before force-killing whatever is left. Comfortably above
 *  what `app.close()` needs for its own onModuleDestroy hooks (Redis/DB
 *  connections only — no BullMQ drain on the API side, see main.ts). */
const SHUTDOWN_GRACE_MS = 25_000;

/**
 * PERF-INFRA-003 — process-level scaling for the API entrypoint only.
 *
 * Default (`API_CLUSTER_WORKERS` unset or `1`): calls `runWorker` directly,
 * in this same process — byte-identical to the pre-PERF-INFRA-003 behaviour.
 * No existing deployment is affected unless the env var is set explicitly.
 *
 * When `API_CLUSTER_WORKERS > 1`: the primary process forks N copies of
 * itself (each re-entering this same entrypoint, landing in the
 * `!cluster.isPrimary` branch below, which just calls `runWorker` — the real,
 * unmodified Nest bootstrap) and never runs `runWorker` itself. Node's
 * cluster module transparently shares the single listening port across all
 * workers (no code change needed in `runWorker`/`app.listen()` — proven by
 * this finding's own Stage B experiment, `scripts/perf/infra003-cluster-runner.js`,
 * which wrapped the pre-existing, unmodified `dist/src/main.js` the same way).
 *
 * Safe to fork the API root specifically — confirmed by inspection before
 * this was written, not assumed:
 *  - BullMQ `@Processor` (job-consuming) classes exist ONLY in `WorkerModule`
 *    (worker.ts) — `queue.module.ts`'s own docstring: "the API never
 *    consumes". Forking the API N times cannot duplicate job processing.
 *  - The repeatable/cron-equivalent jobs are registered ONLY by
 *    `ScheduleRegistrarService`, itself only ever instantiated by
 *    `WorkerModule` — never reachable from this entrypoint at all — and its
 *    own docstring notes BullMQ dedups repeatables by their `{name, repeat}`
 *    key regardless, so it would be idempotent even if it were.
 *  - Migrations run behind a cross-process Postgres advisory lock
 *    (`run-migrations-with-lock.ts`, explicitly "serializing migration runs
 *    across every process root (API + worker) and every replica of each").
 *  - Every `OnApplicationBootstrap` schema bootstrap (`PaymentsSchemaBootstrap`
 *    et al.) issues only `IF NOT EXISTS`/`CREATE OR REPLACE` DDL wrapped in a
 *    per-statement try/catch that logs and continues on conflict — safe
 *    under concurrent first-boot races.
 *  - The Socket.IO gateway already uses a Redis-backed adapter specifically
 *    "so the realtime gateway scales horizontally" (`redis-io.adapter.ts`),
 *    and `AgentPresenceService`'s Redis Lua scripts are documented as atomic
 *    "across concurrent API replicas". Payment idempotency is a DB unique
 *    constraint (`idempotency_key`), not in-process state, so it is correct
 *    regardless of process count.
 *
 * Each worker is a fully separate OS process (no shared memory) — as
 * isolated from its siblings as N independently-started `node dist/src/main`
 * invocations would be. See docs/PERFORMANCE_INFRASTRUCTURE.md's
 * PERF-INFRA-003 section for the measured before/after evidence.
 */
export function runClustered(runWorker: () => void | Promise<void>): void {
  const requested = Number(process.env.API_CLUSTER_WORKERS ?? 1);
  const numWorkers = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : 1;

  if (!cluster.isPrimary || numWorkers <= 1) {
    void runWorker();
    return;
  }

  const poolMaxHint = Number(
    process.env.API_DB_POOL_MAX ?? process.env.DB_POOL_MAX ?? 15,
  );
  logger.log(
    `Primary pid=${process.pid} starting ${numWorkers} API worker process(es) ` +
      `(API_CLUSTER_WORKERS=${numWorkers}). Estimated DB connections: ` +
      `${numWorkers} × ${poolMaxHint} (per-worker pool) = ${numWorkers * poolMaxHint}. ` +
      `Verify this fits Postgres's own max_connections alongside the worker ` +
      `process and any other deployment.`,
  );
  if (numWorkers * poolMaxHint > 50) {
    logger.warn(
      `Estimated API DB connections (${numWorkers * poolMaxHint}) is high — ` +
        `consider lowering API_DB_POOL_MAX to keep the total comfortable ` +
        `under Postgres's max_connections once the worker process and any ` +
        `other consumer are also counted.`,
    );
  }

  let shuttingDown = false;
  let expectedExits = 0;
  const recentCrashes: number[] = [];

  for (let i = 0; i < numWorkers; i++) cluster.fork();

  cluster.on('online', (worker) => {
    logger.log(`worker pid=${worker.process.pid} online`);
  });

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      expectedExits -= 1;
      logger.log(
        `worker pid=${worker.process.pid} exited during shutdown ` +
          `(signal=${signal ?? 'n/a'}, code=${code})`,
      );
      if (expectedExits <= 0) {
        logger.log('all workers exited — primary shutting down');
        process.exit(0);
      }
      return;
    }

    logger.error(
      `worker pid=${worker.process.pid} exited unexpectedly ` +
        `(code=${code}, signal=${signal ?? 'n/a'}) — respawning`,
    );
    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length && now - recentCrashes[0] > CRASH_WINDOW_MS) {
      recentCrashes.shift();
    }
    if (recentCrashes.length > numWorkers * MAX_CRASHES_PER_WINDOW_PER_WORKER) {
      logger.error(
        `${recentCrashes.length} worker crashes in the last ${CRASH_WINDOW_MS / 1000}s ` +
          `— not respawning this exit (likely a persistent misconfiguration). ` +
          `Remaining workers keep serving.`,
      );
      return;
    }
    cluster.fork();
  });

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const workers = Object.values(cluster.workers ?? {}).filter(
      (w): w is NonNullable<typeof w> => !!w,
    );
    expectedExits = workers.length;
    logger.log(
      `primary received ${signal} — forwarding to ${workers.length} worker(s), ` +
        `grace=${SHUTDOWN_GRACE_MS}ms`,
    );
    if (workers.length === 0) {
      process.exit(0);
      return;
    }

    const forceTimer = setTimeout(() => {
      logger.warn(
        'graceful shutdown timed out — force-killing remaining workers',
      );
      for (const w of Object.values(cluster.workers ?? {})) {
        w?.process.kill('SIGKILL');
      }
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();

    for (const w of workers) w.process.kill(signal);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
