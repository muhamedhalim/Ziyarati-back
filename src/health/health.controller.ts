import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../modules/auth/decorators/public.decorator';
import { QueueService } from '../queue/queue.service';

/**
 * Infra health for orchestrators (Railway / load balancers / probes). Mounted at
 * `system/health` to avoid the raw `/api/v1/health` liveness route in main.ts.
 * Public — probes are unauthenticated.
 */
@ApiTags('System Health')
@Controller('system/health')
export class HealthController {
  constructor(private readonly queues: QueueService) {}

  @ApiOperation({ summary: 'Liveness probe (process is up)' })
  @ApiOkResponse({ description: 'Process is alive.' })
  @Public()
  @Get('liveness')
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @ApiOperation({ summary: 'Readiness probe (Redis + queues reachable)' })
  @ApiOkResponse({ description: 'Redis reachable; per-queue job counts returned.' })
  @Public()
  @Get('readiness')
  async readiness() {
    try {
      const latencyMs = await this.queues.redisPing();
      const queues = await this.queues.queueCounts();
      return { status: 'ok', redis: { status: 'up', latencyMs }, queues };
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        redis: { status: 'down', error: (err as Error)?.message },
      });
    }
  }
}
