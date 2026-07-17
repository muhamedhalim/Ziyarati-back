import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

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
  constructor(
    private readonly queues: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  @ApiOperation({ summary: 'Liveness probe (process is up)' })
  @ApiOkResponse({ description: 'Process is alive.' })
  @Public()
  @Get('liveness')
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @ApiOperation({ summary: 'Readiness probe (DB + Redis + queues reachable)' })
  @ApiOkResponse({ description: 'DB and Redis reachable; per-queue job counts returned.' })
  @Public()
  @Get('readiness')
  async readiness() {
    // Both checked independently — an orchestrator using this route to gate
    // traffic must see a DB outage too, not just a Redis one (this endpoint
    // previously only pinged Redis, so a dead Postgres still reported "ok").
    const [db, redis] = await Promise.allSettled([
      this.pingDb(),
      this.queues.redisPing(),
    ]);

    if (db.status === 'rejected' || redis.status === 'rejected') {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: db.status === 'fulfilled' ? { status: 'up' } : { status: 'down', error: db.reason?.message },
        redis: redis.status === 'fulfilled' ? { status: 'up', latencyMs: redis.value } : { status: 'down', error: redis.reason?.message },
      });
    }

    const queueCounts = await this.queues.queueCounts();
    return {
      status: 'ok',
      database: { status: 'up' },
      redis: { status: 'up', latencyMs: redis.value },
      queues: queueCounts,
    };
  }

  private async pingDb(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }
}
