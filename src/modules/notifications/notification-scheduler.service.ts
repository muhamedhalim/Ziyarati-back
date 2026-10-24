import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  In,
  LessThan,
  Like,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { NotificationTemplate } from '../../entities/Notifications/NotificationTemplate';
import { NotificationRule } from '../../entities/Notifications/NotificationRule';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { NotificationDispatchService } from './notification-dispatch.service';
import { QueueService } from '../../queue/queue.service';
import {
  NotificationAuditService,
  NOTIFICATION_AUDIT_ACTION,
} from './notification-audit.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ScheduleNotificationDto } from './dto/schedule-notification.dto';
import { UpdateScheduledNotificationDto } from './dto/update-scheduled-notification.dto';
import { RescheduleNotificationDto } from './dto/reschedule-notification.dto';
import { ScheduledNotificationFilterDto } from './dto/scheduled-notification-filter.dto';
import {
  CANCELLABLE_STATUSES,
  NOTIFICATION_STATUS,
  RESCHEDULABLE_STATUSES,
  RETRYABLE_STATUSES,
  NotificationStatus,
} from './notification.constants';

const PG_UNIQUE_VIOLATION = '23505';

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
    private readonly queue: QueueService,
    private readonly audit: NotificationAuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `sourceRef` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11) is
   * an INTERNAL-only business key — deliberately not part of
   * `ScheduleNotificationDto`, so the public HTTP endpoint's contract is
   * unchanged. Passed by callers that can be retried for the SAME logical
   * request (e.g. the workflow engine's NOTIFICATION action, keyed
   * `workflow-action:{runId}:{actionIndex}`): a retry with the same
   * `sourceRef` hits the partial-unique index on `scheduled_notifications`
   * and returns the ALREADY-CREATED row instead of inserting a second one
   * that would be dispatched independently. Without this, a workflow action
   * reclaimed after a crash (side effect already run, terminal result not yet
   * recorded — see `WorkflowService.claimAction`) would schedule — and
   * eventually send — the same notification twice, since each row has its own
   * independent send lifecycle.
   */
  async schedule(
    tenantId: string,
    dto: ScheduleNotificationDto,
    sourceRef?: string,
    // Spec 014 (Clinic Platform Completion) — T032. INTERNAL-only, same
    // reasoning as `sourceRef` above: deliberately not part of
    // `ScheduleNotificationDto`, so the public HTTP contract is unchanged.
    // Lets a caller (e.g. `NotificationEventListener` on
    // `appointment.confirmed`) attach per-notification template variables —
    // a `cancelUrl`, for instance — without a template author having to
    // template-author "the appointment's own values" a second time.
    variables?: Record<string, unknown>,
    // INTERNAL-only, like `sourceRef`: the rule that produced this row, so a rule's
    // counts and execution list are exact. Never part of the public DTO.
    ruleId?: string,
  ): Promise<ScheduledNotification> {
    if (dto.templateId) await this.assertTemplate(tenantId, dto.templateId);
    if (dto.appointmentId)
      await this.assertAppointment(tenantId, dto.appointmentId);

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
      source_ref: sourceRef,
      variables,
      notification_rule: ruleId
        ? ({ id: ruleId } as NotificationRule)
        : undefined,
    });

    let saved: ScheduledNotification;
    try {
      saved = await this.scheduled.save(row);
    } catch (err) {
      if (
        sourceRef &&
        (err as { code?: string })?.code === PG_UNIQUE_VIOLATION
      ) {
        const existing = await this.scheduled.findOne({
          where: { source_ref: sourceRef },
        });
        // Already scheduled by a prior attempt for this EXACT business
        // operation — return it as-is, WITHOUT enqueuing a second dispatch
        // job (the first `schedule()` call already did that).
        if (existing) return existing;
      }
      throw err;
    }
    // Produce a DELAYED dispatch job; BullMQ fires it at scheduled_at. The worker
    // performs the send (NotificationDispatchService) — no in-process scheduler.
    await this.enqueueDispatch(tenantId, saved.id, saved.scheduled_at);
    return saved;
  }

  /**
   * Cancels the PENDING rows whose `source_ref` matches `likePattern` (and their
   * queued jobs), recording why. Only rows that have not started sending are
   * touched; a row already PROCESSING is left to the dispatcher's own re-check.
   * Tenant-scoped.
   */
  async cancelRuleRows(tenantId: string, likePattern: string): Promise<number> {
    const rows = await this.scheduled.find({
      where: {
        tenant: { id: tenantId },
        source_ref: Like(likePattern),
        status: In([
          NOTIFICATION_STATUS.PENDING,
          NOTIFICATION_STATUS.SCHEDULED,
        ]),
      },
      select: { id: true },
    });
    for (const row of rows) {
      await this.scheduled.update(
        {
          id: row.id,
          status: In([
            NOTIFICATION_STATUS.PENDING,
            NOTIFICATION_STATUS.SCHEDULED,
          ]),
        },
        {
          status: NOTIFICATION_STATUS.CANCELLED,
          skip_reason: 'APPOINTMENT_CHANGED',
        },
      );
      await this.queue.removeNotificationDispatch(row.id);
    }
    return rows.length;
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
    const scheduleChanged = dto.scheduledAt !== undefined;
    if (scheduleChanged) row.scheduled_at = new Date(dto.scheduledAt as string);
    // NOTE: `status` is the worker-owned send lifecycle — it is intentionally NOT
    // accepted from clients here (use schedule/cancel/reschedule/retry endpoints).

    const saved = await this.scheduled.save(row);
    // Keep the delayed job in sync when the time moved.
    if (scheduleChanged) {
      await this.queue.removeNotificationDispatch(saved.id);
      await this.enqueueDispatch(tenantId, saved.id, saved.scheduled_at);
    }
    return saved;
  }

  async cancel(tenantId: string, id: string): Promise<ScheduledNotification> {
    const row = await this.findOne(tenantId, id);
    if (!CANCELLABLE_STATUSES.includes(row.status as NotificationStatus)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A notification in status "${row.status}" cannot be cancelled`,
      });
    }
    row.status = NOTIFICATION_STATUS.CANCELLED;
    const saved = await this.scheduled.save(row);
    await this.queue.removeNotificationDispatch(id); // keep the queue consistent
    return saved;
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
    const saved = await this.scheduled.save(row);
    // Replace the old delayed job with one for the new time.
    await this.queue.removeNotificationDispatch(id);
    await this.enqueueDispatch(tenantId, saved.id, saved.scheduled_at);
    return saved;
  }

  /**
   * Retries a FAILED notification by ENQUEUING a fresh dispatch job; the worker
   * performs the actual send (NotificationDispatchService.processScheduled).
   * Asynchronous by design — returns a queue acknowledgement, not the delivery
   * result. The dispatcher itself remains the single send seam (reused, not
   * reimplemented).
   *
   * AD-03 (FND-013): this is the ONE place permitted to clear the at-most-once
   * `send_attempted` guard. Doing so here — an explicit, audited operator
   * action — is safe in a way an automated sweep clearing it never would be:
   * the operator is asserting the prior attempt did not reach the customer
   * (typically after checking the provider console), and is accountable for
   * that call. Every retry is audited, regardless of the row's prior
   * `send_attempted` value, since a retry is itself a sensitive action
   * (constitution Principle XXVI).
   */
  async retry(tenantId: string, id: string) {
    const row = await this.findOne(tenantId, id);
    if (!RETRYABLE_STATUSES.includes(row.status as NotificationStatus)) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Only failed or send-uncertain notifications can be retried',
        publicContext: { currentStatus: row.status },
      });
    }
    // Reset to SCHEDULED so the worker's atomic claim (SCHEDULED/PENDING only)
    // will pick it up; clear the prior failure + provider_ref for a clean
    // attempt, AND clear send_attempted so the dispatcher's send-phase guard
    // does not immediately re-reject this as a duplicate. `findOne` above
    // already verified tenant ownership, so update by id is safe.
    await this.scheduled.update(
      { id },
      {
        status: NOTIFICATION_STATUS.SCHEDULED,
        processing_at: null,
        failure_reason: null,
        provider_ref: null,
        send_attempted: false,
      },
    );
    await this.audit.record(
      NOTIFICATION_AUDIT_ACTION.RETRY_OVERRIDE,
      tenantId,
      this.tenantContext.getUser()?.id,
      id,
      { previousStatus: row.status, previousSendAttempted: row.send_attempted },
    );
    const job = await this.queue.retryNotificationDispatch({
      tenantId,
      notificationId: id,
    });
    return { queued: true, notificationId: id, jobId: job.id };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Enqueue a delayed dispatch job that fires at `scheduledAt`. */
  private async enqueueDispatch(
    tenantId: string,
    notificationId: string,
    scheduledAt: Date,
  ): Promise<void> {
    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    await this.queue.enqueueNotificationDispatch(
      { tenantId, notificationId },
      { delay },
    );
  }

  private async assertTemplate(
    tenantId: string,
    templateId: string,
  ): Promise<void> {
    const ok = await this.templates.exists({
      where: { id: templateId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Template not found in this tenant',
      });
    }
  }

  private async assertAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
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
