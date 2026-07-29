import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { Public } from '../modules/auth/decorators/public.decorator';
import { QueueService } from '../queue/queue.service';
import { withTimeout } from '../common/utils/with-timeout.util';

/** Bounds how long an orchestrator probe waits on a dependency (Phase 0 — see
 *  docs/CACHING_QUEUES_AUDIT.md §0.5 / original audit M6). Public, unauthenticated
 *  route: it must answer fast and cheaply even during a real outage. */
const READINESS_TIMEOUT_MS = 1500;

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

  /**
   * DB + Redis reachability ONLY — deliberately does NOT return per-queue job
   * counts (that used to run `getJobCounts` across every queue on every
   * unauthenticated probe: an amplification lever AND a backlog-depth
   * disclosure to anyone). Queue depth is available, super-admin-guarded, from
   * `PlatformMonitoringController`. Each dependency check is capped at
   * `READINESS_TIMEOUT_MS` so a Redis outage answers "degraded" fast instead of
   * hanging the probe (and, transitively, an orchestrator's restart decision).
   */
  @ApiOperation({ summary: 'Readiness probe (DB + Redis reachable)' })
  @ApiOkResponse({ description: 'DB and Redis reachable.' })
  @Public()
  @Get('readiness')
  async readiness() {
    const [db, redis] = await Promise.allSettled([
      withTimeout(this.pingDb(), READINESS_TIMEOUT_MS, 'DB readiness check'),
      withTimeout(this.queues.redisPing(), READINESS_TIMEOUT_MS, 'Redis readiness check'),
    ]);

    if (db.status === 'rejected' || redis.status === 'rejected') {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: db.status === 'fulfilled' ? { status: 'up' } : { status: 'down', error: db.reason?.message },
        redis: redis.status === 'fulfilled' ? { status: 'up', latencyMs: redis.value } : { status: 'down', error: redis.reason?.message },
      });
    }

    return {
      status: 'ok',
      database: { status: 'up' },
      redis: { status: 'up', latencyMs: redis.value },
    };
  }

  private async pingDb(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }
}
