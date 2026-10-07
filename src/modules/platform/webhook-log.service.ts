import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { WebhookLog } from '../../entities/System/WebhookLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { QueryWebhookLogsDto } from './dto/query-webhook-logs.dto';
import { redactSecrets, WEBHOOK_LOG_STATUS } from './platform.constants';

export interface WebhookLogInput {
  source?: string;
  eventType?: string;
  payload?: any;
  status?: string;
  errorMessage?: string;
}

/**
 * Webhook audit log (`webhook_logs`) — visibility over inbound/outbound webhooks
 * (WhatsApp, Tap, future integrations).
 *
 * Tenant-scoped via the `tenant` relation. Read-only to clients except `retry`;
 * `record()` is the ingestion seam for webhook handlers. Schema note: there is
 * no retry_count/processed column, so `retry` re-queues by resetting `status` to
 * PENDING (the actual reprocessing is a future worker — architecture seam).
 */
@Injectable()
export class WebhookLogService {
  constructor(
    @InjectRepository(WebhookLog)
    private readonly logs: Repository<WebhookLog>,
  ) {}

  /** Ingestion seam for webhook handlers. Tenant optional (unresolved sources). */
  record(tenantId: string | null, input: WebhookLogInput): Promise<WebhookLog> {
    return this.logs.save(
      this.logs.create({
        tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
        source: input.source,
        event_type: input.eventType,
        payload: redactSecrets(input.payload),
        status: input.status,
        error_message: input.errorMessage,
      }),
    );
  }

  async list(tenantId: string, query: QueryWebhookLogsDto) {
    const where: FindOptionsWhere<WebhookLog> = { tenant: { id: tenantId } };
    if (query.source) where.source = query.source;
    if (query.eventType) where.event_type = query.eventType;
    if (query.status) where.status = query.status;
    if (query.from && query.to) {
      where.created_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.created_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.created_at = LessThan(new Date(query.to));
    }

    // Keyset path: no COUNT, O(limit) — required at tens of millions of rows.
    if (query.cursor) {
      where.created_at = LessThan(new Date(query.cursor));
      const rows = await this.logs.find({
        where,
        order: { created_at: 'DESC' },
        take: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      const data = hasMore ? rows.slice(0, query.limit) : rows;
      const nextCursor = hasMore ? data[data.length - 1].created_at.toISOString() : null;
      return { data, nextCursor, hasMore, limit: query.limit };
    }

    const [data, total] = await this.logs.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async get(tenantId: string, id: string): Promise<WebhookLog> {
    const log = await this.logs.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!log) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Webhook log not found' });
    }
    return log;
  }

  /**
   * Re-queue a failed webhook for reprocessing (sets status PENDING). A future
   * worker scans PENDING rows and reprocesses them. Already-successful webhooks
   * cannot be retried.
   */
  async retry(tenantId: string, id: string): Promise<WebhookLog> {
    const log = await this.get(tenantId, id);
    if (log.status === WEBHOOK_LOG_STATUS.SUCCESS) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'A successfully processed webhook cannot be retried',
      });
    }
    log.status = WEBHOOK_LOG_STATUS.PENDING;
    return this.logs.save(log);
  }
}
