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
  document?: {
    id?: string;
    mime_type?: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  video?: { id?: string; mime_type?: string; caption?: string };
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
  };
  /**
   * Present on `message_echoes` items (a business-app-sent message going TO
   * a customer) per Meta's Coexistence documentation — absent on ordinary
   * inbound `messages` items, where the recipient is implicitly "us".
   */
  to?: string;
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
  /**
   * Coexistence (`smb_message_echoes` change field). Meta documents these as
   * message objects sent by the business FROM the WhatsApp Business App —
   * same object shape as `messages` above — echoed back to the Cloud API
   * webhook so ZiyaraTech can mirror them. Never patient-originated: see
   * `WhatsappCoexistenceEchoService`, the only consumer.
   */
  message_echoes?: MetaWebhookMessage[];
  /**
   * Coexistence `history`/`smb_app_state_sync` change fields. Deliberately
   * typed as `unknown` — Meta's exact payload shape for these two fields
   * isn't asserted anywhere in this codebase (no verified sample payload was
   * available at implementation time). `WhatsappWebhookService` only reads
   * this to derive a content-hash idempotency key and to record that a sync
   * confirmation arrived; nothing here is parsed into typed message content —
   * see `coexistence-webhook.adapter.ts`, which isolates that uncertainty.
   */
  event?: unknown;
  /**
   * `message_template_status_update` / `template_category_update` fields.
   * Left loose: only `WhatsappWebhookService.templateEventFromBody` reads
   * them, and it validates each one's type itself.
   */
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string | null;
  new_category?: string;
  previous_category?: string;
  correct_category?: string;
}

export interface MetaWebhookChange {
  field?: string; // e.g. 'messages'
  value?: MetaWebhookChangeValue;
}

export interface MetaWebhookEntry {
  id?: string; // WABA id
  /** Unix seconds the webhook was triggered — present on template events. */
  time?: number;
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
