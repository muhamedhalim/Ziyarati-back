import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateNotificationRuleDto } from './dto/create-notification-rule.dto';
import { UpdateNotificationRuleDto } from './dto/update-notification-rule.dto';
import { NotificationRuleFilterDto } from './dto/notification-rule-filter.dto';

/**
 * Automation rules: "when <trigger_event> fires, schedule a notification using
 * <template> after <delay_minutes>". Configurable per tenant; independently
 * enable/disable.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; a referenced
 * template is re-validated against the tenant before linking.
 */
@Injectable()
export class NotificationRuleService {
  constructor(
    @InjectRepository(NotificationRule)
    private readonly rules: Repository<NotificationRule>,
    @InjectRepository(NotificationTemplate)
    private readonly templates: Repository<NotificationTemplate>,
  ) {}

  async create(
    tenantId: string,
    dto: CreateNotificationRuleDto,
  ): Promise<NotificationRule> {
    if (dto.templateId) await this.assertTemplate(tenantId, dto.templateId);

    const rule = this.rules.create({
      tenant: { id: tenantId } as Tenant,
      template: dto.templateId
        ? ({ id: dto.templateId } as NotificationTemplate)
        : undefined,
      trigger_event: dto.triggerEvent,
      delay_minutes: dto.delayMinutes ?? 0,
      is_active: dto.isActive ?? true,
      anchor: dto.anchor ?? 'AFTER_EVENT',
    });
    return this.rules.save(rule);
  }

  async findAll(tenantId: string, filter: NotificationRuleFilterDto) {
    const where: FindOptionsWhere<NotificationRule> = {
      tenant: { id: tenantId },
    };
    if (filter.triggerEvent) where.trigger_event = ILike(`%${filter.triggerEvent}%`);
    if (filter.templateId) where.template = { id: filter.templateId };
    if (filter.isActive !== undefined) where.is_active = filter.isActive === 'true';

    const [data, total] = await this.rules.findAndCount({
      where,
      relations: { template: true },
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<NotificationRule> {
    const rule = await this.rules.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { template: true },
    });
    if (!rule) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Rule not found' });
    }
    return rule;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateNotificationRuleDto,
  ): Promise<NotificationRule> {
    const rule = await this.findOne(tenantId, id);

    if (dto.templateId !== undefined) {
      if (dto.templateId) {
        await this.assertTemplate(tenantId, dto.templateId);
        rule.template = { id: dto.templateId } as NotificationTemplate;
      } else {
        rule.template = undefined;
      }
    }
    if (dto.triggerEvent !== undefined) rule.trigger_event = dto.triggerEvent;
    if (dto.delayMinutes !== undefined) rule.delay_minutes = dto.delayMinutes;
    if (dto.isActive !== undefined) rule.is_active = dto.isActive;
    if (dto.anchor !== undefined) rule.anchor = dto.anchor;

    return this.rules.save(rule);
  }

  async setActive(
    tenantId: string,
    id: string,
    active: boolean,
  ): Promise<NotificationRule> {
    const rule = await this.findOne(tenantId, id);
    rule.is_active = active;
    return this.rules.save(rule);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOne(tenantId, id);
    await this.rules.delete({ id });
  }

  /**
   * Returns every active rule for a tenant that matches the given trigger event.
   * Used by NotificationEventListener to evaluate rules without pagination.
   */
  findActiveByTrigger(
    tenantId: string,
    triggerEvent: string,
  ): Promise<NotificationRule[]> {
    return this.rules.find({
      where: {
        tenant: { id: tenantId },
        trigger_event: triggerEvent,
        is_active: true,
      },
      relations: { template: true },
    });
  }

  private async assertTemplate(tenantId: string, templateId: string): Promise<void> {
    const ok = await this.templates.exists({
      where: { id: templateId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Template not found in this tenant',
      });
    }
  }
}
