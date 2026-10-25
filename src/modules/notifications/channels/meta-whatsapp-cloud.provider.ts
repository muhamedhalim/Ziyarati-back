import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DeliveryResult,
  NotificationChannelProvider,
  NotificationPayload,
} from './notification-channel.interface';
import { NOTIFICATION_CHANNEL } from '../notification.constants';

/**
 * REAL Meta WhatsApp Cloud API provider (Graph API).
 *
 * Sends a session text message via `POST /{version}/{phoneNumberId}/messages`
 * and returns the provider message id (`wamid...`) as `providerRef`. Delivery
 * state transitions (sent/delivered/read/failed) arrive asynchronously on the
 * webhook and are applied by NotificationDeliveryService.
 *
 * Failure handling is explicit: HTTP 429 / 5xx / network = TRANSIENT (retry);
 * 4xx (bad number, invalid token, template/policy) = PERMANENT (no retry).
 *
 * DO NOT USE TO SEND CLINIC MESSAGES. It reads ONE platform-wide
 * `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN`, so a message sent here
 * would leave from the platform's number, not the clinic's connected account.
 * It is registered only so `NotificationChannelFactory` recognises WHATSAPP as a
 * supported channel; `NotificationDispatchService` sends WhatsApp exclusively
 * through `WhatsappExecutionService` (per-tenant account, template state, quota
 * and consent), and a spec pins that. Route a send through this class only
 * after it resolves the tenant's account the same way.
 */
@Injectable()
export class MetaWhatsAppCloudProvider implements NotificationChannelProvider {
  readonly name = 'meta-whatsapp-cloud';
  private readonly logger = new Logger('MetaWhatsAppCloudProvider');

  private readonly version: string;
  private readonly phoneNumberId?: string;
  private readonly accessToken?: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.version = config.get<string>('WHATSAPP_API_VERSION', 'v21.0') ?? 'v21.0';
    this.phoneNumberId = config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = config.get<string>('WHATSAPP_ACCESS_TOKEN');
    this.timeoutMs = Number(config.get<string>('WHATSAPP_HTTP_TIMEOUT_MS') ?? '10000');
  }

  supports(channel?: string): boolean {
    return channel === NOTIFICATION_CHANNEL.WHATSAPP;
  }

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    if (!this.phoneNumberId || !this.accessToken) {
      // Misconfiguration is PERMANENT — fail loud, never silently "succeed".
      return {
        success: false,
        error: 'WhatsApp Cloud API not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN missing)',
        transient: false,
      };
    }
    const to = this.normalizeMsisdn(payload.recipientPhone);
    if (!to) {
      return { success: false, error: 'recipient has no valid WhatsApp number', transient: false };
    }

    const body = (payload.locale === 'en' ? payload.contentEn : payload.contentAr)
      ?? payload.contentEn
      ?? payload.contentAr
      ?? '';
    if (!body) {
      return { success: false, error: 'notification has empty content', transient: false };
    }

    const url = `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body },
        }),
        signal: controller.signal,
      });

      const json = (await res.json().catch(() => ({}))) as MetaResponse;

      if (res.ok) {
        const providerRef = json.messages?.[0]?.id;
        if (!providerRef) {
          return { success: false, error: 'Meta accepted but returned no message id', transient: true };
        }
        return { success: true, providerRef };
      }

      // Non-2xx → classify by HTTP status.
      const errMsg = json.error?.message ?? `Meta API HTTP ${res.status}`;
      const transient = res.status === 429 || res.status >= 500;
      this.logger.warn(`Meta send failed (${res.status}, transient=${transient}): ${errMsg}`);
      return { success: false, error: `${res.status}: ${errMsg}`, transient };
    } catch (err) {
      // Network/timeout/abort → TRANSIENT.
      const message = (err as Error)?.name === 'AbortError' ? 'Meta API timeout' : (err as Error)?.message;
      this.logger.warn(`Meta send threw (transient): ${message}`);
      return { success: false, error: message ?? 'network error', transient: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Strip non-digits; WhatsApp expects MSISDN without '+'. */
  private normalizeMsisdn(phone?: string): string | null {
    if (!phone) return null;
    const digits = phone.replace(/[^\d]/g, '');
    return digits.length >= 8 ? digits : null;
  }
}

interface MetaResponse {
  messages?: { id: string }[];
  error?: { message?: string; code?: number; type?: string };
}
