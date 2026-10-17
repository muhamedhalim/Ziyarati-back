/**
 * Email delivery-provider abstraction (strategy pattern) — mirrors the
 * notification-channel abstraction. Business logic depends ONLY on this
 * interface, never on the AWS SES SDK. Amazon SES is the only delivery provider.
 */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  /** Plain-text fallback (accessibility + spam-score + non-HTML clients). */
  text?: string;
  /** `Name <addr>` — defaults to the configured platform sender. */
  from?: string;
  replyTo?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  /** Provider tags for analytics (no secrets/PII). */
  tags?: { name: string; value: string }[];
  /**
   * Stable per-message key the provider uses to deduplicate a retried send
   * whose first attempt's outcome was never observed (timeout after the
   * provider accepted it). Must never contain a secret.
   */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  success: boolean;
  /** Opaque provider message id (required on success). */
  providerMessageId?: string;
  error?: string;
  /** true ⇒ TRANSIENT (retry), false ⇒ PERMANENT (do not retry). */
  transient?: boolean;
}

export interface EmailProvider {
  /** Stable provider name for logs/observability. */
  readonly name: string;
  /** Whether credentials are present (drives factory selection + health). */
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
  /** Optional bulk send; the delivery layer falls back to per-message `send`. */
  sendBulk?(messages: EmailMessage[]): Promise<EmailSendResult[]>;
}
