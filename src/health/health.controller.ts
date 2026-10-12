import {
  Controller,
  Get,
  Inject,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { Public } from '../modules/auth/decorators/public.decorator';
import { QueueService } from '../queue/queue.service';
import { withTimeout } from '../common/utils/with-timeout.util';
import { SchemaGuardRegistry } from '../config/schema-guard.registry';
import { getAppRevision } from '../common/utils/app-revision.util';

/**
 * The subset of `pg.Client` the readiness probe actually uses — an
 * interface, not the real class, so a test can supply a fully-controllable
 * fake without mocking the `pg` module. `HealthModule` provides the real
 * factory (`() => new Client(...)`); tests provide their own.
 */
export interface ReadinessDbClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type ReadinessDbClientFactory = () => ReadinessDbClient;

/** Nest injection token for {@link ReadinessDbClientFactory} — a factory
 *  function, not a value, because a NEW client must be constructible on
 *  every reconnect, not just once at DI-resolution time. */
export const READINESS_DB_CLIENT_FACTORY = Symbol(
  'READINESS_DB_CLIENT_FACTORY',
);

/** Generic, leak-free stand-in for a dependency's own error message on this
 *  `@Public()` route. P0.4 P04-003 measured what the raw driver message can
 *  contain against `pg` directly (host, port, username, database name); this
 *  removes that regardless of what any exception filter does downstream —
 *  see `health-readiness.e2e-spec.ts`, which settles what the filter itself
 *  does. The real cause is still logged via each dependency's own error
 *  path — this route's audience is an anonymous orchestrator probe, not an
 *  operator. */
const UNREACHABLE = 'unreachable';

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
export class HealthController implements OnModuleDestroy {
  private readonly logger = new Logger('HealthController');

  /**
   * P1.4 (MS-009) — a DEDICATED single connection for the readiness DB ping,
   * never the shared application pool. MS-009 measured what happens
   * otherwise: under saturation `this.dataSource.query('SELECT 1')` queues
   * BEHIND the exact request traffic that exhausted the pool, so the probe
   * times out and reports "database down" while the database itself is
   * completely healthy — an orchestrator then pulls a working instance out
   * of rotation (or kills it, if wired to liveness), which sends its traffic
   * to siblings under the same load, which fail the same way. This client
   * answers "is Postgres itself reachable", not "is a pool slot free" — a
   * different, more useful question for this specific probe.
   *
   * Lazily connected on first use, then REUSED across every subsequent
   * probe (an idle `pg.Client` costs nothing on either side) — reconnecting
   * per-request would reintroduce a connection-setup cost on the exact path
   * meant to be cheap. `pg.Client` requires an `'error'` listener on a
   * dropped connection or Node treats it as an unhandled error and can
   * crash the process — handled below by discarding the client so the next
   * probe reconnects.
   */
  private readinessClient: ReadinessDbClient | null = null;
  private readinessClientConnecting: Promise<ReadinessDbClient> | null = null;

  constructor(
    private readonly queues: QueueService,
    private readonly dataSource: DataSource,
    private readonly schemaGuards: SchemaGuardRegistry,
    private readonly config: ConfigService,
    @Inject(READINESS_DB_CLIENT_FACTORY)
    private readonly createReadinessClient: ReadinessDbClientFactory,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const client = this.readinessClient;
    this.readinessClient = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // Shutting down anyway — nothing left to do with this error.
      }
    }
  }

  @ApiOperation({ summary: 'Liveness probe (process is up)' })
  @ApiOkResponse({ description: 'Process is alive.' })
  @Public()
  @Get('liveness')
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString(), revision: getAppRevision() };
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
   *
   * ── P1.4 (MS-009): saturated-but-working is not the same as down ─────────
   *
   * The DB check above (`pingDb`) uses the DEDICATED connection, not the
   * pool, so it answers "is Postgres reachable" correctly even while the
   * pool itself is exhausted. That pool state is then reported SEPARATELY,
   * read directly off the live `pg-pool` instance (the same counters P1.3's
   * `DbPoolMetricsService` samples on its own interval — read fresh here
   * rather than reused, since a stale cached value is worse than a cheap
   * synchronous property read):
   *
   *  - `waiting === 0`: pool has spare capacity or is merely busy, not
   *    saturated. `status` stays `"ok"` (or `"degraded"` if a schema guard
   *    is also missing — that takes priority, being the more persistent
   *    problem).
   *  - `waiting > 0`: at least one caller is queued for a connection RIGHT
   *    NOW. `status` becomes `"busy"` — still HTTP 200, still in rotation.
   *    A saturated-but-working instance pulled from rotation only moves its
   *    load onto siblings under the same pressure, which is exactly the
   *    amplification MS-009 documented; load here is meant to be shed by
   *    the request path's own timeouts, not by readiness evicting healthy
   *    capacity.
   */
  @ApiOperation({
    summary:
      'Readiness probe (DB reachable via a dedicated connection, Redis reachable, schema guards installed, pool not saturated)',
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
            : { status: 'down', error: UNREACHABLE },
        redis:
          redis.status === 'fulfilled'
            ? { status: 'up', latencyMs: redis.value }
            : { status: 'down', error: UNREACHABLE },
        schemaGuards: schema,
      });
    }

    const poolWaiting = this.poolWaitingCount();
    const status: 'ok' | 'degraded' | 'busy' =
      schema.status !== 'ok' ? 'degraded' : poolWaiting > 0 ? 'busy' : 'ok';

    const body = {
      status,
      database: {
        status: 'up' as const,
        ...(poolWaiting > 0 ? { poolWaiting } : {}),
      },
      redis: { status: 'up', latencyMs: redis.value },
      schemaGuards: schema,
    };

    if (
      schema.status !== 'ok' &&
      this.config.get<string>('SCHEMA_GUARD_FAIL_READINESS') === 'true'
    ) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  /** Reads `waitingCount` straight off the live `pg-pool` instance behind
   *  the shared application pool — the same counter P1.3's
   *  `DbPoolMetricsService` samples, read fresh here rather than shared,
   *  since a synchronous property read costs nothing and a per-sampler-tick
   *  cached value could be stale by up to `DB_POOL_METRICS_POLL_MS`. Never
   *  throws: an unexpected driver shape reports 0 (no pool-saturation
   *  signal) rather than failing the whole readiness check over a metric. */
  private poolWaitingCount(): number {
    try {
      const pool = (this.dataSource.driver as { master?: unknown }).master as
        | { waitingCount?: number }
        | undefined;
      return pool?.waitingCount ?? 0;
    } catch {
      return 0;
    }
  }

  private async pingDb(): Promise<void> {
    const client = await this.getReadinessClient();
    try {
      await client.query('SELECT 1');
    } catch (err) {
      // The connection this client held is presumed bad — discard it so the
      // NEXT probe reconnects from scratch rather than repeatedly querying a
      // dead socket. Genuinely transient errors just cost one reconnect.
      await this.discardReadinessClient();
      throw err;
    }
  }

  /** Returns the existing connected client, or connects a new one. Two
   *  concurrent readiness probes (a real possibility — nothing serializes
   *  requests to this route) share ONE in-flight connect attempt rather
   *  than each opening its own. */
  private async getReadinessClient(): Promise<ReadinessDbClient> {
    if (this.readinessClient) return this.readinessClient;
    if (this.readinessClientConnecting) return this.readinessClientConnecting;

    this.readinessClientConnecting = (async () => {
      const client = this.createReadinessClient();
      // Required — an unhandled 'error' on a raw pg.Client crashes the
      // process (Node's default behaviour for an EventEmitter 'error' with
      // no listener). A dropped connection is exactly what this client
      // exists to detect and recover from on the NEXT probe, not a reason
      // to take the whole process down.
      client.on('error', (err) => {
        this.logger.warn(
          `Readiness DB connection dropped: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (this.readinessClient === client) this.readinessClient = null;
      });
      await client.connect();
      this.readinessClient = client;
      return client;
    })();

    try {
      return await this.readinessClientConnecting;
    } finally {
      this.readinessClientConnecting = null;
    }
  }

  private async discardReadinessClient(): Promise<void> {
    const client = this.readinessClient;
    this.readinessClient = null;
    if (client) {
      try {
        await client.end();
      } catch {
        // Already broken — nothing more to do.
      }
    }
  }
}
