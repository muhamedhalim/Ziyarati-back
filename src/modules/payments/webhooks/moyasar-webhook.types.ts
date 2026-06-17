/**
 * Shape of a Moyasar webhook event.
 *
 * Deliberately a plain interface (NOT a class-validator DTO): the global
 * ValidationPipe runs with `forbidNonWhitelisted: true`, which would 400 on any
 * unmodeled provider field. Typing the controller body as this interface makes
 * Nest treat it as a native `Object` metatype and skip whitelist validation, so
 * the raw provider payload survives intact for signature + state handling.
 *
 * The event is authenticated by its shared `secret_token` (see
 * MoyasarWebhookVerifier) — the tenant is NEVER read from this body; it is
 * resolved from our own Payment row via the gateway payment id.
 */
export interface MoyasarWebhookEvent {
  /** Unique event id — used for webhook idempotency/dedup. */
  id?: string;
  /** Event type, e.g. `payment_paid`, `payment_failed`, `payment_refunded`. */
  type?: string;
  created_at?: string;
  /** Shared secret echoed by Moyasar; compared against MOYASAR_WEBHOOK_SECRET. */
  secret_token?: string;
  /** The payment object the event is about. */
  data?: {
    id?: string;
    status?: string;
    /** Payment total in the smallest currency unit (halalas). */
    amount?: number;
    /** Cumulative amount refunded so far, in the smallest unit (halalas). */
    refunded?: number;
    currency?: string;
    [key: string]: any;
  };
  [key: string]: any;
}
