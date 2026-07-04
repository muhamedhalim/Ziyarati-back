import { Injectable } from '@nestjs/common';

import { WhatsappProviderFactory } from './providers/whatsapp-provider.factory';
import {
  WhatsappSendPayload,
  WhatsappSendResult,
  WhatsappSessionPayload,
} from './providers/whatsapp-message.provider.interface';

/**
 * Thin messaging wrapper over the provider abstraction. Resolves the right
 * provider (strategy) and delegates the send. Holds NO persistence or business
 * rules — orchestration (validation + logging) lives in WhatsappExecutionService.
 * This is the unit a future queue worker would call per message.
 */
@Injectable()
export class WhatsappMessagingService {
  constructor(private readonly factory: WhatsappProviderFactory) {}

  send(payload: WhatsappSendPayload): Promise<WhatsappSendResult> {
    const provider = this.factory.resolve(payload);
    return provider.send(payload);
  }

  /**
   * Sends a free-form session (text / interactive) message — the reply channel
   * for inbound AI conversations. Resolves the same provider strategy; if the
   * resolved provider does not implement session sends, returns a clear error
   * instead of throwing (the caller logs it).
   */
  sendSession(payload: WhatsappSessionPayload): Promise<WhatsappSendResult> {
    const provider = this.factory.resolve();
    if (!provider.sendSession) {
      return Promise.resolve({
        success: false,
        error: `Provider "${provider.name}" does not support session messages`,
      });
    }
    return provider.sendSession(payload);
  }
}
