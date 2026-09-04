import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { Public } from '../modules/auth/decorators/public.decorator';
import { QueueService } from '../queue/queue.service';
import { withTimeout } from '../common/utils/with-timeout.util';
import { SchemaGuardRegistry } from '../config/schema-guard.registry';

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
    private readonly schemaGuards: SchemaGuardRegistry,
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
   *
   * ── P0.3 SCHEMA-004 / RULE 5: schema-integrity guards ─────────────────────
   *
   * Also reports whether every REQUIRED DB-enforced integrity guard was
   * installed at boot (`SchemaGuardRegistry`). Three deliberate choices:
   *
   *  1. **Counts only, never names.** This route is `@Public()`. Telling an
   *     anonymous caller that `uq_refund_idem` is missing tells them exactly
   *     which duplicate to attempt. The object names, tables and PostgreSQL
   *     messages go to the application log — operator access only.
   *  2. **`status` becomes `"degraded"`, not `"ok"`.** RULE 5: readiness must
   *     not claim the instance is fully ready when an integrity guard the
   *     application depends on is absent.
   *  3. **Still HTTP 200 by default.** A missing index is not a reason to pull
   *     every instance out of rotation — that converts a data-integrity
   *     problem into a total outage, and the Docker HEALTHCHECK deliberately
   *     probes liveness rather than this route, so nothing restarts either
   *     way. An operator whose orchestrator routes on readiness and who wants
   *     fail-closed traffic behaviour sets `SCHEMA_GUARD_FAIL_READINESS=true`
   *     and gets 503 instead.
   */
  @ApiOperation({
    summary: 'Readiness probe (DB + Redis reachable, schema guards installed)',
  })
  @ApiOkResponse({ description: 'DB and Redis reachable.' })
  @Public()
  @Get('readiness')
  async readiness() {
    const [db, redis] = await Promise.allSettled([
      withTimeout(this.pingDb(), READINESS_TIMEOUT_MS, 'DB readiness check'),
      withTimeout(
        this.queues.redisPing(),
        READINESS_TIMEOUT_MS,
        'Redis readiness check',
      ),
    ]);
    const schema = this.schemaGuards.summary();

    if (db.status === 'rejected' || redis.status === 'rejected') {
      throw new ServiceUnavailableException({
        status: 'degraded',
        database:
          db.status === 'fulfilled'
            ? { status: 'up' }
            : { status: 'down', error: db.reason?.message },
        redis:
          redis.status === 'fulfilled'
            ? { status: 'up', latencyMs: redis.value }
            : { status: 'down', error: redis.reason?.message },
        schemaGuards: schema,
      });
    }

    const body = {
      status: schema.status === 'ok' ? 'ok' : 'degraded',
      database: { status: 'up' },
      redis: { status: 'up', latencyMs: redis.value },
      schemaGuards: schema,
    };

    if (
      schema.status !== 'ok' &&
      process.env.SCHEMA_GUARD_FAIL_READINESS === 'true'
    ) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  private async pingDb(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }
}
