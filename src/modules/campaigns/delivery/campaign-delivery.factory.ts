import { Inject, Injectable } from '@nestjs/common';
import {
  CAMPAIGN_DELIVERY_PROVIDERS,
  CampaignDeliveryProvider,
} from './campaign-delivery.provider.interface';
import { NoopCampaignDeliveryProvider } from './noop-campaign-delivery.provider';

/**
 * Resolves the delivery provider for a campaign channel (strategy selection).
 * Real providers are injected via the CAMPAIGN_DELIVERY_PROVIDERS token; if none
 * supports the requested channel, the no-op provider is used. Single seam
 * through which the execution service reaches a provider — keeping delivery
 * loosely coupled and trivially extensible to WhatsApp/Email/Push/In-App.
 */
@Injectable()
export class CampaignDeliveryFactory {
  constructor(
    @Inject(CAMPAIGN_DELIVERY_PROVIDERS)
    private readonly providers: CampaignDeliveryProvider[],
    private readonly fallback: NoopCampaignDeliveryProvider,
  ) {}

  resolve(channel?: string): CampaignDeliveryProvider {
    return this.providers.find((p) => p.supports(channel)) ?? this.fallback;
  }
}
