import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { scrubFailureReason } from '../../common/utils/log-scrubber.util';
import { NotificationLogFilterDto } from './dto/notification-log-filter.dto';

export interface RecordLogInput {
  templateId?: string;
  recipientType?: string;
  recipientId?: string;
  channel?: string;
  status: string;
  providerRef?: string;
  errorMessage?: string;
  sentAt?: Date;
}

/**
 * Notification delivery history / audit log.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }` and
 * `record()` stamps it. `notification_logs` has no appointment FK, so
 * appointment-scoped tracking lives on the scheduler; customer filtering is via
 * recipientType=CUSTOMER + recipientId.
 */
@Injectable()
export class NotificationLogService {
  constructor(
    @InjectRepository(NotificationLog)
    private readonly logs: Repository<NotificationLog>,
  ) {}

  /** Persists a delivery-attempt log entry. Called by the dispatcher. */
  record(tenantId: string, input: RecordLogInput): Promise<NotificationLog> {
    const log = this.logs.create({
      tenant: { id: tenantId } as Tenant,
      template_id: input.templateId,
      recipient_type: input.recipientType,
      recipient_id: input.recipientId,
      channel: input.channel,
      status: input.status,
      provider_ref: input.providerRef,
      // Provider and transport errors can echo a recipient number, an e-mail or a
      // token (residency plan P7). The one write seam scrubs, so no caller can forget.
      error_message:
        input.errorMessage === undefined
          ? undefined
          : scrubFailureReason(input.errorMessage),
      sent_at: input.sentAt,
    });
    return this.logs.save(log);
  }

  /**
   * Retention purge — deletes a capped batch of logs older than `days`. Called
   * by the maintenance sweep so `notification_logs` cannot grow unbounded.
   */
  async purgeOlderThan(days: number, batch = 5000): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const res = await this.logs
      .createQueryBuilder()
      .delete()
      .from(NotificationLog)
      .where('id IN (SELECT id FROM notification_logs WHERE created_at < :cutoff ORDER BY created_at ASC LIMIT :batch)')
      .setParameters({ cutoff, batch })
      .execute();
    return res.affected ?? 0;
  }

  async findAll(tenantId: string, filter: NotificationLogFilterDto) {
    const where: FindOptionsWhere<NotificationLog> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.channel) where.channel = filter.channel;
    if (filter.templateId) where.template_id = filter.templateId;
    if (filter.recipientType) where.recipient_type = filter.recipientType;
    if (filter.recipientId) where.recipient_id = filter.recipientId;
    if (filter.from && filter.to) {
      where.created_at = Between(new Date(filter.from), new Date(filter.to));
    } else if (filter.from) {
      where.created_at = MoreThanOrEqual(new Date(filter.from));
    } else if (filter.to) {
      where.created_at = LessThan(new Date(filter.to));
    }

    const [data, total] = await this.logs.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<NotificationLog> {
    const log = await this.logs.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!log) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Log entry not found' });
    }
    return log;
  }

  /** Delivery statistics grouped by status and by channel for the tenant. */
  async statistics(tenantId: string, from?: string, to?: string) {
    const base = this.logs
      .createQueryBuilder('l')
      .leftJoin('l.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId });
    if (from) base.andWhere('l.created_at >= :from', { from: new Date(from) });
    if (to) base.andWhere('l.created_at < :to', { to: new Date(to) });

    const byStatusRows = await base
      .clone()
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.status')
      .getRawMany<{ status: string | null; count: string }>();

    const byChannelRows = await base
      .clone()
      .select('l.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.channel')
      .getRawMany<{ channel: string | null; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of byStatusRows) {
      const c = Number(r.count);
      byStatus[r.status ?? 'UNKNOWN'] = c;
      total += c;
    }
    const byChannel: Record<string, number> = {};
    for (const r of byChannelRows) {
      byChannel[r.channel ?? 'UNKNOWN'] = Number(r.count);
    }

    return { tenantId, total, byStatus, byChannel };
  }
}
