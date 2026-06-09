import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Not, Repository } from 'typeorm';

import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

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
  ) {}

  async create(
    tenantId: string,
    dto: CreateNotificationTemplateDto,
  ): Promise<NotificationTemplate> {
    const template = this.templates.create({
      tenant: { id: tenantId } as Tenant,
      name: dto.name,
      type: dto.type,
      channel: dto.channel,
      content_ar: dto.contentAr,
      content_en: dto.contentEn,
      is_active: dto.isActive ?? true,
    });
    return this.templates.save(template);
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
        context: { ruleRefs, scheduledRefs },
      });
    }

    await this.templates.delete({ id });
  }
}
