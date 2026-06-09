import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { NotificationDispatchService } from './notification-dispatch.service';
import { ScheduleNotificationDto } from './dto/schedule-notification.dto';
import { UpdateScheduledNotificationDto } from './dto/update-scheduled-notification.dto';
import { RescheduleNotificationDto } from './dto/reschedule-notification.dto';
import { ScheduledNotificationFilterDto } from './dto/scheduled-notification-filter.dto';
import {
  CANCELLABLE_STATUSES,
  NOTIFICATION_STATUS,
  RESCHEDULABLE_STATUSES,
  NotificationStatus,
} from './notification.constants';

/**
 * Manages the scheduled-notification queue (the "enqueue" seam). Creating a row
 * with status SCHEDULED is the produce step; a future BullMQ producer would also
 * add a delayed job whose consumer calls NotificationDispatchService — no change
 * to this service's contract required.
 *
 * Tenant isolation: every query filters `tenant: { id: tenantId }`; template +
 * appointment references are re-validated against the tenant before linking.
 */
@Injectable()
export class NotificationSchedulerService {
  constructor(
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
    @InjectRepository(NotificationTemplate)
    private readonly templates: Repository<NotificationTemplate>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async schedule(
    tenantId: string,
    dto: ScheduleNotificationDto,
  ): Promise<ScheduledNotification> {
    if (dto.templateId) await this.assertTemplate(tenantId, dto.templateId);
    if (dto.appointmentId) await this.assertAppointment(tenantId, dto.appointmentId);

    const row = this.scheduled.create({
      tenant: { id: tenantId } as Tenant,
      template: dto.templateId
        ? ({ id: dto.templateId } as NotificationTemplate)
        : undefined,
      appointment: dto.appointmentId
        ? ({ id: dto.appointmentId } as Appointment)
        : undefined,
      recipient_type: dto.recipientType,
      recipient_id: dto.recipientId,
      scheduled_at: new Date(dto.scheduledAt),
      status: NOTIFICATION_STATUS.SCHEDULED,
    });
    return this.scheduled.save(row);
  }

  async findAll(tenantId: string, filter: ScheduledNotificationFilterDto) {
    const where: FindOptionsWhere<ScheduledNotification> = {
      tenant: { id: tenantId },
    };
    if (filter.status) where.status = filter.status;
    if (filter.templateId) where.template = { id: filter.templateId };
    if (filter.appointmentId) where.appointment = { id: filter.appointmentId };
    if (filter.recipientType) where.recipient_type = filter.recipientType;
    if (filter.recipientId) where.recipient_id = filter.recipientId;
    if (filter.from && filter.to) {
      where.scheduled_at = Between(new Date(filter.from), new Date(filter.to));
    } else if (filter.from) {
      where.scheduled_at = MoreThanOrEqual(new Date(filter.from));
    } else if (filter.to) {
      where.scheduled_at = LessThan(new Date(filter.to));
    }

    const [data, total] = await this.scheduled.findAndCount({
      where,
      relations: { template: true, appointment: true },
      order: { scheduled_at: 'ASC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  async findOne(tenantId: string, id: string): Promise<ScheduledNotification> {
    const row = await this.scheduled.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { template: true, appointment: true },
    });
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Scheduled notification not found',
      });
    }
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateScheduledNotificationDto,
  ): Promise<ScheduledNotification> {
    const row = await this.findOne(tenantId, id);

    if (dto.templateId !== undefined) {
      if (dto.templateId) {
        await this.assertTemplate(tenantId, dto.templateId);
        row.template = { id: dto.templateId } as NotificationTemplate;
      } else {
        row.template = undefined;
      }
    }
    if (dto.appointmentId !== undefined) {
      if (dto.appointmentId) {
        await this.assertAppointment(tenantId, dto.appointmentId);
        row.appointment = { id: dto.appointmentId } as Appointment;
      } else {
        row.appointment = undefined;
      }
    }
    if (dto.recipientType !== undefined) row.recipient_type = dto.recipientType;
    if (dto.recipientId !== undefined) row.recipient_id = dto.recipientId;
    if (dto.scheduledAt !== undefined) row.scheduled_at = new Date(dto.scheduledAt);
    if (dto.status !== undefined) row.status = dto.status;

    return this.scheduled.save(row);
  }

  async cancel(tenantId: string, id: string): Promise<ScheduledNotification> {
    const row = await this.findOne(tenantId, id);
    if (!CANCELLABLE_STATUSES.includes(row.status as NotificationStatus)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A notification in status "${row.status}" cannot be cancelled`,
      });
    }
    row.status = NOTIFICATION_STATUS.CANCELLED;
    return this.scheduled.save(row);
  }

  async reschedule(
    tenantId: string,
    id: string,
    dto: RescheduleNotificationDto,
  ): Promise<ScheduledNotification> {
    const row = await this.findOne(tenantId, id);
    if (!RESCHEDULABLE_STATUSES.includes(row.status as NotificationStatus)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A notification in status "${row.status}" cannot be rescheduled`,
      });
    }
    row.scheduled_at = new Date(dto.scheduledAt);
    row.status = NOTIFICATION_STATUS.SCHEDULED;
    return this.scheduled.save(row);
  }

  /** Retries a failed notification (delegates the actual send to the dispatcher). */
  retry(tenantId: string, id: string) {
    return this.dispatch.retry(tenantId, id);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

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

  private async assertAppointment(tenantId: string, appointmentId: string): Promise<void> {
    const ok = await this.appointments.exists({
      where: { id: appointmentId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Appointment not found in this tenant',
      });
    }
  }
}
