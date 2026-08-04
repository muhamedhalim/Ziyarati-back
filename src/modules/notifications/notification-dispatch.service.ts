import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { AppError } from '../../common/errors';

import { NotificationLogService } from './notification-log.service';
import {
  CLAIMABLE_STATUSES,
  DELIVERY_STATUS,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
  PROCESSING_STALE_MS,
  RECIPIENT_TYPE,
} from './notification.constants';
import { TransientNotificationError } from './notification-dispatch.errors';
import { QueueService } from '../../queue/queue.service';
import { TenantRateLimiterService } from '../../queue/tenant-rate-limiter.service';
import { WhatsappExecutionService } from '../whatsapp/whatsapp-execution.service';
import { SendTemplateMessageDto } from '../whatsapp/dto/send-template-message.dto';

export type DispatchOutcome =
  | { status: 'sent'; providerRef: string }
  | { status: 'failed_permanent'; reason: string }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'noop'; reason: string };

const NOTIF_RATE_PER_MIN = Number(process.env.NOTIF_RATE_PER_MIN ?? '120');
const LOG_RETENTION_DAYS = Number(process.env.NOTIF_LOG_RETENTION_DAYS ?? '90');

/**
 * Per-notification send seam.
 *
 *   1. CLAIM         — atomic `SCHEDULED/PENDING → PROCESSING` (tenant-scoped).
 *   2. RATE LIMIT    — per-tenant token bucket (RATE → defer, no attempt burned).
 *   3. SEND-PHASE    — atomic `send_attempted false→true` guard. If already true
 *                      (a prior attempt reached send), DO NOT re-send → prevents
 *                      the crash-after-accept duplicate (at-most-once).
 *   4. DELEGATE      — WhatsappExecutionService.sendTemplateMessage: per-tenant
 *                      account (resolver) + APPROVED template + recipient + quota.
 *   5. CLASSIFY      — SENT → store provider_ref; thrown (validation/quota/account)
 *                      → PERMANENT; returned-FAILED (provider send) → TRANSIENT
 *                      (re-SCHEDULE + throw → BullMQ retry; exhausted → DLQ).
 *
 * Idempotency floors: deterministic jobId, the CLAIM, the `send_attempted` guard,
 * and the UNIQUE `provider_ref`.
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger('NotificationDispatchService');

  constructor(
    @InjectRepository(ScheduledNotification)
    private readonly scheduled: Repository<ScheduledNotification>,
    private readonly logs: NotificationLogService,
    private readonly queue: QueueService,
    private readonly rateLimiter: TenantRateLimiterService,
    @Inject(forwardRef(() => WhatsappExecutionService))
    private readonly whatsapp: WhatsappExecutionService,
  ) {}

  async processScheduled(tenantId: string, id: string): Promise<DispatchOutcome> {
    // 1. CLAIM
    const claim = await this.scheduled
      .createQueryBuilder()
      .update(ScheduledNotification)
      .set({ status: NOTIFICATION_STATUS.PROCESSING, attempts: () => 'attempts + 1', processing_at: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('status IN (:...claimable)', { claimable: CLAIMABLE_STATUSES })
      .execute();
    if ((claim.affected ?? 0) === 0) return { status: 'noop', reason: 'already-claimed-or-terminal' };

    const notification = await this.scheduled.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { template: true, appointment: true },
    });
    if (!notification) return { status: 'noop', reason: 'vanished' };

    const channel = notification.template?.channel ?? NOTIFICATION_CHANNEL.IN_APP;
    if (channel !== NOTIFICATION_CHANNEL.WHATSAPP) {
      return this.permanent(tenantId, notification, channel, `no provider for channel "${channel}"`);
    }
    const providerTemplateId = notification.template?.provider_template_id;
    if (!providerTemplateId) {
      return this.permanent(tenantId, notification, channel, 'template not linked to an approved WhatsApp template');
    }
    if (notification.recipient_type !== RECIPIENT_TYPE.CUSTOMER || !notification.recipient_id) {
      return this.permanent(tenantId, notification, channel, 'WhatsApp notifications require a CUSTOMER recipient');
    }

    // 2. RATE LIMIT (per tenant).
    const decision = await this.rateLimiter.consume(tenantId, 'notifications', {
      ratePerMinute: NOTIF_RATE_PER_MIN,
    });
    if (!decision.allowed) {
      await this.scheduled.update({ id }, { status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null });
      const retryAfterMs = decision.reason === 'RATE' ? decision.retryAfterMs : 60_000;
      return { status: 'rate_limited', retryAfterMs };
    }

    // 3. SEND-PHASE guard (at-most-once).
    const enter = await this.scheduled.update(
      { id, send_attempted: false },
      { send_attempted: true },
    );
    if ((enter.affected ?? 0) === 0) {
      // A prior attempt already entered the send phase → may have sent. Do NOT
      // re-send; settle terminal and let the delivery webhook reflect reality.
      await this.scheduled.update(
        { id },
        { status: NOTIFICATION_STATUS.FAILED, processing_at: null, failure_reason: 'duplicate-send-prevented' },
      );
      return { status: 'noop', reason: 'duplicate-send-prevented' };
    }

    // 4. DELEGATE to the WhatsApp send path (per-tenant account + template + quota).
    const sendDto: SendTemplateMessageDto = {
      customerId: notification.recipient_id,
      variables: { ...(notification.template?.variables ?? {}), ...(notification.variables ?? {}) },
    };
    let res;
    try {
      res = await this.whatsapp.sendTemplateMessage(tenantId, providerTemplateId, sendDto);
    } catch (err) {
      // Validation / quota / account errors are PERMANENT (no retry).
      const reason = err instanceof AppError ? err.message : (err as Error)?.message ?? 'send failed';
      return this.permanent(tenantId, notification, channel, reason);
    }

    // 5. CLASSIFY.
    if (res?.status === 'SENT' && res.providerMessageId) {
      return this.markSent(tenantId, notification, channel, res.providerMessageId);
    }

    // Returned FAILED = provider send failure → TRANSIENT: re-schedule + retry.
    const reason = 'whatsapp provider send failed';
    await this.scheduled.update(
      { id },
      { status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null, send_attempted: false, failure_reason: reason },
    );
    await this.logs.record(tenantId, {
      templateId: notification.template?.id,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      channel,
      status: NOTIFICATION_STATUS.FAILED,
      errorMessage: reason,
    });
    throw new TransientNotificationError(reason);
  }

  /** DLQ reconcile: terminal FAILED so the sweep stops re-queuing it. */
  async markDeadLettered(tenantId: string, id: string, reason: string): Promise<void> {
    const res = await this.scheduled
      .createQueryBuilder()
      .update(ScheduledNotification)
      .set({ status: NOTIFICATION_STATUS.FAILED, processing_at: null, failure_reason: reason })
      .where('id = :id', { id })
      .andWhere('"tenantId" = :tenantId', { tenantId })
      .andWhere('status IN (:...notTerminal)', {
        notTerminal: [NOTIFICATION_STATUS.PROCESSING, NOTIFICATION_STATUS.SCHEDULED],
      })
      .execute();
    if ((res.affected ?? 0) > 0) {
      await this.logs.record(tenantId, { status: NOTIFICATION_STATUS.FAILED, errorMessage: `dead-lettered: ${reason}` });
    }
  }

  /**
   * Maintenance sweep: reclaim stale PROCESSING, re-enqueue due rows, purge
   * old logs.
   *
   * FND-013/AD-03: stale-PROCESSING rows split into two disjoint groups by
   * `send_attempted`. A row that never reached the send-phase guard
   * (`send_attempted=false`) is safe to resume automatically — it's exactly
   * as if it had never been claimed. A row that DID reach the guard
   * (`send_attempted=true`) may have already sent; resetting it to SCHEDULED
   * would let the worker re-claim it, hit the guard, and cycle forever as
   * `duplicate-send-prevented` with no operator-visible way out — the
   * defect this fix closes. Such rows are routed to SEND_UNCERTAIN instead,
   * a distinct terminal state an operator can inspect and, if the provider
   * console confirms no send occurred, force via the audited retry() override.
   */
  async reapAndRequeue(
    batch = 1000,
  ): Promise<{ reclaimed: number; strandedForReview: number; requeued: number; purgedLogs: number }> {
    const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
    const reclaim = await this.scheduled
      .createQueryBuilder()
      .update(ScheduledNotification)
      .set({ status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null })
      .where('status = :proc', { proc: NOTIFICATION_STATUS.PROCESSING })
      .andWhere('processing_at < :staleBefore', { staleBefore })
      .andWhere('send_attempted = :attempted', { attempted: false })
      .execute();

    const strand = await this.scheduled
      .createQueryBuilder()
      .update(ScheduledNotification)
      .set({
        status: NOTIFICATION_STATUS.SEND_UNCERTAIN,
        processing_at: null,
        failure_reason: 'stale-processing-after-send-attempt: verify with the provider before retrying',
      })
      .where('status = :proc', { proc: NOTIFICATION_STATUS.PROCESSING })
      .andWhere('processing_at < :staleBefore', { staleBefore })
      .andWhere('send_attempted = :attempted', { attempted: true })
      .execute();

    const due = await this.scheduled
      .createQueryBuilder('n')
      .select('n.id', 'id')
      .addSelect('n."tenantId"', 'tenantId')
      .where('n.status = :sched', { sched: NOTIFICATION_STATUS.SCHEDULED })
      .andWhere('n.scheduled_at <= now()')
      .orderBy('n.scheduled_at', 'ASC')
      .limit(batch)
      .getRawMany<{ id: string; tenantId: string }>();
    if (due.length > 0) {
      await this.queue.enqueueNotificationDispatchBulk(
        due.filter((r) => r.tenantId).map((r) => ({ tenantId: r.tenantId, notificationId: r.id })),
      );
    }

    const purgedLogs = await this.logs.purgeOlderThan(LOG_RETENTION_DAYS, 5000);
    return {
      reclaimed: reclaim.affected ?? 0,
      strandedForReview: strand.affected ?? 0,
      requeued: due.length,
      purgedLogs,
    };
  }

  // ──────────────────────────── helpers ──────────────────────────── //

  private async markSent(
    tenantId: string,
    notification: ScheduledNotification,
    channel: string,
    providerRef: string,
  ): Promise<DispatchOutcome> {
    try {
      await this.scheduled.update(
        { id: notification.id },
        {
          status: NOTIFICATION_STATUS.SENT,
          delivery_status: DELIVERY_STATUS.ACCEPTED,
          provider_ref: providerRef,
          sent_at: new Date(),
          processing_at: null,
          failure_reason: null,
        },
      );
    } catch (err) {
      this.logger.warn(`provider_ref collision for notification=${notification.id} (reconciling): ${(err as Error)?.message}`);
      await this.scheduled.update(
        { id: notification.id, status: NOTIFICATION_STATUS.PROCESSING },
        { status: NOTIFICATION_STATUS.SENT, delivery_status: DELIVERY_STATUS.ACCEPTED, sent_at: new Date(), processing_at: null },
      );
    }
    await this.logs.record(tenantId, {
      templateId: notification.template?.id,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      channel,
      status: NOTIFICATION_STATUS.SENT,
      providerRef,
      sentAt: new Date(),
    });
    return { status: 'sent', providerRef };
  }

  private async permanent(
    tenantId: string,
    notification: ScheduledNotification,
    channel: string,
    reason: string,
  ): Promise<DispatchOutcome> {
    await this.scheduled.update(
      { id: notification.id },
      { status: NOTIFICATION_STATUS.FAILED, processing_at: null, failure_reason: reason },
    );
    await this.logs.record(tenantId, {
      templateId: notification.template?.id,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      channel,
      status: NOTIFICATION_STATUS.FAILED,
      errorMessage: reason,
    });
    return { status: 'failed_permanent', reason };
  }
}
