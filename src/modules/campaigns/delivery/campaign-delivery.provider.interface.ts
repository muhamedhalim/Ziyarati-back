/**
 * Campaign delivery-provider abstraction (strategy pattern).
 *
 * Campaign business logic depends ONLY on this interface — never on WhatsApp/
 * SMS/Email/Push SDKs. Concrete adapters implement `supports()` for their
 * channel and register into the `CAMPAIGN_DELIVERY_PROVIDERS` multi-provider
 * token; the factory resolves the right one at execution time. Adding a real
 * provider later requires NO change to the execution service.
 */
export interface CampaignDeliveryPayload {
  tenantId: string;
  campaignId: string;
  channel: string;
  recipientId: string;
  customerId: string;
  /** Reference to the WhatsApp/notification template, if any. */
  templateId?: string;
  /** Campaign segment/personalization data (no secrets). */
  metadata?: Record<string, unknown>;
}

export interface CampaignDeliveryResult {
  success: boolean;
  /** Opaque provider reference (e.g. WhatsApp message id). Required on success. */
  providerRef?: string;
  error?: string;
  /**
   * Explicit retry classification for a failure. `true` ⇒ TRANSIENT (retry with
   * backoff), `false` ⇒ PERMANENT (no retry). When omitted, the dispatcher
   * heuristically classifies from the `error` text.
   */
  transient?: boolean;
}

export interface CampaignDeliveryProvider {
  /** Human-readable provider name (for logs/diagnostics). */
  readonly name: string;
  /** Returns true if this provider can deliver on the given channel. */
  supports(channel?: string): boolean;
  /** Performs the actual delivery. Must not throw for expected failures —
   *  return `{ success: false, error }` so the executor can mark/retry. */
  send(payload: CampaignDeliveryPayload): Promise<CampaignDeliveryResult>;
}

/** Multi-provider DI token: an array of registered campaign delivery providers. */
export const CAMPAIGN_DELIVERY_PROVIDERS = Symbol('CAMPAIGN_DELIVERY_PROVIDERS');
