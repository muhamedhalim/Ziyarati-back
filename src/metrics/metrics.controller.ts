import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../modules/auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';
import { MetricsAuthGuard } from './metrics-auth.guard';

/**
 * `GET /metrics` — Prometheus scrape endpoint (M14). `@Public()` skips the
 * global `JwtAuthGuard` (a scraper has no tenant JWT); `MetricsAuthGuard`
 * enforces the static bearer token instead. Excluded from the Swagger docs —
 * this is an infra endpoint, not a product API surface.
 */
@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @UseGuards(MetricsAuthGuard)
  @Get('metrics')
  async getMetrics(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(await this.metrics.render());
  }
}
