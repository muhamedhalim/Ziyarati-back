import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { WorkerModule } from './worker.module';
import { MetricsService } from './metrics/metrics.service';
import { startMetricsHttpServer } from './metrics/start-metrics-http-server';

/**
 * Worker process entrypoint (deployed as a SEPARATE Railway service —
 * `node dist/worker.js`). It is an application CONTEXT (no HTTP server): it only
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
