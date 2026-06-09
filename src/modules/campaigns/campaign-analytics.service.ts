import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, SelectQueryBuilder } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { RecipientStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CampaignAnalyticsFilterDto } from './dto/campaign-analytics-filter.dto';
import {
  DELIVERED_RECIPIENT_STATUSES,
  PROCESSED_RECIPIENT_STATUSES,
} from './campaign.constants';

/**
 * Campaign reporting & performance analytics.
 *
 * Tenant isolation: campaign queries filter `tenant: { id: tenantId }`;
 * recipient aggregates (no tenant column) join through `campaign.tenant`, so no
 * cross-tenant data is ever exposed.
 */
@Injectable()
export class CampaignAnalyticsService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
  ) {}

  /** Per-campaign performance: totals, delivered/failed, delivery & completion rates. */
  async campaignSummary(tenantId: string, campaignId: string) {
    await this.assertCampaign(tenantId, campaignId);

    const rows = await this.recipients
      .createQueryBuilder('r')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('r.campaign_id = :campaignId', { campaignId })
      .groupBy('r.status')
      .getRawMany<{ status: RecipientStatus; count: string }>();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = Number(r.count);
      byStatus[r.status] = c;
      total += c;
    }

    const delivered = DELIVERED_RECIPIENT_STATUSES.reduce(
      (sum, s) => sum + (byStatus[s] ?? 0),
      0,
    );
    const failed = byStatus[RecipientStatus.FAILED] ?? 0;
    const processed = PROCESSED_RECIPIENT_STATUSES.reduce(
      (sum, s) => sum + (byStatus[s] ?? 0),
      0,
    );

    const rate = (n: number) => (total === 0 ? 0 : +((n / total) * 100).toFixed(2));

    return {
      campaignId,
      totalRecipients: total,
      deliveredCount: delivered,
      failedCount: failed,
      processedCount: processed,
      deliveryRate: rate(delivered),
      completionRate: rate(processed),
      byStatus,
    };
  }

  /** Tenant-wide campaign counts grouped by status (with optional filters). */
  async statistics(tenantId: string, filter: CampaignAnalyticsFilterDto) {
    const qb = this.scopedCampaigns(tenantId, filter)
      .select('campaign.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('campaign.status');

    const rows = await qb.getRawMany<{ status: string; count: string }>();
    const byStatus: Record<string, number> = {};
    let totalCampaigns = 0;
    for (const r of rows) {
      const c = Number(r.count);
      byStatus[r.status] = c;
      totalCampaigns += c;
    }
    return { tenantId, totalCampaigns, byStatus };
  }

  /** Paginated campaign history with a recipient count per campaign. */
  async history(tenantId: string, filter: CampaignAnalyticsFilterDto) {
    const [campaigns, total] = await this.scopedCampaigns(tenantId, filter)
      .leftJoinAndSelect('campaign.template', 'template')
      .orderBy('campaign.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    // Recipient counts per campaign in a single grouped query (no N+1).
    const ids = campaigns.map((c) => c.id);
    const counts = new Map<string, number>();
    if (ids.length) {
      const rows = await this.recipients
        .createQueryBuilder('r')
        .select('r.campaign_id', 'campaignId')
        .addSelect('COUNT(*)', 'count')
        .where('r.campaign_id IN (:...ids)', { ids })
        .groupBy('r.campaign_id')
        .getRawMany<{ campaignId: string; count: string }>();
      for (const row of rows) counts.set(row.campaignId, Number(row.count));
    }

    const data = campaigns.map((c) => ({
      ...c,
      recipientCount: counts.get(c.id) ?? 0,
    }));
    return { data, total, page: filter.page, limit: filter.limit };
  }

  /** Tenant dashboard: campaign counts by status + aggregate recipient outcomes. */
  async dashboard(tenantId: string) {
    // Campaigns by status.
    const campaignRows = await this.campaigns
      .createQueryBuilder('campaign')
      .leftJoin('campaign.tenant', 'tenant')
      .select('campaign.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('tenant.id = :tenantId', { tenantId })
      .andWhere('campaign.deleted_at IS NULL')
      .groupBy('campaign.status')
      .getRawMany<{ status: string; count: string }>();

    const campaignsByStatus: Record<string, number> = {};
    let totalCampaigns = 0;
    for (const r of campaignRows) {
      const c = Number(r.count);
      campaignsByStatus[r.status] = c;
      totalCampaigns += c;
    }

    // Aggregate recipient outcomes across the tenant's campaigns.
    const recipientRows = await this.recipients
      .createQueryBuilder('r')
      .leftJoin('r.campaign', 'c')
      .leftJoin('c.tenant', 't')
      .select('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('c.deleted_at IS NULL')
      .groupBy('r.status')
      .getRawMany<{ status: RecipientStatus; count: string }>();

    const recipientsByStatus: Record<string, number> = {};
    let totalRecipients = 0;
    for (const r of recipientRows) {
      const c = Number(r.count);
      recipientsByStatus[r.status] = c;
      totalRecipients += c;
    }
    const delivered = DELIVERED_RECIPIENT_STATUSES.reduce(
      (sum, s) => sum + (recipientsByStatus[s] ?? 0),
      0,
    );
    const failed = recipientsByStatus[RecipientStatus.FAILED] ?? 0;

    return {
      tenantId,
      totalCampaigns,
      campaignsByStatus,
      totalRecipients,
      deliveredCount: delivered,
      failedCount: failed,
      deliveryRate:
        totalRecipients === 0 ? 0 : +((delivered / totalRecipients) * 100).toFixed(2),
      recipientsByStatus,
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private scopedCampaigns(
    tenantId: string,
    filter: CampaignAnalyticsFilterDto,
  ): SelectQueryBuilder<Campaign> {
    const qb = this.campaigns
      .createQueryBuilder('campaign')
      .leftJoin('campaign.tenant', 'tenant')
      .where('tenant.id = :tenantId', { tenantId })
      .andWhere('campaign.deleted_at IS NULL');
    if (filter.status) qb.andWhere('campaign.status = :status', { status: filter.status });
    if (filter.type) qb.andWhere('campaign.type = :type', { type: filter.type });
    if (filter.from) qb.andWhere('campaign.created_at >= :from', { from: new Date(filter.from) });
    if (filter.to) qb.andWhere('campaign.created_at < :to', { to: new Date(filter.to) });
    return qb;
  }

  private async assertCampaign(tenantId: string, campaignId: string): Promise<void> {
    const ok = await this.campaigns.exists({
      where: { id: campaignId, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!ok) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Campaign not found' });
    }
  }
}
