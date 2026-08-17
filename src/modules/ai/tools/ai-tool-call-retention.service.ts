import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/**
 * Retention / cleanup for `ai_tool_calls`' ATTEMPT-ONLY rows — denials,
 * refusals, and the 7 session-state public-booking tool records (R3's
 * `attempt:<tool>:<uuid>` key namespace is the discriminator). Mirrors
 * `AnalyticsRetentionService`: purges rows older than
 * `AI_TOOL_CALL_RETENTION_DAYS` (default 90) in BOUNDED batches, so cleanup
 * never takes a long lock or a single large transaction.
 *
 * `ai_tool_calls` is a raw table (no TypeORM entity, per this codebase's
 * convention for non-entity tables) — raw SQL via `DataSource`, matching
 * `AiToolDispatchService`'s own access pattern for the same table.
 *
 * FR-029a: records of EXECUTED business actions (a real claim key,
 * participating in `uq_ai_tool_call_idem`) are NEVER purged by this
 * mechanism — their lifetime is unchanged and unbounded. The filter below
 * selects only the non-claiming `attempt:` namespace.
 *
 * FR-029d: the filter also excludes `PENDING`/`EXECUTING` explicitly. No
 * `attempt:`-keyed row is ever created in those states today (every
 * `recordAttempt`/`recordSessionAttempt` write is a single INSERT with an
 * already-terminal status) — this is a belt-and-suspenders guard against a
 * future change, not a condition this filter currently needs to exclude
 * anything for.
 */
@Injectable()
export class AiToolCallRetentionService {
  private readonly logger = new Logger('AiToolCallRetentionService');
  private readonly retentionDays: number;
  /** Rows deleted per statement — bounds lock duration / WAL per transaction. Same as AnalyticsRetentionService. */
  private readonly batchSize = 5_000;
  /** Safety cap on batches per run, so a misconfiguration can't spin forever. */
  private readonly maxBatches = 1_000;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.retentionDays =
      Number(config.get('AI_TOOL_CALL_RETENTION_DAYS', 90)) || 90;
  }

  async purgeExpiredAttempts(): Promise<{ deleted: number; cutoff: string }> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    let deleted = 0;

    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      // RETURNING id — a deterministic row-count via the returned array's
      // length, rather than relying on the driver's affected-row reporting
      // shape for a bare DELETE (inconsistent across TypeORM driver paths).
      const deletedRows: { id: string }[] = await this.dataSource.query(
        `WITH victims AS (
           SELECT id FROM ai_tool_calls
            WHERE created_at < $1
              AND idempotency_key LIKE 'attempt:%'
              AND status NOT IN ('PENDING', 'EXECUTING')
            LIMIT $2
         )
         DELETE FROM ai_tool_calls WHERE id IN (SELECT id FROM victims) RETURNING id`,
        [cutoff, this.batchSize],
      );
      const affected = deletedRows.length;
      deleted += affected;
      if (affected < this.batchSize) break;
    }

    this.logger.log(
      `purged ${deleted} attempt-only ai_tool_calls rows older than ${cutoff.toISOString()} (retention ${this.retentionDays}d)`,
    );
    return { deleted, cutoff: cutoff.toISOString() };
  }
}
