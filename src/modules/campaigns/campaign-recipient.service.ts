import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { Customer } from '../../entities/CRM/Customer';
import { IsNull } from 'typeorm';
import { RecipientStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { AddCampaignRecipientsDto } from './dto/add-campaign-recipients.dto';
import { RemoveCampaignRecipientsDto } from './dto/remove-campaign-recipients.dto';
import { CampaignRecipientFilterDto } from './dto/campaign-recipient-filter.dto';
import { EDITABLE_STATUSES } from './campaign.constants';

/**
 * Campaign recipients.
 *
 * Tenant isolation: `campaign_recipients` has NO tenant column, so isolation is
 * enforced THROUGH the campaign — every operation first verifies the campaign
 * belongs to the caller's tenant (`assertCampaign`), then scopes recipient rows
 * by `campaign.id`. Referenced customers are validated against the tenant too.
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
  ) {}

  /** Bulk add (idempotent via the unique (campaign, customer) constraint). */
  async addRecipients(
    tenantId: string,
    campaignId: string,
    dto: AddCampaignRecipientsDto,
  ) {
    const campaign = await this.assertCampaign(tenantId, campaignId);
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Recipients cannot be modified while the campaign is "${campaign.status}"`,
      });
    }

    // Validate all customers belong to the tenant.
    const found = await this.customers.count({
      where: { id: In(dto.customerIds), tenant: { id: tenantId } },
    });
    if (found !== dto.customerIds.length) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'One or more customers were not found in this tenant',
      });
    }

    const result = await this.recipients
      .createQueryBuilder()
      .insert()
      .into(CampaignRecipient)
      .values(
        dto.customerIds.map((customerId) => ({
          campaign: { id: campaignId } as Campaign,
          customer: { id: customerId } as Customer,
          status: RecipientStatus.QUEUED,
        })),
      )
      .orIgnore() // skip existing (campaign, customer) pairs
      .execute();

    const added = result.identifiers.filter(Boolean).length;
    return {
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
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Recipients cannot be modified while the campaign is "${campaign.status}"`,
      });
    }

    const result = await this.recipients
      .createQueryBuilder()
      .delete()
      .from(CampaignRecipient)
      .where('campaign_id = :campaignId', { campaignId })
      .andWhere('customer_id IN (:...customerIds)', { customerIds: dto.customerIds })
      .execute();

    return { removed: result.affected ?? 0 };
  }

  async list(
    tenantId: string,
    campaignId: string,
    filter: CampaignRecipientFilterDto,
  ) {
    await this.assertCampaign(tenantId, campaignId);

    const where: FindOptionsWhere<CampaignRecipient> = {
      campaign: { id: campaignId },
    };
    if (filter.status) where.status = filter.status;
    if (filter.customerId) where.customer = { id: filter.customerId };

    const [data, total] = await this.recipients.findAndCount({
      where,
      relations: { customer: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  /** Recipient counts by status for a campaign. */
  async statistics(tenantId: string, campaignId: string) {
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
    return { campaignId, total, byStatus };
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
