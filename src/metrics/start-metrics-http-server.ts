import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { MetricsService } from './metrics.service';

/**
 * Minimal standalone `GET /metrics` listener for the WORKER process (M14 —
 * docs/CACHING_QUEUES_AUDIT.md). The worker (`worker.ts`) is deliberately a
 * pure `NestFactory.createApplicationContext` with no HTTP adapter (see its
 * own docstring), so this does NOT mount a Nest controller — a raw
 * `http.createServer` is the "small HTTP listener" the finding's own
 * proposed solution calls for, kept as small as the API's equivalent route:
 * same static-bearer-token check as `MetricsAuthGuard` (fail closed with no
 * token in production, open in dev), same `Registry#metrics()` body.
 */
export function startMetricsHttpServer(
  config: ConfigService,
  metrics: MetricsService,
): Server {
  const logger = new Logger('WorkerMetricsServer');
  const port = Number(config.get<string>('WORKER_METRICS_PORT') ?? '9091');

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }

    const token = config.get<string>('METRICS_TOKEN');
    const isProduction = config.get<string>('NODE_ENV') === 'production';
    if (!token) {
      if (isProduction) {
        res
          .writeHead(401)
          .end('Metrics endpoint is not configured (METRICS_TOKEN unset).');
        return;
      }
    } else {
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : '';
      if (!presented || !constantTimeEquals(presented, token)) {
        res.writeHead(401).end('Invalid or missing metrics bearer token.');
        return;
      }
    }

    metrics
      .render()
      .then((body) => {
        res.writeHead(200, {
          'Content-Type': metrics.contentType,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      })
      .catch((err: Error) => {
        logger.error(`metrics render failed: ${err.message}`);
        res.writeHead(500).end();
      });
  });

  server.listen(port, () =>
    logger.log(`Worker /metrics listening on :${port}`),
  );
  server.on('error', (err) =>
    logger.error(`metrics server error: ${(err as Error).message}`),
  );
  return server;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
