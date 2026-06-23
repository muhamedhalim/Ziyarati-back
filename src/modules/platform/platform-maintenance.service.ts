import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ApiLog } from '../../entities/System/ApiLog';
import { WebhookLog } from '../../entities/System/WebhookLog';

/**
 * Retention for the high-volume append-only log tables. Run by a repeatable
 * worker job (platform.logCleanup) so `api_logs` / `webhook_logs` cannot grow
 * unbounded at millions/tens-of-millions of rows. Deletes in capped batches to
 * keep each pass cheap and avoid long locks.
 */
@Injectable()
export class PlatformMaintenanceService {
  private readonly logger = new Logger('PlatformMaintenance');
  private readonly apiLogDays: number;
  private readonly webhookLogDays: number;

  constructor(
    @InjectRepository(ApiLog) private readonly apiLogs: Repository<ApiLog>,
    @InjectRepository(WebhookLog) private readonly webhookLogs: Repository<WebhookLog>,
    config: ConfigService,
  ) {
    this.apiLogDays = Number(config.get<string>('PLATFORM_API_LOG_RETENTION_DAYS') ?? '30');
    this.webhookLogDays = Number(config.get<string>('PLATFORM_WEBHOOK_LOG_RETENTION_DAYS') ?? '90');
  }

  async purgeOldLogs(batch = 5000): Promise<{ apiLogs: number; webhookLogs: number }> {
    const apiPurged = await this.purge(this.apiLogs, 'api_logs', this.apiLogDays, batch);
    const webhookPurged = await this.purge(this.webhookLogs, 'webhook_logs', this.webhookLogDays, batch);
    if (apiPurged || webhookPurged) {
      this.logger.log(`retention purge: api_logs=${apiPurged} webhook_logs=${webhookPurged}`);
    }
    return { apiLogs: apiPurged, webhookLogs: webhookPurged };
  }

  private async purge(
    repo: Repository<ApiLog | WebhookLog>,
    table: string,
    days: number,
    batch: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const res = await repo
      .createQueryBuilder()
      .delete()
      .where(`id IN (SELECT id FROM ${table} WHERE created_at < :cutoff ORDER BY created_at ASC LIMIT :batch)`)
      .setParameters({ cutoff, batch })
      .execute();
    return res.affected ?? 0;
  }
}
