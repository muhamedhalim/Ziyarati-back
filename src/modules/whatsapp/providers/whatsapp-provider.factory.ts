import { Inject, Injectable } from '@nestjs/common';
import {
  WHATSAPP_MESSAGE_PROVIDERS,
  WhatsappMessageProvider,
  WhatsappSendPayload,
} from './whatsapp-message.provider.interface';
import { NoopWhatsappProvider } from './noop-whatsapp.provider';

/**
 * Resolves the WhatsApp delivery provider (strategy selection). Real providers
 * are injected via the WHATSAPP_MESSAGE_PROVIDERS token; if none supports the
 * payload, the no-op provider is used. Single seam through which the messaging
 * service reaches a provider — keeping delivery loosely coupled.
 */
@Injectable()
export class WhatsappProviderFactory {
  constructor(
    @Inject(WHATSAPP_MESSAGE_PROVIDERS)
    private readonly providers: WhatsappMessageProvider[],
    private readonly fallback: NoopWhatsappProvider,
  ) {}

  resolve(payload?: WhatsappSendPayload): WhatsappMessageProvider {
    return this.providers.find((p) => p.supports(payload)) ?? this.fallback;
  }
}
