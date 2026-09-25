import { createHash } from 'node:crypto';

import type {
  MetaWebhookChangeValue,
  MetaWebhookMessage,
} from './whatsapp-webhook.types';

/**
 * Isolates everything about Coexistence's three inbound webhook fields
 * (`smb_message_echoes`, `smb_app_state_sync`, `history`) that this codebase
 * cannot assert with confidence, so that uncertainty never leaks into
 * `WhatsappWebhookService` or the domain layer it drives.
 *
 * `message_echoes` is the one field Meta's Coexistence documentation
 * describes precisely (same object shape as an ordinary inbound message) —
 * `extractMessageEchoes` is a plain, confident array read.
 *
 * `smb_app_state_sync` and `history` are NOT parsed for content anywhere in
 * this codebase — no verified sample payload for either was available at
 * implementation time, and guessing field names here would be exactly the
 * "assume a structure that doesn't exist" this adapter exists to prevent.
 * `WhatsappWebhookService` only needs to (a) deduplicate a redelivered event
 * and (b) know that a confirmation arrived; `contentHashKey` gives it a
 * stable idempotency key from the RAW payload regardless of its internal
 * shape, which is correct today and stays correct if Meta's schema for
 * either field turns out to differ from any particular guess.
 */

/** Safe, typed read of `message_echoes` — `[]` for anything malformed. */
export function extractMessageEchoes(
  value: MetaWebhookChangeValue | undefined,
): MetaWebhookMessage[] {
  return Array.isArray(value?.message_echoes) ? value!.message_echoes! : [];
}

/**
 * The customer's wa_id an echo was sent TO. Tries the echo's own `to` field
 * first (Meta's documented field for this), then falls back to the `contacts`
 * array Meta typically sends alongside a message-bearing change value (the
 * same field ordinary inbound `messages` already rely on for the sender's
 * profile) — never guesses beyond that; `undefined` means "cannot attribute
 * this echo to a customer", and the caller must skip it rather than mis-file
 * it.
 */
export function resolveEchoRecipientWaId(
  value: MetaWebhookChangeValue | undefined,
  echo: MetaWebhookMessage,
): string | undefined {
  const direct = echo.to?.replace(/[^\d]/g, '');
  if (direct) return direct;
  const contact = value?.contacts?.[0]?.wa_id;
  return contact?.replace(/[^\d]/g, '') || undefined;
}

/**
 * Stable content-addressed key for a webhook change value whose schema is
 * not asserted (`history` / `smb_app_state_sync`). Two deliveries of the
 * EXACT same payload (a genuine Meta redelivery/retry) hash identically and
 * dedupe; a payload that legitimately differs (a new chunk, a new state)
 * gets its own key. Prefixed with `field` so the two event types can never
 * collide with each other or with the message/status key shapes
 * `WhatsappWebhookService.deriveIdempotencyKey` already uses.
 */
export function contentHashKey(field: string, value: unknown): string {
  const json = JSON.stringify(value ?? null);
  const hash = createHash('sha256').update(json).digest('hex');
  return `${field}:${hash}`;
}
