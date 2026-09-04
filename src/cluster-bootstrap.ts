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

  const estimate = estimateDbConnections({
    numWorkers,
    apiPoolMaxEnv: process.env.API_DB_POOL_MAX,
    workerPoolMaxEnv: process.env.WORKER_DB_POOL_MAX,
    dbPoolMaxEnv: process.env.DB_POOL_MAX,
    maxConnectionsEnv: process.env.DB_MAX_CONNECTIONS,
  });

  logger.log(
    `Primary pid=${process.pid} starting ${numWorkers} API worker process(es) ` +
      `(API_CLUSTER_WORKERS=${numWorkers}). ${estimate.summary}`,
  );
  if (estimate.warning) logger.warn(estimate.warning);

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

export interface DbConnectionEstimateInput {
  numWorkers: number;
  apiPoolMaxEnv: string | undefined;
  workerPoolMaxEnv: string | undefined;
  dbPoolMaxEnv: string | undefined;
  maxConnectionsEnv: string | undefined;
}

export interface DbConnectionEstimate {
  estimatedConnections: number;
  /** Always present — the boot-time `logger.log` line's content. */
  summary: string;
  /** Present only when the estimate crosses its threshold. */
  warning: string | undefined;
}

/**
 * P1.1 (2026-09-04) — pure connection-capacity estimator, extracted from
 * `runClustered` so the formula and its threshold logic are unit-testable
 * without mocking Node's `cluster`/`process` internals.
 *
 * `apiPoolMax`/`workerPoolMax` mirror `typeorm.config.ts`'s own
 * `poolMax('api'|'worker', ...)` fallback exactly (role-specific var, else
 * `DB_POOL_MAX`, else 15) so this estimate can never disagree with what the
 * factory actually configures. Both are included — not just the API's own
 * share — because the two together are what actually contends for
 * Postgres's `max_connections`, and an operator sizing this needs the whole
 * picture.
 *
 * ×2 ON THE API TERM ONLY, DELIBERATELY: a rolling restart briefly runs the
 * OLD and NEW set of API workers at once (the orchestrator keeps the old
 * ones accepting connections until the new ones report healthy), so
 * steady-state demand understates the real peak an operator needs headroom
 * for by roughly double, on the API side specifically — the worker root is
 * a single long-lived process per deployment, not typically rolled the same
 * way, so its own pool is not doubled here.
 *
 * `maxConnectionsEnv` (`DB_MAX_CONNECTIONS`) is OPTIONAL and purely
 * informational — this application has no way to read Postgres's own
 * setting. Supplied: warns above 80% of it. Unsupplied: falls back to a
 * fixed `> 50` guess, same threshold this estimator used before P1.1. See
 * `tests/load/reports/P1.1_CAPACITY_WORKSHEET.md`.
 */
export function estimateDbConnections(
  input: DbConnectionEstimateInput,
): DbConnectionEstimate {
  const dbPoolMax = Number(input.dbPoolMaxEnv ?? 15);
  const apiPoolMax = Number(input.apiPoolMaxEnv ?? dbPoolMax);
  const workerPoolMax = Number(input.workerPoolMaxEnv ?? dbPoolMax);
  const estimatedConnections =
    input.numWorkers * apiPoolMax * 2 + workerPoolMax;
  const maxConnections = input.maxConnectionsEnv
    ? Number(input.maxConnectionsEnv)
    : undefined;

  const summary =
    `Estimated peak DB connections: ${input.numWorkers} × ${apiPoolMax} × 2 ` +
    `(API, rolling-restart headroom) + ${workerPoolMax} (worker) = ${estimatedConnections}` +
    (maxConnections
      ? ` — against DB_MAX_CONNECTIONS=${maxConnections} (${Math.round((estimatedConnections / maxConnections) * 100)}%).`
      : `. Set DB_MAX_CONNECTIONS to compare against Postgres's real ceiling ` +
        `instead of this fixed-threshold guess — see ` +
        `tests/load/reports/P1.1_CAPACITY_WORKSHEET.md.`);

  let warning: string | undefined;
  if (maxConnections && estimatedConnections > maxConnections * 0.8) {
    warning =
      `Estimated peak DB connections (${estimatedConnections}) is above 80% of ` +
      `DB_MAX_CONNECTIONS=${maxConnections} — lower API_DB_POOL_MAX/WORKER_DB_POOL_MAX ` +
      `or API_CLUSTER_WORKERS, or raise Postgres's own max_connections, before this ` +
      `deployment runs under real concurrent load. See ` +
      `tests/load/reports/P1.1_CAPACITY_WORKSHEET.md.`;
  } else if (!maxConnections && estimatedConnections > 50) {
    warning =
      `Estimated peak DB connections (${estimatedConnections}) is high — consider ` +
      `lowering API_DB_POOL_MAX/WORKER_DB_POOL_MAX to keep the total comfortable ` +
      `under Postgres's max_connections. Set DB_MAX_CONNECTIONS for a precise ` +
      `comparison instead of this fixed-threshold guess.`;
  }

  return { estimatedConnections, summary, warning };
}
