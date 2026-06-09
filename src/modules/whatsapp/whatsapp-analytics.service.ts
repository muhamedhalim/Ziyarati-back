import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import {
  WHATSAPP_CHANNEL,
  WHATSAPP_DELIVERY_STATUS,
} from './whatsapp.constants';
import { WhatsappAnalyticsFilterDto } from './dto/whatsapp-analytics-filter.dto';

/**
 * WhatsApp messaging analytics, computed over `notification_logs` rows with
 * `channel = WHATSAPP` (the WhatsApp send record). Account inventory analytics
 * read `whatsapp_accounts`.
 *
 * Tenant isolation: all log queries join `log.tenant` and filter `tenant.id`;
 * account queries filter `tenant: { id }`. No cross-tenant data is exposed.
 */
@Injectable()
export class WhatsappAnalyticsService {
  constructor(
    @InjectRepository(NotificationLog)
    private readonly logs: Repository<NotificationLog>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
  ) {}

  /** Totals + delivery/read/failure rates for the tenant's WhatsApp messages. */
  async overview(tenantId: string, filter: WhatsappAnalyticsFilterDto) {
    const rows = await this.scopedLogs(tenantId, filter)
      .select('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.status')
      .getRawMany<{ status: string | null; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = Number(r.count);
      byStatus[r.status ?? 'UNKNOWN'] = c;
      total += c;
    }

    const delivered =
      (byStatus[WHATSAPP_DELIVERY_STATUS.DELIVERED] ?? 0) +
      (byStatus[WHATSAPP_DELIVERY_STATUS.READ] ?? 0);
    const read = byStatus[WHATSAPP_DELIVERY_STATUS.READ] ?? 0;
    const failed = byStatus[WHATSAPP_DELIVERY_STATUS.FAILED] ?? 0;
    const rate = (n: number) => (total === 0 ? 0 : +((n / total) * 100).toFixed(2));

    return {
      tenantId,
      totalMessages: total,
      deliveredCount: delivered,
      readCount: read,
      failedCount: failed,
      deliveryRate: rate(delivered),
      readRate: rate(read),
      failureRate: rate(failed),
      byStatus,
    };
  }

  /** Per-template performance (counts + delivered/failed) for the tenant. */
  async templatePerformance(tenantId: string, filter: WhatsappAnalyticsFilterDto) {
    const rows = await this.scopedLogs(tenantId, filter)
      .select('l.template_id', 'templateId')
      .addSelect('l.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.template_id')
      .addGroupBy('l.status')
      .getRawMany<{ templateId: string | null; status: string | null; count: string }>();

    const map = new Map<string, { templateId: string; total: number; delivered: number; failed: number; read: number }>();
    for (const r of rows) {
      const key = r.templateId ?? 'unknown';
      const entry = map.get(key) ?? { templateId: key, total: 0, delivered: 0, failed: 0, read: 0 };
      const c = Number(r.count);
      entry.total += c;
      if (r.status === WHATSAPP_DELIVERY_STATUS.DELIVERED || r.status === WHATSAPP_DELIVERY_STATUS.READ) entry.delivered += c;
      if (r.status === WHATSAPP_DELIVERY_STATUS.READ) entry.read += c;
      if (r.status === WHATSAPP_DELIVERY_STATUS.FAILED) entry.failed += c;
      map.set(key, entry);
    }
    return { tenantId, templates: [...map.values()] };
  }

  /** Top contacts by message volume (engagement). */
  async engagement(tenantId: string, filter: WhatsappAnalyticsFilterDto, limit = 20) {
    const rows = await this.scopedLogs(tenantId, filter)
      .select('l.recipient_type', 'recipientType')
      .addSelect('l.recipient_id', 'recipientId')
      .addSelect('COUNT(*)', 'count')
      .andWhere('l.recipient_id IS NOT NULL')
      .groupBy('l.recipient_type')
      .addGroupBy('l.recipient_id')
      .orderBy('COUNT(*)', 'DESC')
      .limit(limit)
      .getRawMany<{ recipientType: string; recipientId: string; count: string }>();

    return {
      tenantId,
      topRecipients: rows.map((r) => ({
        recipientType: r.recipientType,
        recipientId: r.recipientId,
        messageCount: Number(r.count),
      })),
    };
  }

  /** Account-level inventory usage (counts from whatsapp_accounts). */
  async accountUsage(tenantId: string) {
    const accounts = await this.accounts.find({
      where: { tenant: { id: tenantId } },
    });
    const total = accounts.length;
    const active = accounts.filter((a) => a.is_active).length;
    const withCredentials = accounts.filter((a) => !!a.access_token).length;
    return {
      tenantId,
      totalAccounts: total,
      activeAccounts: active,
      inactiveAccounts: total - active,
      accountsWithCredentials: withCredentials,
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private scopedLogs(
    tenantId: string,
    filter: WhatsappAnalyticsFilterDto,
  ): SelectQueryBuilder<NotificationLog> {
    const qb = this.logs
      .createQueryBuilder('l')
      .leftJoin('l.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId })
      .andWhere('l.channel = :channel', { channel: WHATSAPP_CHANNEL });
    if (filter.templateId) qb.andWhere('l.template_id = :tid', { tid: filter.templateId });
    if (filter.from) qb.andWhere('l.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('l.created_at < :to', { to: new Date(filter.to) });
    return qb;
  }
}
