import { Injectable, Logger } from '@nestjs/common';
import {
  CampaignDeliveryPayload,
  CampaignDeliveryProvider,
  CampaignDeliveryResult,
} from './campaign-delivery.provider.interface';

/**
 * Default no-op campaign delivery provider — the universal fallback so the
 * execution flow runs end-to-end without a real integration. Replace/augment by
 * registering real providers into CAMPAIGN_DELIVERY_PROVIDERS; this remains the
 * safety-net fallback.
 */
@Injectable()
export class NoopCampaignDeliveryProvider implements CampaignDeliveryProvider {
  readonly name = 'noop';
  private readonly logger = new Logger('NoopCampaignDeliveryProvider');

  supports(): boolean {
    return true; // fallback for every channel
  }

  async send(payload: CampaignDeliveryPayload): Promise<CampaignDeliveryResult> {
    this.logger.log(
      `Simulated ${payload.channel} campaign delivery to customer ` +
        `${payload.customerId} (campaign ${payload.campaignId}, tenant ${payload.tenantId})`,
    );
    // provider_ref is UNIQUE in the DB — return a per-recipient deterministic ref
    // so simulated sends don't collide on the idempotency guard.
    return { success: true, providerRef: `noop:${payload.recipientId}` };
  }
}
