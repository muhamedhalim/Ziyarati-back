import { Injectable, Logger } from '@nestjs/common';

import {
  WhatsappMessageProvider,
  WhatsappSendPayload,
  WhatsappSendResult,
} from './whatsapp-message.provider.interface';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';

/**
 * REAL Meta WhatsApp Cloud API provider.
 *
 * Resolves PER-TENANT credentials (phone number id + access token) from the
 * routed account via WhatsappAccountResolver — never a single hardcoded number.
 * Sends an approved TEMPLATE message (the only message type Meta allows for
 * business-initiated notifications outside the 24h window) and returns the
 * `wamid` as `providerMessageId`. Never throws for expected failures.
 */
@Injectable()
export class MetaWhatsappProvider implements WhatsappMessageProvider {
  readonly name = 'meta-whatsapp-cloud';
  private readonly logger = new Logger('MetaWhatsappProvider');
  private readonly version = process.env.WHATSAPP_API_VERSION ?? 'v21.0';
  private readonly timeoutMs = Number(process.env.WHATSAPP_HTTP_TIMEOUT_MS ?? '10000');

  constructor(private readonly resolver: WhatsappAccountResolver) {}

  /** Handles every WhatsApp send (the strict factory never falls back to noop). */
  supports(): boolean {
    return true;
  }

  async send(payload: WhatsappSendPayload): Promise<WhatsappSendResult> {
    // Re-resolve the account to obtain the (secret) access token — payloads carry
    // no secrets, so credentials are fetched here, tenant-scoped.
    let phoneNumberId = payload.phoneNumberId;
    let accessToken: string | undefined;
    try {
      const account =
        payload.accountId && payload.accountId !== 'platform-env'
          ? await this.resolver.byId(payload.tenantId, payload.accountId)
          : this.resolver.envPlatform();
      if (account) {
        phoneNumberId = account.phoneNumberId ?? phoneNumberId;
        accessToken = account.accessToken;
      }
    } catch (err) {
      return { success: false, error: `account resolution failed: ${(err as Error)?.message}` };
    }

    if (!phoneNumberId || !accessToken) {
      return { success: false, error: 'WhatsApp account has no phone_number_id / access_token' };
    }

    const url = `https://graph.facebook.com/${this.version}/${phoneNumberId}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: this.normalize(payload.to),
          type: 'template',
          template: {
            name: payload.templateName,
            language: { code: payload.language || 'ar' },
            components: this.buildComponents(payload.variables),
          },
        }),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as MetaResponse;
      if (res.ok) {
        const id = json.messages?.[0]?.id;
        return id
          ? { success: true, providerMessageId: id }
          : { success: false, error: 'Meta accepted but returned no message id' };
      }
      const errMsg = json.error?.message ?? `Meta API HTTP ${res.status}`;
      this.logger.warn(`Meta template send failed (${res.status}): ${errMsg}`);
      return { success: false, error: `${res.status}: ${errMsg}` };
    } catch (err) {
      const message = (err as Error)?.name === 'AbortError' ? 'Meta API timeout' : (err as Error)?.message;
      return { success: false, error: message ?? 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map ordered variables → a single template body component. */
  private buildComponents(variables?: Record<string, unknown>) {
    if (!variables || Object.keys(variables).length === 0) return undefined;
    return [
      {
        type: 'body',
        parameters: Object.values(variables).map((v) => ({ type: 'text', text: String(v) })),
      },
    ];
  }

  private normalize(phone: string): string {
    return (phone ?? '').replace(/[^\d]/g, '');
  }
}

interface MetaResponse {
  messages?: { id: string }[];
  error?: { message?: string; code?: number };
}
