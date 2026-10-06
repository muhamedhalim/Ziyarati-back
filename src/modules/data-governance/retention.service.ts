import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  DeletionEvidence,
  type DeletionStoreResult,
} from '../../entities/Governance/DeletionEvidence';
import {
  resolveRetentionPolicy,
  type RetentionTarget,
} from './retention-policy';

/** Rows touched per statement — bounds lock time and WAL per transaction. */
export const RETENTION_BATCH_SIZE = 5_000;
/** Safety cap per target per run, so a misconfiguration cannot spin forever. */
export const RETENTION_MAX_BATCHES = 1_000;

/**
 * Evidence for a retention run belongs to no single clinic; the platform-wide
 * sweep is recorded under the nil UUID so the column can stay NOT NULL.
 */
export const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface RetentionTargetResult {
  id: string;
  table: string;
  action: string;
  /** `null` when the target is inert (its setting is unset). */
  days: number | null;
  cutoff?: string;
  /** Rows deleted / scrubbed — or, in a dry run, rows that WOULD be. */
  affected: number;
  skipped?: 'no_setting';
}

export interface RetentionRunResult {
  dryRun: boolean;
  evidenceId?: string;
  targets: RetentionTargetResult[];
}

/**
 * Applies the retention policy (residency plan P12).
 *
 * Inert by default: with no `RETENTION_*_DAYS` setting nothing is selected, and
 * a real (non-dry) run with nothing configured writes nothing. A dry run counts
 * exactly what a real run would remove. A real run works in bounded batches and
 * leaves a `RETENTION` deletion-evidence row.
 *
 * It is invoked on demand (`npm run retention:run`), not on a timer: with no
 * policy values decided there is nothing to schedule, and scheduling should be
 * added together with the first approved value.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  private where(target: RetentionTarget): string {
    const parts = [`"${target.timestampColumn}" < $1`];
    if (target.eligible) parts.push(`(${target.eligible})`);
    return parts.join(' AND ');
  }

  private async count(target: RetentionTarget, cutoff: Date): Promise<number> {
    const rows: Array<{ n: number }> = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM "${target.table}" WHERE ${this.where(target)}`,
      [cutoff],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async apply(target: RetentionTarget, cutoff: Date): Promise<number> {
    // `ctid` rather than `id`: every target table is covered, whatever its key.
    const victims = `SELECT ctid FROM "${target.table}" WHERE ${this.where(target)} LIMIT ${RETENTION_BATCH_SIZE}`;
    const text =
      target.action === 'delete'
        ? `DELETE FROM "${target.table}" WHERE ctid IN (${victims})`
        : `UPDATE "${target.table}" SET ${target.set} WHERE ctid IN (${victims})`;

    // A query runner, because only it can report how many rows a statement touched.
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      let total = 0;
      for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
        const result = (await qr.query(text, [cutoff], true)) as {
          affected?: number;
        };
        const affected = result.affected ?? 0;
        total += affected;
        if (affected < RETENTION_BATCH_SIZE) break;
      }
      return total;
    } finally {
      await qr.release();
    }
  }

  async run(options: {
    dryRun: boolean;
    now?: Date;
    performedByUserId?: string;
  }): Promise<RetentionRunResult> {
    const now = options.now ?? new Date();
    const startedAt = new Date();
    const policy = resolveRetentionPolicy((k) =>
      this.config.get<string | number>(k),
    );
    const targets: RetentionTargetResult[] = [];

    for (const { target, days } of policy) {
      const base = {
        id: target.id,
        table: target.table,
        action: target.action,
        days,
      };
      if (days === null) {
        targets.push({ ...base, affected: 0, skipped: 'no_setting' });
        continue;
      }
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      const affected = options.dryRun
        ? await this.count(target, cutoff)
        : await this.apply(target, cutoff);
      targets.push({ ...base, cutoff: cutoff.toISOString(), affected });
      this.logger.log(
        `${options.dryRun ? 'would ' : ''}${target.action} ${affected} ${target.table} row(s) older than ${days}d`,
      );
    }

    if (options.dryRun || targets.every((t) => t.affected === 0))
      return { dryRun: options.dryRun, targets };

    const stores: DeletionStoreResult[] = targets
      .filter((t) => t.skipped === undefined)
      .map((t) => ({
        store: 'database',
        target: t.table,
        action: t.action === 'delete' ? 'deleted' : 'scrubbed',
        affected: t.affected,
        reason: `retention ${t.days} days (cutoff ${t.cutoff})`,
      }));
    const repo = this.dataSource.getRepository(DeletionEvidence);
    const evidence = await repo.save(
      repo.create({
        scope: 'RETENTION',
        tenant_id: PLATFORM_TENANT_ID,
        subject_id: null,
        request_id: null,
        performed_by_user_id: options.performedByUserId ?? null,
        status: 'COMPLETED',
        report: { stores, options: { dryRun: false } },
        started_at: startedAt,
        completed_at: new Date(),
      }),
    );
    return { dryRun: false, evidenceId: evidence.id, targets };
  }
}
