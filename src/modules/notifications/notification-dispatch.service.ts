import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { Customer } from '../../entities/CRM/Customer';
import { AppError } from '../../common/errors';
import { scrubFailureReason } from '../../common/utils/log-scrubber.util';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';

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
import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { WhatsappTemplateService } from '../whatsapp/whatsapp-template.service';
import { NotificationVariableResolver } from './notification-variable-resolver.service';
import { AppError as AppErr, ErrorCode } from '../../common/errors';

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
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly logs: NotificationLogService,
    private readonly queue: QueueService,
    private readonly rateLimiter: TenantRateLimiterService,
    @Inject(forwardRef(() => WhatsappExecutionService))
    private readonly whatsapp: WhatsappExecutionService,
    private readonly config: ConfigService,
    private readonly channelFactory: NotificationChannelFactory,
    // Optional + last: a dispatcher built without them (older direct
    // constructions) simply skips template-variable binding.
    @Optional()
    @Inject(forwardRef(() => WhatsappTemplateService))
    private readonly whatsappTemplates?: WhatsappTemplateService,
    @Optional() private readonly variableResolver?: NotificationVariableResolver,
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
    // Existence check — replaces the old hardcoded `channel !== WHATSAPP`.
    // Anything the factory has no registered provider for (IN_APP, PUSH) is
    // still an immediate permanent failure; WHATSAPP and EMAIL both resolve.
    try {
      this.channelFactory.resolve(channel);
    } catch {
      return this.permanent(tenantId, notification, channel, `no provider for channel "${channel}"`, {
        skipReason: 'NO_PROVIDER',
      });
    }
    if (notification.recipient_type !== RECIPIENT_TYPE.CUSTOMER || !notification.recipient_id) {
      return this.permanent(tenantId, notification, channel, 'notifications require a CUSTOMER recipient', {
        skipReason: 'INVALID_RECIPIENT',
      });
    }

    const customer = await this.customers.findOne({
      where: { id: notification.recipient_id, tenant: { id: tenantId } },
    });
    if (!customer) {
      return this.permanent(tenantId, notification, channel, 'recipient customer not found', {
        skipReason: 'RECIPIENT_NOT_FOUND',
      });
    }

    // 2. CONSENT GATE — before channel selection (FR-G011), so a fallback can
    // never route around an opt-out. `WhatsappExecutionService` also checks
    // this for its own path (defense in depth); the EMAIL path has no
    // equivalent guard of its own, so this is now the ONLY gate for email.
    if (customer.opted_out_at) {
      return this.permanent(tenantId, notification, channel, 'recipient has opted out', {
        skipReason: 'OPTED_OUT',
      });
    }

    // 3. CHANNEL SELECTION — WhatsApp-first, email fallback (FR-G010).
    let resolvedChannel = channel;
    let providerTemplateId: string | undefined;
    if (channel === NOTIFICATION_CHANNEL.WHATSAPP) {
      providerTemplateId = await this.resolveProviderTemplateId(notification, customer);
      if (!providerTemplateId || !this.hasReachableWhatsappIdentity(customer)) {
        resolvedChannel = NOTIFICATION_CHANNEL.EMAIL;
      }
    }
    if (resolvedChannel === NOTIFICATION_CHANNEL.EMAIL && !customer.email) {
      return this.permanent(
        tenantId,
        notification,
        channel,
        'no channel could reach this recipient (no WhatsApp identity/template and no email)',
        { skipReason: 'UNREACHABLE' },
      );
    }

    // 4. RATE LIMIT (per tenant).
    const decision = await this.rateLimiter.consume(tenantId, 'notifications', {
      ratePerMinute: NOTIF_RATE_PER_MIN,
    });
    if (!decision.allowed) {
      await this.scheduled.update({ id }, { status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null });
      const retryAfterMs = decision.reason === 'RATE' ? decision.retryAfterMs : 60_000;
      return { status: 'rate_limited', retryAfterMs };
    }

    // 5. SEND-PHASE guard (at-most-once). Spans the WhatsApp attempt AND any
    // same-invocation email fallback below — both are still exactly one
    // guarded attempt, so a retry after either channel is contacted is
    // correctly treated as a possible duplicate.
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

    // 6. DELEGATE + 7. CLASSIFY.
    if (resolvedChannel === NOTIFICATION_CHANNEL.WHATSAPP) {
      return this.sendViaWhatsapp(tenantId, id, notification, customer, channel, providerTemplateId!);
    }
    return this.sendViaEmail(tenantId, id, notification, customer, channel);
  }

  /**
   * WhatsApp send, delegating to `WhatsappExecutionService` so its atomic
   * quota reservation and its own opt-out check stay on the single send seam
   * (research.md R3's second trap). A PERMANENT failure here (not a
   * transient one) falls back to email — WITHIN this same guarded attempt —
   * rather than terminal-failing outright, when the recipient has an email.
   */
  private async sendViaWhatsapp(
    tenantId: string,
    id: string,
    notification: ScheduledNotification,
    customer: Customer,
    originalChannel: string,
    providerTemplateId: string,
  ): Promise<DispatchOutcome> {
    let res;
    try {
      // Placeholder values come from the template's own binding, resolved
      // against trusted rows — see NotificationVariableResolver. An approved
      // template with `{{1}}`/`{{2}}` and no value for one of them is refused
      // HERE, with the placeholder named, instead of reaching Meta.
      let variables: Record<string, unknown> = {
        ...(notification.template?.variables ?? {}),
        ...(notification.variables ?? {}),
      };
      if (this.whatsappTemplates && this.variableResolver) {
        const waTemplate = await this.whatsappTemplates.findOne(tenantId, providerTemplateId);
        const resolved = await this.variableResolver.resolve(tenantId, waTemplate, {
          customer,
          appointmentId: notification.appointment?.id,
          supplied: variables,
        });
        if (resolved.unresolved.length > 0) {
          const names = resolved.unresolved
            .map((u) => `{{${u.placeholder}}}${u.source ? ` (${u.source})` : ''}`)
            .join(', ');
          throw new AppErr(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: `Template variable(s) could not be resolved: ${names}`,
          });
        }
        variables = resolved.variables;
      }
      const sendDto: SendTemplateMessageDto = {
        customerId: notification.recipient_id,
        variables,
      };
      res = await this.whatsapp.sendTemplateMessage(tenantId, providerTemplateId, sendDto);
    } catch (err) {
      // Scrubbed once, here: `reason` is stored on the notification, written to the
      // delivery log and returned in the outcome (residency plan P7).
      const reason = scrubFailureReason(
        err instanceof AppError ? err.message : (err as Error)?.message ?? 'send failed',
      );
      // T053 (S3, FR-M009) — a quota-exhausted send is PERMANENT but must
      // NEVER fall back to email: doing so would let a clinic evade its
      // WhatsApp plan limit for free by having every over-quota message
      // silently re-routed to an unmetered channel. Recorded with its own
      // skip_reason rather than falling through to the generic
      // attemptedChannel path below (T053's own requirement — "record
      // QUOTA_EXHAUSTED").
      if (err instanceof AppError && err.publicContext?.metric === USAGE_METRIC.WHATSAPP_MESSAGES) {
        return this.permanent(tenantId, notification, originalChannel, reason, {
          skipReason: 'QUOTA_EXHAUSTED',
        });
      }
      // Every other validation/account error is PERMANENT (no retry) — fall
      // back to email rather than terminal-failing, if the recipient has one.
      if (customer.email) {
        return this.sendViaEmail(tenantId, id, notification, customer, originalChannel);
      }
      return this.permanent(tenantId, notification, originalChannel, reason, {
        attemptedChannel: NOTIFICATION_CHANNEL.WHATSAPP,
      });
    }

    if (res?.status === 'SENT' && res.providerMessageId) {
      return this.markSent(tenantId, notification, NOTIFICATION_CHANNEL.WHATSAPP, res.providerMessageId);
    }

    // Returned FAILED = provider send failure → TRANSIENT: re-schedule + retry
    // (WhatsApp itself, not a fallback — a transient failure is expected to
    // succeed on the next attempt).
    const reason = 'whatsapp provider send failed';
    await this.scheduled.update(
      { id },
      { status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null, send_attempted: false, failure_reason: reason },
    );
    await this.logs.record(tenantId, {
      templateId: notification.template?.id,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      channel: originalChannel,
      status: NOTIFICATION_STATUS.FAILED,
      errorMessage: reason,
    });
    throw new TransientNotificationError(reason);
  }

  /** EMAIL send via the channel factory — used both as the direct EMAIL
   * channel and as the WhatsApp fallback path. */
  private async sendViaEmail(
    tenantId: string,
    id: string,
    notification: ScheduledNotification,
    customer: Customer,
    originalChannel: string,
  ): Promise<DispatchOutcome> {
    const provider = this.channelFactory.resolve(NOTIFICATION_CHANNEL.EMAIL);
    const content = { ar: notification.template?.content_ar, en: notification.template?.content_en };
    const result = await provider.send({
      tenantId,
      channel: NOTIFICATION_CHANNEL.EMAIL,
      recipientType: notification.recipient_type,
      recipientId: notification.recipient_id,
      recipientEmail: customer.email ?? undefined,
      templateId: notification.template?.id,
      appointmentId: notification.appointment?.id,
      contentAr: content.ar,
      contentEn: content.en,
      locale: customer.preferred_locale ?? this.config.get<string>('DEFAULT_LOCALE'),
    });

    if (result.success && result.providerRef) {
      return this.markSent(tenantId, notification, NOTIFICATION_CHANNEL.EMAIL, result.providerRef);
    }

    if (result.transient) {
      // Also becomes the TransientNotificationError message, i.e. the queue's failedReason.
      const reason = scrubFailureReason(result.error ?? 'email provider send failed');
      await this.scheduled.update(
        { id },
        { status: NOTIFICATION_STATUS.SCHEDULED, processing_at: null, send_attempted: false, failure_reason: reason },
      );
      await this.logs.record(tenantId, {
        templateId: notification.template?.id,
        recipientType: notification.recipient_type,
        recipientId: notification.recipient_id,
        channel: originalChannel,
        status: NOTIFICATION_STATUS.FAILED,
        errorMessage: reason,
      });
      throw new TransientNotificationError(reason);
    }

    return this.permanent(
      tenantId,
      notification,
      originalChannel,
      result.error ?? 'email provider send failed',
      { attemptedChannel: NOTIFICATION_CHANNEL.EMAIL },
    );
  }

  /** Loose validity check mirroring `MetaWhatsAppCloudProvider.normalizeMsisdn`'s
   *  own threshold — the dispatcher decides WHETHER to attempt WhatsApp at
   *  all before calling the send seam, so it needs the same notion of
   *  "reachable" without duplicating the provider's normalization logic. */
  private hasReachableWhatsappIdentity(customer: Customer): boolean {
    return (customer.phone ?? '').replace(/[^\d]/g, '').length >= 8;
  }

  /** DLQ reconcile: terminal FAILED so the sweep stops re-queuing it. */
  async markDeadLettered(tenantId: string, id: string, rawReason: string): Promise<void> {
    const reason = scrubFailureReason(rawReason);
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

  /**
   * T157/LG-8 — connects WhatsApp template LANGUAGE selection to the
   * recipient's locale CHOICE (FR-H015), using the existing template
   * language field (M-10's `provider_template_id_ar`, validated at
   * write-time in NotificationTemplateService to actually be an Arabic
   * WhatsappTemplate). Falls back to `provider_template_id` (the
   * pre-existing default) whenever the customer has no recorded preference,
   * prefers a language with no linked variant, or the customer has no
   * recorded preference — so a missing preference never blocks a send that
   * would otherwise have gone through. `customer` is loaded ONCE by the
   * caller (also needed for the consent gate and channel fallback), not
   * re-queried here.
   */
  private async resolveProviderTemplateId(
    notification: ScheduledNotification,
    customer: Customer,
  ): Promise<string | undefined> {
    const template = notification.template;
    if (template?.provider_template_id_ar) {
      const locale = customer.preferred_locale ?? this.config.get<string>('DEFAULT_LOCALE');
      if (locale === 'ar') return template.provider_template_id_ar;
    }
    return template?.provider_template_id;
  }

  /**
   * `channel` here is the channel that ACTUALLY carried the send (T015) —
   * may differ from the template's configured channel after a fallback
   * (T014), so this is what both the ScheduledNotification row and the log
   * record. This is the one place `channel` means "used", not "requested".
   */
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
          channel,
          skip_reason: null,
        },
      );
    } catch (err) {
      this.logger.warn(`provider_ref collision for notification=${notification.id} (reconciling): ${(err as Error)?.message}`);
      await this.scheduled.update(
        { id: notification.id, status: NOTIFICATION_STATUS.PROCESSING },
        {
          status: NOTIFICATION_STATUS.SENT,
          delivery_status: DELIVERY_STATUS.ACCEPTED,
          sent_at: new Date(),
          processing_at: null,
          channel,
        },
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

  /**
   * `channel` is the ORIGINAL requested channel (for the log — "what this
   * notification was for"). `attemptedChannel` is set only when a provider
   * genuinely attempted and failed (writes `channel` on the row); when
   * omitted, NO channel was ever tried and `skipReason` — a bounded,
   * non-secret label, never the raw `reason` text — is written instead
   * (T015).
   */
  private async permanent(
    tenantId: string,
    notification: ScheduledNotification,
    channel: string,
    reason: string,
    opts: { attemptedChannel?: string; skipReason?: string } = {},
  ): Promise<DispatchOutcome> {
    await this.scheduled.update(
      { id: notification.id },
      {
        status: NOTIFICATION_STATUS.FAILED,
        processing_at: null,
        failure_reason: reason,
        channel: opts.attemptedChannel ?? null,
        skip_reason: opts.attemptedChannel ? null : (opts.skipReason ?? 'UNKNOWN'),
      },
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
