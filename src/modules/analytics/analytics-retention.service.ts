import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AnalyticsEvent } from '../../entities/Analytics/AnalyticsEvent';

/**
 * Retention / cleanup for the raw event log (`analytics_events`).
 *
 * The event table is append-only and unbounded — without a retention policy it
 * grows forever, degrading every tenant-scoped query and inflating storage. This
 * service purges events older than `ANALYTICS_EVENT_RETENTION_DAYS` (default 90)
 * in BOUNDED batches, so the cleanup never takes a long lock or a multi-million
 * row transaction. It runs as a scheduled platform sweep (see the worker's
 * ScheduleRegistrar / AnalyticsProcessor), backed by `idx_analytics_events_created`.
 */
@Injectable()
export class AnalyticsRetentionService {
  private readonly logger = new Logger('AnalyticsRetentionService');
  private readonly retentionDays: number;
  /** Rows deleted per statement — bounds lock duration / WAL per transaction. */
  private readonly batchSize = 5_000;
  /** Safety cap on batches per run, so a misconfiguration can't spin forever. */
  private readonly maxBatches = 1_000;

  constructor(
    @InjectRepository(AnalyticsEvent)
    private readonly events: Repository<AnalyticsEvent>,
    config: ConfigService,
  ) {
    this.retentionDays = Number(config.get('ANALYTICS_EVENT_RETENTION_DAYS', 90)) || 90;
  }

  async purgeExpiredEvents(): Promise<{ deleted: number; cutoff: string }> {
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000);
    let deleted = 0;

    for (let batch = 0; batch < this.maxBatches; batch += 1) {
      const result = await this.events
        .createQueryBuilder()
        .delete()
        .from(AnalyticsEvent)
        .where(
          'id IN (SELECT id FROM analytics_events WHERE created_at < :cutoff LIMIT :lim)',
          { cutoff, lim: this.batchSize },
        )
        .execute();

      const affected = result.affected ?? 0;
      deleted += affected;
      if (affected < this.batchSize) break;
    }

    this.logger.log(
      `purged ${deleted} analytics_events older than ${cutoff.toISOString()} (retention ${this.retentionDays}d)`,
    );
    return { deleted, cutoff: cutoff.toISOString() };
  }
}
