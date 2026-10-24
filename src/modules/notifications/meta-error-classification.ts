/**
 * Which Meta (WhatsApp Cloud API) send failures are worth retrying.
 *
 * Retrying a failure that cannot change wastes the clinic's queue and delays the
 * dead-letter signal: an invalid number or a paused template will fail the same
 * way five times over. Retrying one that can change (throttling, a transient
 * Meta outage) is exactly what backoff is for.
 *
 * An UNKNOWN code is treated as transient: the old behaviour for every failure,
 * and still bounded by the queue's attempts and then the dead-letter queue — so a
 * code we have not seen can delay a message but never loop forever or be dropped.
 *
 * Codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export type SendFailureClass = 'permanent' | 'transient';

/** The recipient, template or request itself is wrong — the same call fails again. */
const PERMANENT_CODES = new Set<number>([
  100, // invalid parameter
  131008, // required parameter missing
  131009, // parameter value invalid
  131026, // message undeliverable (not a WhatsApp user, blocked, old client)
  131047, // re-engagement: outside the 24h window
  131049, // Meta withheld a marketing message to protect the user experience
  131051, // unsupported message type
  132000, // template parameter count mismatch
  132001, // template does not exist in that language
  132005, // translated text too long
  132007, // template format character policy violated
  132012, // template parameter format mismatch
  132015, // template paused
  132016, // template disabled
]);

/** Capacity or a passing fault — a later attempt can succeed. */
const TRANSIENT_CODES = new Set<number>([
  130429, // throughput limit reached
  131000, // something went wrong
  131048, // spam-rate limit
  131056, // pair rate limit (too many messages to one recipient)
]);

export function classifyMetaFailure(
  errorCode?: number | null,
): SendFailureClass {
  if (typeof errorCode !== 'number') return 'transient';
  if (PERMANENT_CODES.has(errorCode)) return 'permanent';
  if (TRANSIENT_CODES.has(errorCode)) return 'transient';
  return 'transient';
}
