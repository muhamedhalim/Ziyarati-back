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
  /** Resolved destination address (E.164 phone / wa_id) — set by the dispatcher
   *  after a TENANT-SCOPED recipient lookup. Providers must not re-resolve it. */
  recipientPhone?: string;
  /** Resolved destination email address — same rule as {@link recipientPhone}:
   *  set by the dispatcher's tenant-scoped lookup, never re-resolved here. */
  recipientEmail?: string;
  templateId?: string;
  appointmentId?: string;
  /** Rendered/raw content for the message (provider decides how to use it). */
  contentAr?: string;
  contentEn?: string;
  /** Preferred language (e.g. 'ar' | 'en'); selects which content to send. */
  locale?: string;
  /** Arbitrary provider-specific data (no secrets). */
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  /** Opaque provider reference (e.g. WhatsApp message id). Required on success. */
  providerRef?: string;
  error?: string;
  /**
   * Failure classification. `true` ⇒ TRANSIENT (retry with backoff), `false` ⇒
   * PERMANENT (no retry). When omitted the dispatcher classifies heuristically.
   */
  transient?: boolean;
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
