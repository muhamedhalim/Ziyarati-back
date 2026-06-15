/**
 * Minimal structural types for the Meta WhatsApp Cloud API webhook payload.
 *
 * These are deliberately loose (`?` everywhere) — Meta sends a variety of change
 * shapes (messages, statuses, template updates) and we must accept the raw body
 * as-is. The body is typed via an `import type` interface so the global
 * ValidationPipe (whitelist / forbidNonWhitelisted) does NOT strip unknown
 * provider fields. We persist the raw payload and let the processing worker
 * interpret it.
 */
export interface MetaWebhookValueMetadata {
  display_phone_number?: string;
  phone_number_id?: string;
}

export interface MetaWebhookMessage {
  id?: string; // wamid — used for idempotency
  from?: string;
  timestamp?: string;
  type?: string;
}

export interface MetaWebhookStatus {
  id?: string; // wamid the status refers to
  status?: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp?: string;
  recipient_id?: string;
}

export interface MetaWebhookChangeValue {
  messaging_product?: string;
  metadata?: MetaWebhookValueMetadata;
  messages?: MetaWebhookMessage[];
  statuses?: MetaWebhookStatus[];
}

export interface MetaWebhookChange {
  field?: string; // e.g. 'messages'
  value?: MetaWebhookChangeValue;
}

export interface MetaWebhookEntry {
  id?: string; // WABA id
  changes?: MetaWebhookChange[];
}

/**
 * The raw inbound webhook body. Also tolerant of the legacy wrapper shape
 * `{ eventType?, payload, idempotencyKey? }` used before the Meta-native
 * integration, so existing callers/tests keep working.
 */
export interface WhatsappWebhookBody {
  object?: string;
  entry?: MetaWebhookEntry[];
  // Legacy wrapper compatibility:
  eventType?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
}
