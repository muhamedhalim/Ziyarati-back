import { Injectable, Logger } from '@nestjs/common';
import {
  WhatsappMessageProvider,
  WhatsappSendPayload,
  WhatsappSendResult,
  WhatsappSessionPayload,
} from './whatsapp-message.provider.interface';

/**
 * Default no-op WhatsApp provider — the universal fallback so the messaging flow
 * runs end-to-end without a real integration. Replace/augment by registering
 * real providers into WHATSAPP_MESSAGE_PROVIDERS; this remains the fallback.
 */
@Injectable()
export class NoopWhatsappProvider implements WhatsappMessageProvider {
  readonly name = 'noop';
  private readonly logger = new Logger('NoopWhatsappProvider');

  supports(): boolean {
    return true;
  }

  async send(payload: WhatsappSendPayload): Promise<WhatsappSendResult> {
    this.logger.log(
      `Simulated WhatsApp send to ${payload.to} using template ` +
        `"${payload.templateName}" (${payload.language}), tenant ${payload.tenantId}`,
    );
    return { success: true, providerMessageId: `noop_wamid_${Date.now()}` };
  }

  async sendSession(
    payload: WhatsappSessionPayload,
  ): Promise<WhatsappSendResult> {
    const kind = payload.interactive?.list
      ? 'list'
      : payload.interactive?.buttons?.length
        ? 'buttons'
        : 'text';
    this.logger.log(
      `Simulated WhatsApp session (${kind}) to ${payload.to}, tenant ${payload.tenantId}: ` +
        `"${payload.text.slice(0, 80)}"`,
    );
    return { success: true, providerMessageId: `noop_session_${Date.now()}` };
  }
}
