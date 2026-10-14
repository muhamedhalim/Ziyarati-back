// MUST stay the first import — see common/logging/tracing.ts.
import './common/logging/tracing-worker';
// Second: JSON logging for module-load-time Logger calls too (WorkerModule
// logs its WORKER_ROLE decision while it is being imported).
import './common/logging/logger-worker';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { WorkerModule } from './worker.module';
import { createRootLogger } from './common/logging/structured-logger';
import { installJobInstrumentation } from './common/logging/job-instrumentation';
import { installProviderInstrumentation } from './common/logging/provider-instrumentation';
import { installFatalHandlers } from './common/logging/process-handlers';
import { startHeartbeat } from './common/logging/heartbeat';
import { LOG_EVENT } from './common/logging/log-events';
import { isTracingEnabled, shutdownTracing } from './common/logging/tracing';
import { MetricsService } from './metrics/metrics.service';
import { startMetricsHttpServer } from './metrics/start-metrics-http-server';

// Spec 014 (Clinic Platform Completion) — T021. The ONE process-identity
// marker `DocumentRendererService` checks to refuse construction outside the
// worker (PDF generation must never run on the request path — R2). Set
// before `NestFactory.createApplicationContext` below instantiates any
// provider; `main.ts` (API) and `migrate.ts` never set this, so it is
// exactly the signal DocumentRendererService needs.
process.env.PROCESS_ROLE = 'worker';

/**
 * Worker process entrypoint (deployed as a SEPARATE service —
 * `node dist/src/worker.js`, the same image as the API with the command
 * overridden). It is an application CONTEXT (no HTTP server): it only
 * consumes BullMQ jobs. The API (`main.ts`) only enqueues.
 *
 * Graceful shutdown: on SIGTERM/SIGINT it closes the Nest context, which closes
 * each BullMQ Worker (waiting for in-flight jobs to finish) and the QueueEvents
 * connections — so no job is lost on a normal deploy/restart.
 */
async function bootstrap(): Promise<void> {
  // Job failures log `err.message` verbatim in ~20 processors; the structured
  // logger scrubs them all through the same seam RedactingLogger used
  // (residency plan P7), and emits one JSON line per record. See LOGGING.md.
  const rootLogger = createRootLogger('worker');
  // Before the context exists: crashes during boot are logged too. Until the
  // app is up there is nothing to close, so shutdown resolves immediately.
  let closeApp: (reason: string) => Promise<void> = async () => undefined;
  installFatalHandlers({ logger: rootLogger, shutdown: () => closeApp('fatal_error') });
  // Both must run before any Worker or HTTP client is constructed.
  installJobInstrumentation();
  installProviderInstrumentation();

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
    logger: rootLogger,
  });

  // Minimal /metrics listener (M14 — docs/CACHING_QUEUES_AUDIT.md), a plain
  // http.Server, NOT a Nest HTTP adapter — see this module's own docstring
  // above on why the worker stays adapter-free otherwise.
  const metricsServer = startMetricsHttpServer(
    app.get(ConfigService),
    app.get(MetricsService),
  );

  // `app.shutdown.completed` is written only after the drain really finished.
  let shuttingDown = false;
  closeApp = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const startedAt = Date.now();
    rootLogger.event('info', LOG_EVENT.APP_SHUTDOWN_STARTED, `Received ${reason}; draining workers and shutting down`, { reason });
    try {
      await new Promise<void>((resolve) =>
        metricsServer.close(() => resolve()),
      );
      await app.close(); // closes processors gracefully (finishes active jobs) + monitor
      await shutdownTracing();
      rootLogger.event('info', LOG_EVENT.APP_SHUTDOWN_COMPLETED, 'Worker shut down cleanly', {
        reason,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      rootLogger.event('error', LOG_EVENT.APP_SHUTDOWN_FAILED, 'Error during shutdown', { reason, error: err });
      throw err;
    }
  };
  const shutdown = (signal: string): void => {
    closeApp(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  startHeartbeat(rootLogger); // unref'd timer; never holds the process open
  rootLogger.event('info', LOG_EVENT.APP_STARTUP_COMPLETED, 'Worker started; consuming BullMQ jobs', {
    node_version: process.version,
    log_level: rootLogger.config.level,
    log_format: rootLogger.config.format,
    tracing_enabled: isTracingEnabled(),
    worker_role: process.env.WORKER_ROLE ?? 'all',
  });
}

void bootstrap();
