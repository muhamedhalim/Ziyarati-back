import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { JobsOptions } from 'bullmq';
import { DataSource } from 'typeorm';

import { OutboxJob } from '../entities/Campaigns/OutboxJob';
import { OutboxStatus } from '../entities/enums';
import { QueueService } from '../queue/queue.service';
import { QueueName } from '../queue/queue.constants';

/**
 * Delay before a failed publish is retried: 1 s, 2 s, 4 s ... capped at 5 min. `attempts` is the count
 * AFTER the failure being scheduled (so the first failure waits 1 s).
 *
 * CR-09: retries used to be re-claimed on the very next 1 s tick, so the whole attempt budget was
 * spent in ~10 s - shorter than a Valkey failover - and rows were then parked FAILED with only a
 * log line. With this backoff and the larger default budget a row keeps retrying for about an
 * hour before it is parked, and a parked row is visible (monitoring) and re-drivable.
 */
export function outboxBackoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1) - 1, 10);
  return Math.min(1000 * 2 ** exp, 5 * 60_000);
}

/**
 * Transactional-outbox RELAY (worker-only).
 *
 * Polls PENDING `outbox_jobs` rows and publishes each to BullMQ via
 * QueueService, using the row's `dedupe_key` as the jobId so the at-least-once
 * publish is idempotent. On success the row is marked PUBLISHED; on repeated
 * failure it is parked as FAILED for inspection.
 *
 * THREE-PHASE PUBLISH (Phase 0 fix — see docs/CACHING_QUEUES_AUDIT.md §0.5
 * item 5 / original audit H10). The PREVIOUS version ran the Redis publish
 * itself INSIDE the same DB transaction that held the `FOR UPDATE SKIP
 * LOCKED` claim on up to `batchSize` rows — meaning a Redis slowdown (or,
 * before Phase 0's C2 fix, an outage with no command timeout) held those row
 * locks and one of the connection pool's few slots open for the entire
 * duration of every sequential publish in the batch. This version instead:
 *
 *   1. CLAIM (short tx): atomically flips a batch PENDING → PUBLISHING and
 *      commits immediately — no external I/O happens while any row lock is held.
 *   2. PUBLISH (no transaction): the Redis calls run with no DB lock held at all.
 *   3. MARK (short tx per row): PUBLISHED, or reverted to PENDING for a retry,
 *      or FAILED once `maxAttempts` is exhausted.
 *
 * RECOVERY: a relay that crashes between phase 1 and phase 3 leaves a row
 * stuck PUBLISHING forever otherwise. `recoverStuckPublishing` (its own,
 * slower-cadence sweep) resets any row PUBLISHING past `stuckAfterMs` back to
 * PENDING. The deterministic `dedupe_key` jobId makes a duplicate publish
 * attempt (row recovered after actually having been published) safe either way.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private running = false;
  private recovering = false;
  private stopped = false;
  private pausedSince?: number;
  private lastPauseLogAt?: number;

  private readonly intervalMs = Number(process.env.OUTBOX_POLL_MS ?? '1000');
  private readonly batchSize = Number(process.env.OUTBOX_BATCH ?? '100');
  private readonly maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? '20');
  /** How often the stuck-PUBLISHING recovery sweep runs — deliberately slower than the main poll (that loop is cheap; this one is a safety net, not the hot path). */
  private readonly recoveryPollMs = Number(process.env.OUTBOX_RECOVERY_POLL_MS ?? '30000');
  /** A claim (phase 1 -> phase 3) normally completes in well under a second; this long in PUBLISHING means the relay that claimed it is gone. */
  private readonly stuckAfterMs = Number(process.env.OUTBOX_PUBLISHING_STUCK_MS ?? '60000');

  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: QueueService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.recoveryTimer = setInterval(() => void this.runRecovery(), this.recoveryPollMs);
    this.logger.log(
      `Outbox relay started (every ${this.intervalMs}ms, batch ${this.batchSize}; ` +
        `stuck-PUBLISHING recovery every ${this.recoveryPollMs}ms, threshold ${this.stuckAfterMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      // RL-08: while Redis is near maxmemory, leave rows PENDING in Postgres
      // rather than pushing Redis into noeviction write failures. Nothing is
      // claimed, so the next tick with headroom simply picks them up.
      if (!(await this.queue.hasEnqueueHeadroom())) {
        this.logPaused();
        return;
      }
      this.pausedSince = undefined;
      await this.drainBatch();
    } catch (err) {
      this.logger.error(`relay tick error: ${(err as Error)?.message}`);
    } finally {
      this.running = false;
    }
  }

  /** One warning when a pause starts, then at most one a minute while it lasts. */
  private logPaused(): void {
    const now = Date.now();
    if (this.pausedSince === undefined) this.pausedSince = now;
    if (this.lastPauseLogAt !== undefined && now - this.lastPauseLogAt < 60_000)
      return;
    this.lastPauseLogAt = now;
    this.logger.warn(
      `Outbox relay paused: Redis memory is above the enqueue threshold ` +
        `(paused for ${Math.round((now - this.pausedSince) / 1000)}s)`,
    );
  }

  private async drainBatch(): Promise<void> {
    const claimed = await this.claimBatch();
    for (const row of claimed) {
      await this.publishAndMark(row);
    }
  }

  /** Phase 1 — short transaction: atomically claim a batch (PENDING → PUBLISHING). */
  private async claimBatch(): Promise<OutboxJob[]> {
    return this.dataSource.transaction(async (mgr) => {
      const rows = await mgr
        .createQueryBuilder(OutboxJob, 'o')
        .where('o.status = :s', { s: OutboxStatus.PENDING })
        // A row that failed to publish waits out its backoff (NULL = never failed = due now).
        .andWhere('(o.next_attempt_at IS NULL OR o.next_attempt_at <= now())')
        .orderBy('o.created_at', 'ASC')
        .limit(this.batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked') // FOR UPDATE SKIP LOCKED — safe across replicas
        .getMany();
      if (rows.length === 0) return [];

      const claimedAt = new Date();
      await mgr
        .createQueryBuilder()
        .update(OutboxJob)
        .set({ status: OutboxStatus.PUBLISHING, claimed_at: claimedAt })
        .where('id IN (:...ids)', { ids: rows.map((r) => r.id) })
        .execute();

      return rows;
    });
  }

  /** Phases 2-3 — publish with NO transaction open, then a short transaction to mark the outcome. */
  private async publishAndMark(row: OutboxJob): Promise<void> {
    try {
      await this.queue.publish(
        row.queue as QueueName,
        row.job_name,
        { ...(row.payload as Record<string, unknown>), tenantId: (row.payload as { tenantId?: string }).tenantId ?? null },
        row.dedupe_key,
        (row.opts as JobsOptions | undefined) ?? undefined,
      );
      await this.dataSource
        .createQueryBuilder()
        .update(OutboxJob)
        .set({ status: OutboxStatus.PUBLISHED, published_at: new Date(), last_error: undefined, next_attempt_at: null })
        .where('id = :id', { id: row.id })
        .execute();
    } catch (err) {
      const attempts = row.publish_attempts + 1;
      const message = (err as Error)?.message ?? 'publish error';
      const exhausted = attempts >= this.maxAttempts;
      if (exhausted) {
        // OUTBOX_ROW_FAILED is a stable token for log-based alarms; the row stays visible in
        // platform monitoring and can be re-driven from there.
        this.logger.error(`OUTBOX_ROW_FAILED row ${row.id} queue=${row.queue} job=${row.job_name} attempts=${attempts}: ${message}`);
      }
      await this.dataSource
        .createQueryBuilder()
        .update(OutboxJob)
        // Not yet exhausted -> back to PENDING so the NEXT poll retries it
        // (this row is currently PUBLISHING, not PENDING, so it would
        // otherwise never be picked up again).
        .set({
          status: exhausted ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          publish_attempts: attempts,
          last_error: message,
          next_attempt_at: exhausted
            ? null
            : new Date(Date.now() + outboxBackoffMs(attempts)),
        })
        .where('id = :id', { id: row.id })
        .execute();
    }
  }

  /**
   * Parked (FAILED) rows are work that was promised and never delivered - payment outcomes,
   * reminders, webhooks. Say so on every recovery sweep, with a stable token, for as long as any
   * remain (CR-09). Never throws: it must not take the recovery sweep down with it.
   */
  private async reportFailedRows(): Promise<void> {
    try {
      const [row] = (await this.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM outbox_jobs WHERE status = $1`,
        [OutboxStatus.FAILED],
      )) as { c: number }[];
      const failed = Number(row?.c ?? 0);
      if (failed > 0) {
        this.logger.error(
          `OUTBOX_FAILED_ROWS count=${failed} - parked after exhausting retries; re-drive from Platform monitoring once the cause is fixed`,
        );
      }
    } catch (err) {
      this.logger.warn(`failed-row report error: ${(err as Error)?.message}`);
    }
  }

  /**
   * Recovery sweep: a row left PUBLISHING past `stuckAfterMs` means the relay
   * that claimed it crashed (or was killed) between claiming and marking the
   * outcome. Reset to PENDING so the next `tick()` retries it. Safe under
   * concurrent relays for the same reason `claimBatch` is: this update only
   * matches rows already PUBLISHING and stale, so two recovery sweeps racing
   * each other just both issue a harmless no-op UPDATE on the same rows.
   *
   * `claimed_at IS NULL` is treated as immediately stale too (gap-closure pass
   * — see docs/CACHING_QUEUES_AUDIT.md §0.8.3/§0.9): in SQL, `NULL < cutoff`
   * evaluates to NULL (not true), so without this branch a row that somehow
   * ends up PUBLISHING with no claim timestamp — a legacy writer, a manual DB
   * fix, any future code path that sets status without the timestamp — would
   * never be picked up by this sweep and would be stuck forever.
   */
  private async runRecovery(): Promise<void> {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      const cutoff = new Date(Date.now() - this.stuckAfterMs);
      const result = await this.dataSource
        .createQueryBuilder()
        .update(OutboxJob)
        .set({ status: OutboxStatus.PENDING, claimed_at: undefined })
        .where('status = :publishing AND (claimed_at IS NULL OR claimed_at < :cutoff)', {
          publishing: OutboxStatus.PUBLISHING,
          cutoff,
        })
        .execute();
      const recovered = result.affected ?? 0;
      if (recovered > 0) {
        this.logger.warn(`Recovered ${recovered} outbox row(s) stuck in PUBLISHING (relay crash recovery)`);
      }
      await this.reportFailedRows();
    } catch (err) {
      this.logger.error(`outbox recovery sweep error: ${(err as Error)?.message}`);
    } finally {
      this.recovering = false;
    }
  }
}
