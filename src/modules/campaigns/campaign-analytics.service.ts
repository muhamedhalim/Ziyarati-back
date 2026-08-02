import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, SelectQueryBuilder } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CampaignAnalyticsFilterDto } from './dto/campaign-analytics-filter.dto';

/**
 * Campaign reporting & performance analytics.
 *
 * Reads the MATERIALIZED counters on `campaign_runs` (maintained atomically by
 * the dispatcher) instead of scanning `campaign_recipients` with GROUP BY — so
 * summaries are O(1)/O(#runs), not O(#recipients), and stay correct at millions
 * of recipients.
 *
 * Tenant isolation: every query filters `tenant.id = :tenantId`.
 */
@Injectable()
export class CampaignAnalyticsService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRun)
    private readonly runs: Repository<CampaignRun>,
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  /** Per-campaign performance from the latest run's counters. */
  async campaignSummary(tenantId: string, campaignId: string) {
    await this.assertCampaign(tenantId, campaignId);

    const run = await this.runs.findOne({
      where: { tenant: { id: tenantId }, campaign: { id: campaignId } },
      order: { created_at: 'DESC' },
    });

    if (!run) {
      return {
        campaignId,
        runId: null,
        execution: null,
        totalRecipients: 0,
        deliveredCount: 0,
        failedCount: 0,
        processedCount: 0,
        deliveryRate: 0,
        completionRate: 0,
        counters: {
          queued: 0,
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          skipped: 0,
        },
      };
    }

    const total = run.total_recipients;
    // `run.delivered` already counts every recipient that reached DELIVERED-or-
    // beyond (READ passes through the DELIVERED increment), so it must NOT be
    // summed with `run.read` — read is a subset.
    const delivered = run.delivered;
    const processed = run.sent + run.failed + run.skipped;
    const rate = (n: number) =>
      total === 0 ? 0 : +((n / total) * 100).toFixed(2);

    return {
      campaignId,
      runId: run.id,
      execution: run.execution,
      totalRecipients: total,
      deliveredCount: delivered,
      readCount: run.read,
      failedCount: run.failed,
      processedCount: processed,
      deliveryRate: rate(delivered),
      readRate: rate(run.read),
      completionRate: rate(processed),
      counters: {
        queued: run.queued,
        sent: run.sent,
        delivered: run.delivered,
        read: run.read,
        failed: run.failed,
        skipped: run.skipped,
      },
    };
  }

  /** Tenant-wide campaign counts grouped by lifecycle (with optional filters). */
  async statistics(tenantId: string, filter: CampaignAnalyticsFilterDto) {
    const clinicName = await this.clinicName(tenantId);
    const qb = this.scopedCampaigns(tenantId, filter)
      .select('campaign.lifecycle', 'lifecycle')
      .addSelect('COUNT(*)', 'count')
      .groupBy('campaign.lifecycle');

    const rows = await qb.getRawMany<{ lifecycle: string; count: string }>();
    const byLifecycle: Record<string, number> = {};
    let totalCampaigns = 0;
    for (const r of rows) {
      const c = Number(r.count);
      byLifecycle[r.lifecycle] = c;
      totalCampaigns += c;
    }
    return { clinicName, totalCampaigns, byLifecycle };
  }

  /** Paginated campaign history with the latest run's recipient total. */
  async history(tenantId: string, filter: CampaignAnalyticsFilterDto) {
    const [campaigns, total] = await this.scopedCampaigns(tenantId, filter)
      .leftJoinAndSelect('campaign.template', 'template')
      .orderBy('campaign.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    const ids = campaigns.map((c) => c.id);
    const totals = new Map<string, number>();
    if (ids.length) {
      // Total recipients across runs per campaign (single grouped query).
      const rows = await this.runs
        .createQueryBuilder('run')
        .innerJoin('run.campaign', 'c')
        .select('c.id', 'campaignId')
        .addSelect('SUM(run.total_recipients)', 'recipients')
        .where('c.id IN (:...ids)', { ids })
        .groupBy('c.id')
        .getRawMany<{ campaignId: string; recipients: string }>();
      for (const row of rows)
        totals.set(row.campaignId, Number(row.recipients));
    }

    const data = campaigns.map((c) => ({
      ...c,
      recipientCount: totals.get(c.id) ?? 0,
    }));
    return { data, total, page: filter.page, limit: filter.limit };
  }

  /** Tenant dashboard: campaigns by lifecycle + aggregate run outcomes. */
  async dashboard(tenantId: string) {
    const clinicName = await this.clinicName(tenantId);
    const campaignRows = await this.campaigns
      .createQueryBuilder('campaign')
      .leftJoin('campaign.tenant', 'tenant')
      .select('campaign.lifecycle', 'lifecycle')
      .addSelect('COUNT(*)', 'count')
      .where('tenant.id = :tenantId', { tenantId })
      .andWhere('campaign.deleted_at IS NULL')
      .groupBy('campaign.lifecycle')
      .getRawMany<{ lifecycle: string; count: string }>();

    const campaignsByLifecycle: Record<string, number> = {};
    let totalCampaigns = 0;
    for (const r of campaignRows) {
      const c = Number(r.count);
      campaignsByLifecycle[r.lifecycle] = c;
      totalCampaigns += c;
    }

    // Aggregate run counters across the tenant (O(#runs), not O(#recipients)).
    const agg = await this.runs
      .createQueryBuilder('run')
      .leftJoin('run.tenant', 'tenant')
      .select('COALESCE(SUM(run.total_recipients),0)', 'total')
      .addSelect('COALESCE(SUM(run.sent),0)', 'sent')
      .addSelect('COALESCE(SUM(run.delivered),0)', 'delivered')
      .addSelect('COALESCE(SUM(run.read),0)', 'read')
      .addSelect('COALESCE(SUM(run.failed),0)', 'failed')
      .addSelect('COALESCE(SUM(run.skipped),0)', 'skipped')
      .where('tenant.id = :tenantId', { tenantId })
      .getRawOne<{
        total: string;
        sent: string;
        delivered: string;
        read: string;
        failed: string;
        skipped: string;
      }>();

    const totalRecipients = Number(agg?.total ?? 0);
    // `delivered` already includes recipients that went on to READ — do not add read.
    const delivered = Number(agg?.delivered ?? 0);
    const failed = Number(agg?.failed ?? 0);

    return {
      clinicName,
      totalCampaigns,
      campaignsByLifecycle,
      totalRecipients,
      deliveredCount: delivered,
      readCount: Number(agg?.read ?? 0),
      failedCount: failed,
      deliveryRate:
        totalRecipients === 0
          ? 0
          : +((delivered / totalRecipients) * 100).toFixed(2),
      counters: {
        sent: Number(agg?.sent ?? 0),
        delivered: Number(agg?.delivered ?? 0),
        read: Number(agg?.read ?? 0),
        failed,
        skipped: Number(agg?.skipped ?? 0),
      },
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
    if (filter.lifecycle)
      qb.andWhere('campaign.lifecycle = :lifecycle', {
        lifecycle: filter.lifecycle,
      });
    if (filter.type)
      qb.andWhere('campaign.type = :type', { type: filter.type });
    if (filter.from)
      qb.andWhere('campaign.created_at >= :from', {
        from: new Date(filter.from),
      });
    if (filter.to)
      qb.andWhere('campaign.created_at < :to', { to: new Date(filter.to) });
    return qb;
  }

  private async assertCampaign(
    tenantId: string,
    campaignId: string,
  ): Promise<void> {
    const ok = await this.campaigns.exists({
      where: { id: campaignId, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!ok) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Campaign not found',
      });
    }
  }

  /** The authenticated tenant only; never resolves an arbitrary tenant ID. */
  private async clinicName(tenantId: string): Promise<string> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Clinic not found' });
    }
    return tenant.name;
  }
}
