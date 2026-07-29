import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { QueueService } from '../../queue/queue.service';
import { EmailSendJob } from '../../queue/job-data.interface';
import { EmailDeliveryService } from './email-delivery.service';
import { EmailTemplateKey } from './email.templates';

export interface SendEmailInput {
  to: string | string[];
  template: EmailTemplateKey;
  variables?: Record<string, unknown>;
  locale?: string;
  tenantId?: string | null;
  /** Dedupe key — same key never sends twice. */
  idempotencyKey?: string;
  replyTo?: string;
}

/**
 * The ONLY email entry point for the whole application. Business code calls a
 * typed method here (or `send`) and never touches a provider. Emails are queued
 * (retry + idempotency + rate limit via BullMQ) and delivered by the worker; set
 * `EMAIL_SYNC=true` to deliver inline (e.g. API-only deployments with no worker).
 *
 * Sending is BEST-EFFORT: a queue/delivery failure is logged and swallowed so it
 * can never break the business operation that triggered it (e.g. password reset).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly syncMode: boolean;

  constructor(
    private readonly queue: QueueService,
    private readonly delivery: EmailDeliveryService,
    config: ConfigService,
  ) {
    this.syncMode = config.get<string>('EMAIL_SYNC') === 'true';
  }

  /** Generic send — queue (default) or inline (sync mode). Never throws. */
  async send(input: SendEmailInput): Promise<void> {
    const job: EmailSendJob = {
      tenantId: input.tenantId ?? null,
      to: input.to,
      template: input.template,
      variables: input.variables,
      locale: input.locale,
      // A deterministic fallback (gap-closure pass — see
      // docs/CACHING_QUEUES_AUDIT.md §0.8.11 / original audit H5) so EVERY
      // send is protected by EmailDeliveryService's atomic claim, not just the
      // ones whose caller happened to supply an idempotencyKey. Several
      // senders below (`sendSubscriptionNotification`, `sendDoctorNotification`,
      // `sendPatientNotification`, `sendSecurityAlert`) never did.
      idempotencyKey: input.idempotencyKey ?? this.fallbackIdempotencyKey(input),
      replyTo: input.replyTo,
    };
    try {
      if (this.syncMode) await this.delivery.deliver(job);
      else await this.queue.enqueueEmail(job);
    } catch (err) {
      this.logger.error(
        `Failed to dispatch email "${input.template}" to ${Array.isArray(input.to) ? input.to.join(',') : input.to}: ${(err as Error)?.message}`,
      );
    }
  }

  // ── Typed business helpers (thin wrappers over `send`) ───────────────────

  sendWelcome(p: { to: string; name?: string; clinicName?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'welcome', variables: p, tenantId: p.tenantId, idempotencyKey: `welcome:${p.to}:${p.tenantId ?? ''}` });
  }

  sendVerification(p: { to: string; name?: string; verifyUrl: string; tenantId?: string; token?: string }) {
    return this.send({ to: p.to, template: 'email_verification', variables: p, tenantId: p.tenantId, idempotencyKey: p.token ? `verify:${p.token}` : undefined });
  }

  sendPasswordReset(p: { to: string; name?: string; resetUrl: string; tenantId?: string; token?: string }) {
    return this.send({ to: p.to, template: 'password_reset', variables: p, tenantId: p.tenantId, idempotencyKey: p.token ? `reset:${p.token}` : undefined });
  }

  sendAppointmentConfirmation(p: { to: string; name?: string; service?: string; dateTime: string; clinicName?: string; detailsUrl?: string; appointmentId?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'appointment_confirmation', variables: p, tenantId: p.tenantId, idempotencyKey: p.appointmentId ? `appt-confirm:${p.appointmentId}` : undefined });
  }

  sendAppointmentReminder(p: { to: string; name?: string; service?: string; dateTime: string; clinicName?: string; detailsUrl?: string; appointmentId?: string; when?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'appointment_reminder', variables: p, tenantId: p.tenantId, idempotencyKey: p.appointmentId ? `appt-remind:${p.appointmentId}:${p.when ?? ''}` : undefined });
  }

  sendInvoice(p: { to: string; name?: string; invoiceNumber?: string; amount: string; planName?: string; invoiceUrl?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'subscription_invoice', variables: p, tenantId: p.tenantId, idempotencyKey: p.invoiceNumber ? `invoice:${p.invoiceNumber}` : undefined });
  }

  sendPaymentFailed(p: { to: string; name?: string; amount: string; reason?: string; tenantId?: string; paymentId?: string }) {
    return this.send({ to: p.to, template: 'payment_failed', variables: p, tenantId: p.tenantId, idempotencyKey: p.paymentId ? `pay-failed:${p.paymentId}` : undefined });
  }

  sendTrialEnding(p: { to: string; name?: string; daysLeft?: number; tenantId?: string }) {
    return this.send({ to: p.to, template: 'trial_ending', variables: p, tenantId: p.tenantId, idempotencyKey: p.tenantId ? `trial-end:${p.tenantId}:${p.daysLeft ?? ''}` : undefined });
  }

  sendInvitation(p: { to: string; name?: string; inviterName?: string; clinicName?: string; role?: string; invitationUrl: string; tenantId?: string; token?: string }) {
    return this.send({ to: p.to, template: 'staff_invitation', variables: p, tenantId: p.tenantId, idempotencyKey: p.token ? `invite:${p.token}` : undefined });
  }

  sendSubscriptionNotification(p: { to: string; name?: string; event: 'activated' | 'renewed' | 'cancelled'; planName?: string; nextRenewal?: string; endsAt?: string; tenantId?: string }) {
    const template = (
      { activated: 'subscription_activated', renewed: 'subscription_renewed', cancelled: 'subscription_cancelled' } as const
    )[p.event];
    return this.send({ to: p.to, template, variables: p, tenantId: p.tenantId });
  }

  sendDoctorNotification(p: { to: string; name?: string; title?: string; message: string; actionUrl?: string; actionLabel?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'doctor_notification', variables: p, tenantId: p.tenantId });
  }

  sendPatientNotification(p: { to: string; name?: string; title?: string; message: string; actionUrl?: string; actionLabel?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'patient_notification', variables: p, tenantId: p.tenantId });
  }

  sendSecurityAlert(p: { to: string; name?: string; message: string; actionUrl?: string; tenantId?: string }) {
    return this.send({ to: p.to, template: 'security_alert', variables: p, tenantId: p.tenantId });
  }

  /**
   * Content-addressed fallback (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.11): hashes template + recipient +
   * tenant + the FULL variables payload, not just template+recipient. Two
   * calls with the SAME content (an exact redelivery) collapse to one send;
   * two calls with genuinely DIFFERENT content (a different message to the
   * same doctor using the same template) get different keys and both send —
   * a key that ignored `variables` would wrongly drop the second one.
   */
  private fallbackIdempotencyKey(input: SendEmailInput): string {
    const recipient = Array.isArray(input.to) ? [...input.to].sort().join(',') : input.to;
    const payload = `${input.template}:${recipient}:${input.tenantId ?? ''}:${JSON.stringify(input.variables ?? {})}`;
    return `auto:${createHash('sha256').update(payload).digest('hex')}`;
  }
}
