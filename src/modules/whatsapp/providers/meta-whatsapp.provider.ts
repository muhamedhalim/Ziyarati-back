import { Injectable, Logger } from '@nestjs/common';

import {
  WhatsappMessageProvider,
  WhatsappSendPayload,
  WhatsappSendResult,
  WhatsappSessionPayload,
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
    return this.dispatch(payload.tenantId, payload.accountId, payload.phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.normalize(payload.to),
      type: 'template',
      template: {
        name: payload.templateName,
        language: { code: payload.language || 'ar' },
        components: this.buildComponents(payload.variables),
      },
    });
  }

  /**
   * Free-form session reply (text or interactive) inside the 24h service window —
   * the message type the AI uses to answer inbound WhatsApp turns. Interactive
   * buttons (≤3) render as reply buttons; a list renders as a selectable menu.
   */
  async sendSession(payload: WhatsappSessionPayload): Promise<WhatsappSendResult> {
    return this.dispatch(
      payload.tenantId,
      payload.accountId,
      payload.phoneNumberId,
      this.buildSessionBody(payload),
    );
  }

  /** Build the Meta message body for a text / interactive session reply. */
  private buildSessionBody(payload: WhatsappSessionPayload): Record<string, unknown> {
    const base = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.normalize(payload.to),
    };
    const inter = payload.interactive;
    const buttons = inter?.buttons?.slice(0, 3) ?? [];
    const list = inter?.list;

    if (list && list.sections.length > 0) {
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(inter?.header ? { header: { type: 'text', text: inter.header.slice(0, 60) } } : {}),
          body: { text: payload.text.slice(0, 1024) },
          ...(inter?.footer ? { footer: { text: inter.footer.slice(0, 60) } } : {}),
          action: {
            button: (list.buttonText || 'Select').slice(0, 20),
            sections: list.sections.slice(0, 10).map((s) => ({
              ...(s.title ? { title: s.title.slice(0, 24) } : {}),
              rows: s.rows.slice(0, 10).map((r) => ({
                id: r.id.slice(0, 200),
                title: r.title.slice(0, 24),
                ...(r.description ? { description: r.description.slice(0, 72) } : {}),
              })),
            })),
          },
        },
      };
    }

    if (buttons.length > 0) {
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(inter?.header ? { header: { type: 'text', text: inter.header.slice(0, 60) } } : {}),
          body: { text: payload.text.slice(0, 1024) },
          ...(inter?.footer ? { footer: { text: inter.footer.slice(0, 60) } } : {}),
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
            })),
          },
        },
      };
    }

    return { ...base, type: 'text', text: { preview_url: false, body: payload.text.slice(0, 4096) } };
  }

  /**
   * Resolve tenant-scoped credentials, POST the message body to the Cloud API,
   * and normalize the response. Shared by template + session sends. Never throws
   * for expected failures — returns `{ success:false, error }` for the executor.
   */
  private async dispatch(
    tenantId: string,
    accountId: string,
    phoneNumberIdHint: string | undefined,
    body: Record<string, unknown>,
  ): Promise<WhatsappSendResult> {
    let phoneNumberId = phoneNumberIdHint;
    let accessToken: string | undefined;
    try {
      const account =
        accountId && accountId !== 'platform-env'
          ? await this.resolver.byId(tenantId, accountId)
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
        body: JSON.stringify(body),
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
      this.logger.warn(`Meta send failed (${res.status}): ${errMsg}`);
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
