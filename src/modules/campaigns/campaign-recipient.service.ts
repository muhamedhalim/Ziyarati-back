import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { Customer } from '../../entities/CRM/Customer';
import { RecipientProcessing } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CampaignRunService } from './campaign-run.service';
import { AddCampaignRecipientsDto } from './dto/add-campaign-recipients.dto';
import { RemoveCampaignRecipientsDto } from './dto/remove-campaign-recipients.dto';
import { CampaignRecipientFilterDto } from './dto/campaign-recipient-filter.dto';
import { EDITABLE_LIFECYCLES } from './campaign.constants';

/**
 * Campaign recipients — enrollment is scoped to a CampaignRun.
 *
 * Add/remove target the campaign's CURRENT editable (IDLE) run; list/stats read
 * the LATEST run. Tenant isolation is enforced through the campaign (no tenant
 * column on recipients): every op verifies the campaign belongs to the caller's
 * tenant, then scopes recipient rows by run id.
 */
@Injectable()
export class CampaignRecipientService {
  constructor(
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly runs: CampaignRunService,
  ) {}

  /** Bulk add (idempotent via the unique (run, customer) constraint). */
  async addRecipients(
    tenantId: string,
    campaignId: string,
    dto: AddCampaignRecipientsDto,
  ) {
    const campaign = await this.assertCampaign(tenantId, campaignId);
    if (!EDITABLE_LIFECYCLES.includes(campaign.lifecycle)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Recipients cannot be modified while the campaign is "${campaign.lifecycle}"`,
      });
    }

    const found = await this.customers.count({
      where: { id: In(dto.customerIds), tenant: { id: tenantId } },
    });
    if (found !== dto.customerIds.length) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'One or more customers were not found in this tenant',
      });
    }

    const run = await this.runs.currentEditable(tenantId, campaignId);
    const result = await this.recipients
      .createQueryBuilder()
      .insert()
      .into(CampaignRecipient)
      .values(
        dto.customerIds.map((customerId) => ({
          run: { id: run.id } as CampaignRun,
          campaign: { id: campaignId } as Campaign,
          customer: { id: customerId } as Customer,
          processing: RecipientProcessing.PENDING,
        })),
      )
      .orIgnore() // skip existing (run, customer) pairs
      .execute();

    const added = result.identifiers.filter(Boolean).length;
    return {
      runId: run.id,
      requested: dto.customerIds.length,
      added,
      skipped: dto.customerIds.length - added,
    };
  }

  async removeRecipients(
    tenantId: string,
    campaignId: string,
    dto: RemoveCampaignRecipientsDto,
  ) {
    const campaign = await this.assertCampaign(tenantId, campaignId);
    if (!EDITABLE_LIFECYCLES.includes(campaign.lifecycle)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Recipients cannot be modified while the campaign is "${campaign.lifecycle}"`,
      });
    }

    const run = await this.runs.currentEditable(tenantId, campaignId);
    const result = await this.recipients
      .createQueryBuilder()
      .delete()
      .from(CampaignRecipient)
      .where('"runId" = :runId', { runId: run.id })
      .andWhere('"customerId" IN (:...customerIds)', { customerIds: dto.customerIds })
      .execute();

    return { runId: run.id, removed: result.affected ?? 0 };
  }

  async list(
    tenantId: string,
    campaignId: string,
    filter: CampaignRecipientFilterDto,
  ) {
    await this.assertCampaign(tenantId, campaignId);
    const run = await this.runs.latest(tenantId, campaignId);
    if (!run) return { data: [], total: 0, page: filter.page, limit: filter.limit, runId: null };

    const where: FindOptionsWhere<CampaignRecipient> = { run: { id: run.id } };
    if (filter.processing) where.processing = filter.processing;
    if (filter.customerId) where.customer = { id: filter.customerId };

    const [data, total] = await this.recipients.findAndCount({
      where,
      relations: { customer: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit, runId: run.id };
  }

  /** Recipient counts by processing state for the campaign's latest run. */
  async statistics(tenantId: string, campaignId: string) {
    await this.assertCampaign(tenantId, campaignId);
    const run = await this.runs.latest(tenantId, campaignId);
    if (!run) return { campaignId, runId: null, total: 0, byProcessing: {} };

    const rows = await this.recipients
      .createQueryBuilder('r')
      .select('r.processing', 'processing')
      .addSelect('COUNT(*)', 'count')
      .where('r."runId" = :runId', { runId: run.id })
      .groupBy('r.processing')
      .getRawMany<{ processing: RecipientProcessing; count: string }>();

    const byProcessing: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const c = Number(r.count);
      byProcessing[r.processing] = c;
      total += c;
    }
    return { campaignId, runId: run.id, total, byProcessing };
  }

  /** Verifies the campaign exists and belongs to the tenant (404 otherwise). */
  private async assertCampaign(tenantId: string, campaignId: string): Promise<Campaign> {
    const campaign = await this.campaigns.findOne({
      where: { id: campaignId, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!campaign) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Campaign not found' });
    }
    return campaign;
  }
}
