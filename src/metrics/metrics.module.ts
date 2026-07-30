import { Global, Module } from '@nestjs/common';

import { MetricsService } from './metrics.service';

/**
 * Global (M14 — see docs/CACHING_QUEUES_AUDIT.md) so `MetricsService` is
 * injectable from any module in EITHER process root without every consumer
 * needing an explicit import — same pattern as `QueueModule` (see its own
 * docstring for the precedent).
 *
 * Deliberately does NOT register `MetricsController` (the `GET /metrics`
 * HTTP route) here: the worker process (`worker.ts`) is a pure
 * `NestFactory.createApplicationContext` with no HTTP adapter — a
 * `@Controller()` registered into a context with no HTTP server never binds
 * a route, so putting it in this shared module would be silently dead code
 * on the worker side. `AppModule` registers `MetricsController` directly in
 * its own `controllers` array instead; the worker exposes its own metrics
 * via a minimal standalone `http.createServer` listener in `worker.ts`,
 * reusing this same `MetricsService`.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
