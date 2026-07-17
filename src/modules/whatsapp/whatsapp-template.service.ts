import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { WhatsappTemplate } from '../../entities/WhatsApp/WhatsappTemplate';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWhatsappTemplateDto } from './dto/create-whatsapp-template.dto';
import { UpdateWhatsappTemplateDto } from './dto/update-whatsapp-template.dto';
import { WhatsappTemplateFilterDto } from './dto/whatsapp-template-filter.dto';
import {
  WHATSAPP_TEMPLATE_STATUS,
  WHATSAPP_TEMPLATE_STATUSES,
} from './whatsapp.constants';

/**
 * WhatsApp message templates. Unique per (tenant, name, language).
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; a referenced
 * account is re-validated against the tenant.
 */
@Injectable()
export class WhatsappTemplateService {
  constructor(
    @InjectRepository(WhatsappTemplate)
    private readonly templates: Repository<WhatsappTemplate>,
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
  ) {}

  async create(tenantId: string, dto: CreateWhatsappTemplateDto): Promise<WhatsappTemplate> {
    if (dto.accountId) await this.assertAccount(tenantId, dto.accountId);

    const duplicate = await this.templates.findOne({
      where: { tenant: { id: tenantId }, name: dto.name, language: dto.language },
    });
    if (duplicate) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A template with this name and language already exists',
      });
    }

    const template = this.templates.create({
      tenant: { id: tenantId } as Tenant,
      whatsapp_account: dto.accountId ? ({ id: dto.accountId } as WhatsappAccount) : undefined,
      name: dto.name,
      language: dto.language,
      category: dto.category,
      components: dto.components,
      status: dto.status ?? WHATSAPP_TEMPLATE_STATUS.DRAFT,
    });
    return this.templates.save(template);
  }

  async findAll(tenantId: string, filter: WhatsappTemplateFilterDto) {
    const where: FindOptionsWhere<WhatsappTemplate> = { tenant: { id: tenantId } };
    if (filter.status) where.status = filter.status;
    if (filter.category) where.category = filter.category;
    if (filter.language) where.language = filter.language;
    if (filter.search) where.name = ILike(`%${filter.search}%`);
    if (filter.accountId) where.whatsapp_account = { id: filter.accountId };

    const [data, total] = await this.templates.findAndCount({
      where,
      // The templates screen shows which connected account/number each
      // template is synced under — load it rather than making the frontend
      // guess from `waba_id` alone.
      relations: { whatsapp_account: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<WhatsappTemplate> {
    const template = await this.templates.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Template not found' });
    }
    return template;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWhatsappTemplateDto,
  ): Promise<WhatsappTemplate> {
    const template = await this.findOne(tenantId, id);
    if (dto.accountId !== undefined) {
      if (dto.accountId) {
        await this.assertAccount(tenantId, dto.accountId);
        template.whatsapp_account = { id: dto.accountId } as WhatsappAccount;
      } else {
        template.whatsapp_account = undefined;
      }
    }
    if (dto.name !== undefined) template.name = dto.name;
    if (dto.language !== undefined) template.language = dto.language;
    if (dto.category !== undefined) template.category = dto.category;
    if (dto.components !== undefined) template.components = dto.components;
    if (dto.status !== undefined) template.status = dto.status;
    return this.templates.save(template);
  }

  /** Updates the review status (draft/pending_review/approved/rejected/disabled). */
  async setStatus(tenantId: string, id: string, status: string): Promise<WhatsappTemplate> {
    if (!WHATSAPP_TEMPLATE_STATUSES.includes(status as never)) {
      throw new AppError(ErrorCode.BAD_REQUEST, { message: 'Invalid template status' });
    }
    const template = await this.findOne(tenantId, id);
    template.status = status;
    return this.templates.save(template);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const template = await this.findOne(tenantId, id);
    await this.templates.softRemove(template);
  }

  /** INTERNAL: returns an APPROVED template for sending (else 422). */
  async getSendableTemplate(tenantId: string, id: string): Promise<WhatsappTemplate> {
    const template = await this.findOne(tenantId, id);
    if (template.status !== WHATSAPP_TEMPLATE_STATUS.APPROVED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `Only approved templates can be sent (current: "${template.status}")`,
      });
    }
    return template;
  }

  private async assertAccount(tenantId: string, accountId: string): Promise<void> {
    const ok = await this.accounts.exists({
      where: { id: accountId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp account not found in this tenant',
      });
    }
  }
}
