import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, IsNull, Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';
import { CampaignStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { CampaignQueryDto } from './dto/campaign-query.dto';
import { EDITABLE_STATUSES } from './campaign.constants';

/**
 * Campaign CRUD + archive + duplicate.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`, every create
 * stamps it, and the referenced WhatsApp template is re-validated against the
 * tenant. The tenant always comes from the authenticated principal.
 *
 * Archive vs delete (schema has only a plain `deleted_at` column + a status enum
 * WITHOUT an ARCHIVED value): archive = soft-hide via `deleted_at`; delete =
 * hard delete (CASCADE removes recipients).
 */
@Injectable()
export class CampaignService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    dto: CreateCampaignDto,
  ): Promise<Campaign> {
    if (dto.templateId) await this.assertTemplate(tenantId, dto.templateId);

    const campaign = this.campaigns.create({
      tenant: { id: tenantId } as Tenant,
      type: dto.type,
      name: dto.name,
      template: dto.templateId
        ? ({ id: dto.templateId } as WhatsappTemplate)
        : undefined,
      status: CampaignStatus.DRAFT,
      segment: dto.segment,
      scheduled_at: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      throttle_per_minute: dto.throttlePerMinute ?? 30,
      daily_cap: dto.dailyCap,
      monthly_cap: dto.monthlyCap,
      created_by: { id: userId } as User,
    });
    const saved = await this.campaigns.save(campaign);
    return this.findOne(tenantId, saved.id);
  }

  async findAll(tenantId: string, query: CampaignQueryDto) {
    const where: FindOptionsWhere<Campaign> = { tenant: { id: tenantId } };
    if (query.includeArchived !== 'true') where.deleted_at = IsNull();
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.search) where.name = ILike(`%${query.search}%`);

    const sortBy = query.sortBy ?? 'created_at';
    const sortOrder = query.sortOrder ?? 'DESC';

    const [data, total] = await this.campaigns.findAndCount({
      where,
      relations: { template: true },
      order: { [sortBy]: sortOrder },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  async findOne(tenantId: string, id: string): Promise<Campaign> {
    const campaign = await this.campaigns.findOne({
      where: { id, tenant: { id: tenantId }, deleted_at: IsNull() },
      relations: { template: true, created_by: true },
    });
    if (!campaign) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Campaign not found' });
    }
    return campaign;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCampaignDto,
  ): Promise<Campaign> {
    const campaign = await this.findOne(tenantId, id);
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A campaign in status "${campaign.status}" cannot be edited`,
      });
    }

    if (dto.templateId !== undefined) {
      if (dto.templateId) {
        await this.assertTemplate(tenantId, dto.templateId);
        campaign.template = { id: dto.templateId } as WhatsappTemplate;
      } else {
        campaign.template = undefined;
      }
    }
    if (dto.type !== undefined) campaign.type = dto.type;
    if (dto.name !== undefined) campaign.name = dto.name;
    if (dto.segment !== undefined) campaign.segment = dto.segment;
    if (dto.scheduledAt !== undefined) {
      campaign.scheduled_at = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    }
    if (dto.throttlePerMinute !== undefined) campaign.throttle_per_minute = dto.throttlePerMinute;
    if (dto.dailyCap !== undefined) campaign.daily_cap = dto.dailyCap;
    if (dto.monthlyCap !== undefined) campaign.monthly_cap = dto.monthlyCap;

    await this.campaigns.save(campaign);
    return this.findOne(tenantId, id);
  }

  /** Hard delete. CASCADE removes recipients. Use archive to keep history. */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOne(tenantId, id);
    await this.campaigns.delete({ id });
  }

  /** Soft-archive: set `deleted_at` so the campaign is hidden from default lists but retained. */
  async archive(tenantId: string, id: string): Promise<Campaign> {
    const campaign = await this.findOne(tenantId, id);
    campaign.deleted_at = new Date();
    return this.campaigns.save(campaign);
  }

  /** Clones a campaign's configuration into a new DRAFT (recipients are NOT copied). */
  async duplicate(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<Campaign> {
    const source = await this.findOne(tenantId, id);
    const copy = this.campaigns.create({
      tenant: { id: tenantId } as Tenant,
      type: source.type,
      name: `${source.name} (Copy)`,
      template: source.template ? ({ id: source.template.id } as WhatsappTemplate) : undefined,
      status: CampaignStatus.DRAFT,
      segment: source.segment,
      scheduled_at: undefined,
      throttle_per_minute: source.throttle_per_minute,
      daily_cap: source.daily_cap,
      monthly_cap: source.monthly_cap,
      created_by: { id: userId } as User,
    });
    const saved = await this.campaigns.save(copy);
    return this.findOne(tenantId, saved.id);
  }

  private async assertTemplate(tenantId: string, templateId: string): Promise<void> {
    const ok = await this.templates.exists({
      where: { id: templateId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp template not found in this tenant',
      });
    }
  }
}
