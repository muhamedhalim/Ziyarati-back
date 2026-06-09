import { Injectable } from '@nestjs/common';

import { WhatsappProviderFactory } from './providers/whatsapp-provider.factory';
import {
  WhatsappSendPayload,
  WhatsappSendResult,
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
}
