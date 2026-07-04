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
  /** text | interactive | button | image | document | audio | video | location | ... */
  type?: string;
  text?: { body?: string };
  /** Reply from a tapped button / selected list row. */
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  /** Legacy quick-reply button payload. */
  button?: { text?: string; payload?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  video?: { id?: string; mime_type?: string; caption?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
}

export interface MetaWebhookContact {
  wa_id?: string;
  profile?: { name?: string };
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
  contacts?: MetaWebhookContact[];
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
