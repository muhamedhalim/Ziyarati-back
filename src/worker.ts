import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { WorkerModule } from './worker.module';
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
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });

  // Minimal /metrics listener (M14 — docs/CACHING_QUEUES_AUDIT.md), a plain
  // http.Server, NOT a Nest HTTP adapter — see this module's own docstring
  // above on why the worker stays adapter-free otherwise.
  const metricsServer = startMetricsHttpServer(
    app.get(ConfigService),
    app.get(MetricsService),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Received ${signal} — draining workers and shutting down…`);
    try {
      await new Promise<void>((resolve) =>
        metricsServer.close(() => resolve()),
      );
      await app.close(); // closes processors gracefully (finishes active jobs) + monitor
      logger.log('Worker shut down cleanly.');
      process.exit(0);
    } catch (err) {
      logger.error(`Error during shutdown: ${(err as Error)?.message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.log('🛠️  Worker process started — consuming BullMQ jobs');
}

void bootstrap();
