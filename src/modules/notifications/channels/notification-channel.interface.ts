/**
 * Delivery-provider abstraction (strategy pattern).
 *
 * Business logic depends ONLY on this interface — never on WhatsApp/Twilio/SES/
 * FCM SDKs. Concrete adapters implement `supports()` for their channel and are
 * registered into the `NOTIFICATION_CHANNELS` multi-provider token; the
 * NotificationChannelFactory resolves the right one at dispatch time. Adding a
 * real provider later requires NO change to the dispatcher or scheduler.
 */
export interface NotificationPayload {
  tenantId: string;
  channel: string;
  recipientType?: string;
  recipientId?: string;
  templateId?: string;
  appointmentId?: string;
  /** Rendered/raw content for the message (provider decides how to use it). */
  contentAr?: string;
  contentEn?: string;
  /** Arbitrary provider-specific data (no secrets). */
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  /** Opaque provider reference (e.g. WhatsApp message id). */
  providerRef?: string;
  error?: string;
}

export interface NotificationChannelProvider {
  /** Human-readable provider name (for logs/diagnostics). */
  readonly name: string;
  /** Returns true if this provider can deliver on the given channel. */
  supports(channel?: string): boolean;
  /** Performs the actual delivery. Must never throw for expected failures —
   *  return `{ success: false, error }` so the dispatcher can log + retry. */
  send(payload: NotificationPayload): Promise<DeliveryResult>;
}

/** Multi-provider DI token: an array of registered channel providers. */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');
