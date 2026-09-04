import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MetricsService } from './metrics.service';

/**
 * P1.3 — periodic DB connection-pool observability, one gauge sample per
 * poll interval, in whichever process root has a pool (registered in
 * `MetricsModule`, `@Global()`, so both API and worker pick it up without
 * either needing its own wiring — same pattern `QueueMonitorService` uses
 * for queue depth, except that one is worker-only by design; this one runs
 * in both because both roots have their own separate pool).
 *
 * WHY THIS EXISTS: the load-test campaign's own finding (MS-002/P0 booking
 * remediation) was that `pg_stat_activity` — the obvious place to look —
 * CANNOT see pool exhaustion: it shows every checked-out connection as
 * "idle in transaction" or "active", never "waiting for one to free up",
 * because the wait happens entirely inside the Node process, before a
 * connection (and therefore a Postgres backend) is even acquired. `pg-pool`
 * itself is the only place that number exists — `waitingCount`.
 *
 * DELIBERATELY DOES NOT CHANGE ANY POOL SIZE, TIMEOUT OR BEHAVIOUR. Pure
 * observability — three gauge samples per interval, nothing else. The pool
 * itself is sized by `typeorm.config.ts`'s existing `extra.max`/`min`/
 * `connectionTimeoutMillis`, untouched here.
 *
 * WHY A RATE-LIMITED WARN, NOT ONE PER SAMPLE: a single sample catching
 * `waiting > 0` for a fleeting moment (a legitimate brief burst) is normal
 * and would spam the log every `pollMs` if logged unconditionally. Warns
 * only when `waiting > 0` on `WARN_AFTER_CONSECUTIVE` consecutive samples —
 * sustained queueing, not a blip — and then at most once per
 * `WARN_COOLDOWN_MS` while it stays sustained, so a genuinely saturated
 * pool still gets ONE fresh reminder per window rather than one line every
 * `pollMs` forever.
 */
@Injectable()
export class DbPoolMetricsService implements OnModuleInit, OnModuleDestroy {
  private static readonly WARN_AFTER_CONSECUTIVE = 3;
  private static readonly WARN_COOLDOWN_MS = 5 * 60_000;

  private readonly logger = new Logger('DbPoolMetrics');
  private timer?: NodeJS.Timeout;
  private consecutiveWaiting = 0;
  private lastWarnAt = 0;

  private readonly pollMs: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.pollMs = Number(config.get<number>('DB_POOL_METRICS_POLL_MS', 15000));
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.sample(), this.pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Never throws — a sampling failure must not be able to affect anything
   *  else on this timer, and there is nothing useful to do with the error
   *  beyond logging it (the pool itself is what would be broken, and the
   *  actual application traffic will surface that far more directly). */
  private sample(): void {
    try {
      // `driver.master` is the underlying `pg-pool` instance — TypeORM
      // types it as `any` (it owns no stronger type for the driver-specific
      // pool object), so this reaches for the three documented `pg-pool`
      // getters directly rather than assuming a TypeORM-level API for them
      // (there isn't one).
      const pool = (this.dataSource.driver as { master?: unknown }).master as
        | {
            totalCount?: number;
            idleCount?: number;
            waitingCount?: number;
          }
        | undefined;
      if (!pool) return; // not a postgres driver, or not yet initialized

      const total = pool.totalCount ?? 0;
      const idle = pool.idleCount ?? 0;
      const waiting = pool.waitingCount ?? 0;

      this.metrics.setDbPoolStats({ total, idle, waiting });

      if (waiting > 0) {
        this.consecutiveWaiting += 1;
      } else {
        this.consecutiveWaiting = 0;
      }

      const sustained =
        this.consecutiveWaiting >= DbPoolMetricsService.WARN_AFTER_CONSECUTIVE;
      const cooldownElapsed =
        Date.now() - this.lastWarnAt >= DbPoolMetricsService.WARN_COOLDOWN_MS;
      if (sustained && cooldownElapsed) {
        this.logger.warn(
          `DB pool saturated: ${waiting} caller(s) waiting for a connection, ` +
            `sustained across ${this.consecutiveWaiting} consecutive samples ` +
            `(total=${total}, idle=${idle}). pg_stat_activity cannot see this — ` +
            `the wait happens before a Postgres backend is even acquired.`,
        );
        this.lastWarnAt = Date.now();
      }
    } catch (err) {
      this.logger.warn(
        `DB pool metrics sample failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
