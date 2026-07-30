import { Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller';
import { MetricsAuthGuard } from './metrics-auth.guard';

/**
 * The `GET /metrics` HTTP route (M14) — separated from `MetricsModule` (the
 * global, service-only module both process roots import) because a
 * `@Controller()` only makes sense where there is an HTTP adapter to bind
 * it to. Imported ONLY by `AppModule` — mirrors `HealthModule`'s own
 * API-only placement for the same reason.
 */
@Module({
  controllers: [MetricsController],
  providers: [MetricsAuthGuard],
})
export class MetricsHttpModule {}
