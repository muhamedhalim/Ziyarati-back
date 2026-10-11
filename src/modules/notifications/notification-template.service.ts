import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Not, Repository } from 'typeorm';

import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import {
  orderedBodyParameters,
  unsupportedTemplateShape,
} from '../whatsapp/template-variables.util';
import { WHATSAPP_TEMPLATE_STATUS } from '../whatsapp/whatsapp.constants';

import { CreateNotificationTemplateDto } from './dto/create-notification-template.dto';
import { UpdateNotificationTemplateDto } from './dto/update-notification-template.dto';
import { NotificationTemplateFilterDto } from './dto/notification-template-filter.dto';
import { NOTIFICATION_STATUS } from './notification.constants';

/**
 * Reusable notification templates.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }` and every
 * create stamps it. The tenant always comes from the authenticated principal.
 */
@Injectable()
export class NotificationTemplateService {
  constructor(
    @InjectRepository(NotificationTemplate)
    private readonly templates: Repository<NotificationTemplate>,
    @InjectRepository(NotificationRule)
    private readonly rules: Repository<NotificationRule>,
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
    private readonly whatsappTemplates: WhatsappTemplateService,
  ) {}

  async create(
    tenantId: string,
    dto: CreateNotificationTemplateDto,
  ): Promise<NotificationTemplate> {
    const providerTemplateId = dto.providerTemplateId
      ? await this.assertWhatsappTemplate(tenantId, dto.providerTemplateId)
      : undefined;
    const providerTemplateIdAr = dto.providerTemplateIdAr
      ? await this.assertWhatsappTemplate(tenantId, dto.providerTemplateIdAr, 'ar')
      : undefined;

    const template = this.templates.create({
      tenant: { id: tenantId } as Tenant,
      name: dto.name,
      type: dto.type,
      channel: dto.channel,
      content_ar: dto.contentAr,
      content_en: dto.contentEn,
      is_active: dto.isActive ?? true,
      provider_template_id: providerTemplateId,
      provider_template_id_ar: providerTemplateIdAr,
    });
    return this.templates.save(template);
  }

  /**
   * T157 gap-closure: `provider_template_id`/`provider_template_id_ar` name a
   * `WhatsappTemplate` (its own local UUID, not Meta's id — see that
   * entity's field of the same name). Re-validates tenant ownership
   * (mirrors NotificationRuleService.assertTemplate's pattern) and, for the
   * Arabic-variant column, that the linked template's own `language` field
   * (FR-H015: "using the existing template language field") is actually
   * Arabic — otherwise the locale-based selection in
   * NotificationDispatchService would silently send the wrong language.
   */
  private async assertWhatsappTemplate(
    tenantId: string,
    id: string,
    expectLanguagePrefix?: string,
    /** Already linked and unchanged: not re-judged (an unrelated edit must not fail on today's status). */
    alreadyLinked = false,
  ): Promise<string> {
    const template = await this.whatsappTemplates.findOne(tenantId, id);
    if (
      expectLanguagePrefix &&
      !template.language?.toLowerCase().startsWith(expectLanguagePrefix)
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `WhatsApp template "${template.name}" is not a "${expectLanguagePrefix}" language variant (its language is "${template.language}")`,
      });
    }
    if (!alreadyLinked) this.assertReadyToLink(template);
    return id;
  }

  /**
   * A notification may only point at a template it can actually send — the
   * link is the clinic's explicit decision that "this event uses this
   * template", so it must be a real one:
   *   - APPROVED by Meta (a pending/rejected/paused template fails every send);
   *   - sendable by this platform (no header/button parameters we cannot fill);
   *   - every placeholder bound to a trusted data source — otherwise the
   *     pipeline has nothing to put in `{{n}}` and every send would fall back
   *     to email with no one having chosen that.
   */
  private assertReadyToLink(template: {
    name: string;
    status: string;
    components?: unknown;
    variable_mapping?: Record<string, string> | null;
  }): void {
    if (template.status !== WHATSAPP_TEMPLATE_STATUS.APPROVED) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `WhatsApp template "${template.name}" cannot be used yet: it is "${template.status}", not approved by Meta.`,
        publicContext: { reason: 'TEMPLATE_NOT_APPROVED', templateStatus: template.status },
      });
    }
    const unsupported = unsupportedTemplateShape(template.components);
    if (unsupported) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `WhatsApp template "${template.name}" ${unsupported}.`,
        publicContext: { reason: 'UNSUPPORTED_TEMPLATE_SHAPE' },
      });
    }
    const unbound = orderedBodyParameters(template.components).filter(
      (name) => !template.variable_mapping?.[name],
    );
    if (unbound.length > 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          `WhatsApp template "${template.name}" has placeholder(s) ` +
          `${unbound.map((n) => `{{${n}}}`).join(', ')} with no data source. ` +
          'Choose what fills each one on the Templates tab first.',
        publicContext: { reason: 'UNBOUND_PLACEHOLDERS', placeholders: unbound },
      });
    }
  }

  async findAll(tenantId: string, filter: NotificationTemplateFilterDto) {
    const where: FindOptionsWhere<NotificationTemplate> = {
      tenant: { id: tenantId },
    };
    if (filter.search) where.name = ILike(`%${filter.search}%`);
    if (filter.type) where.type = filter.type;
    if (filter.channel) where.channel = filter.channel;
    if (filter.isActive !== undefined) where.is_active = filter.isActive === 'true';

    const [data, total] = await this.templates.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<NotificationTemplate> {
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
    dto: UpdateNotificationTemplateDto,
  ): Promise<NotificationTemplate> {
    const template = await this.findOne(tenantId, id);
    if (dto.name !== undefined) template.name = dto.name;
    if (dto.type !== undefined) template.type = dto.type;
    if (dto.channel !== undefined) template.channel = dto.channel;
    if (dto.contentAr !== undefined) template.content_ar = dto.contentAr;
    if (dto.contentEn !== undefined) template.content_en = dto.contentEn;
    if (dto.isActive !== undefined) template.is_active = dto.isActive;
    if (dto.providerTemplateId !== undefined) {
      template.provider_template_id = dto.providerTemplateId
        ? await this.assertWhatsappTemplate(
            tenantId,
            dto.providerTemplateId,
            undefined,
            dto.providerTemplateId === template.provider_template_id,
          )
        : undefined;
    }
    if (dto.providerTemplateIdAr !== undefined) {
      template.provider_template_id_ar = dto.providerTemplateIdAr
        ? await this.assertWhatsappTemplate(
            tenantId,
            dto.providerTemplateIdAr,
            'ar',
            dto.providerTemplateIdAr === template.provider_template_id_ar,
          )
        : undefined;
    }
    return this.templates.save(template);
  }

  async setActive(
    tenantId: string,
    id: string,
    active: boolean,
  ): Promise<NotificationTemplate> {
    const template = await this.findOne(tenantId, id);
    template.is_active = active;
    return this.templates.save(template);
  }

  /** Hard delete (no soft-delete column). Blocked if still referenced. */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOne(tenantId, id);

    const ruleRefs = await this.rules.count({
      where: { template: { id }, tenant: { id: tenantId } },
    });
    const scheduledRefs = await this.scheduled.count({
      where: {
        template: { id },
        tenant: { id: tenantId },
        status: Not(NOTIFICATION_STATUS.CANCELLED),
      },
    });
    if (ruleRefs > 0 || scheduledRefs > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Template is in use by rules or pending notifications and cannot be deleted',
        publicContext: { ruleRefs, scheduledRefs },
      });
    }

    await this.templates.delete({ id });
  }
}
