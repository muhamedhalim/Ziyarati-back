/**
 * WhatsApp message delivery-provider abstraction (strategy pattern).
 *
 * Business logic depends ONLY on this interface — never on the Meta Cloud API /
 * Twilio / 360dialog SDKs. A concrete adapter implements `supports()` and is
 * registered into the `WHATSAPP_MESSAGE_PROVIDERS` multi-provider token; the
 * factory resolves one at send time. Adding a real provider later requires NO
 * change to the messaging/execution services.
 */
export interface WhatsappSendPayload {
  tenantId: string;
  accountId: string;
  /** Destination WhatsApp id / phone (E.164 digits). */
  to: string;
  templateId: string;
  templateName: string;
  language: string;
  /** Template variable substitutions (no secrets). */
  variables?: Record<string, unknown>;
}

export interface WhatsappSendResult {
  success: boolean;
  /** Opaque provider message id (e.g. WhatsApp `wamid`). */
  providerMessageId?: string;
  error?: string;
}

export interface WhatsappMessageProvider {
  /** Human-readable provider name (for logs/diagnostics). */
  readonly name: string;
  /** Returns true if this provider can deliver (e.g. by account/region). */
  supports(payload?: WhatsappSendPayload): boolean;
  /** Performs the send. Must not throw for expected failures — return
   *  `{ success: false, error }` so the executor can log + retry. */
  send(payload: WhatsappSendPayload): Promise<WhatsappSendResult>;
}

/** Multi-provider DI token: an array of registered WhatsApp message providers. */
export const WHATSAPP_MESSAGE_PROVIDERS = Symbol('WHATSAPP_MESSAGE_PROVIDERS');
