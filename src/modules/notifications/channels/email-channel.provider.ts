import { Injectable } from '@nestjs/common';

import {
  DeliveryResult,
  NotificationChannelProvider,
  NotificationPayload,
} from './notification-channel.interface';
import { NOTIFICATION_CHANNEL } from '../notification.constants';
import { EmailProviderFactory } from '../../email/providers/email-provider.factory';

/**
 * Real EMAIL channel provider (T013) — gives clinics without Meta WhatsApp
 * approval a reachable second channel (S2, FR-G010's fallback path).
 *
 * Delegates to the EXISTING `EmailProviderFactory` / provider layer rather
 * than `EmailDeliveryService` (that service owns the `email.send` QUEUE
 * JOB's own idempotency-claim + EmailLog bookkeeping — a different call
 * path from the notification dispatcher, which does its own at-most-once
 * guard before ever reaching a channel provider).
 *
 * FAILS CLOSED: an explicitly selected EMAIL channel must not report a fake
 * success. `EmailProviderFactory.resolve()` on its own falls back to a
 * no-op provider when email is disabled or unconfigured (by design, for the
 * direct `EmailService.send` path) — this provider checks
 * `isLiveDelivery()` first and returns a PERMANENT failure instead of
 * silently going through that no-op.
 */
@Injectable()
export class EmailChannelProvider implements NotificationChannelProvider {
  readonly name = 'email';

  constructor(private readonly providerFactory: EmailProviderFactory) {}

  supports(channel?: string): boolean {
    return channel === NOTIFICATION_CHANNEL.EMAIL;
  }

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    if (!payload.recipientEmail) {
      return { success: false, error: 'recipient has no email address', transient: false };
    }
    if (!this.providerFactory.isLiveDelivery()) {
      return {
        success: false,
        error: 'email delivery is not configured (no live provider)',
        transient: false,
      };
    }

    const body =
      (payload.locale === 'en' ? payload.contentEn : payload.contentAr) ??
      payload.contentEn ??
      payload.contentAr ??
      '';
    if (!body) {
      return { success: false, error: 'notification has empty content', transient: false };
    }

    const provider = this.providerFactory.resolve();
    const result = await provider.send({
      to: payload.recipientEmail,
      subject: this.subjectFrom(body),
      html: this.toHtml(body),
      text: body,
    });

    return {
      success: result.success,
      providerRef: result.providerMessageId,
      error: result.error,
      transient: result.transient,
    };
  }

  /** First line of the body, truncated — templates carry no separate subject field. */
  private subjectFrom(body: string): string {
    const firstLine = body.split('\n')[0].trim();
    return firstLine.length > 0 ? firstLine.slice(0, 120) : 'Notification';
  }

  private toHtml(body: string): string {
    const escaped = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<p>${escaped.replace(/\n/g, '<br/>')}</p>`;
  }
}
