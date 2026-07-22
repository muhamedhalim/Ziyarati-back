import { createHash, randomBytes } from 'node:crypto';

/**
 * Platform / Integration module constants + helpers.
 *
 * API keys are stored HASHED (schema: api_keys.key_hash is unique). The plaintext
 * is returned exactly once at creation/rotation and never persisted, so it can
 * never be read back — matching secure-credential practice.
 */
export const API_KEY_PREFIX = 'zk';

/** WebhookLog.status values (the column is a free-form string). */
export const WEBHOOK_LOG_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

/** Generate a new API key: a prefixed random secret + its SHA-256 hash. */
export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = `${API_KEY_PREFIX}_${randomBytes(32).toString('base64url')}`;
  return { plaintext, hash: hashApiKey(plaintext) };
}

/** Deterministic hash used to store + later look up a presented key. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * First few characters of a plaintext key — safe to store and display so an
 * owner can tell keys apart in a list, without ever storing or re-showing the
 * full secret (only the SHA-256 hash is persisted for verification).
 */
export function keyPrefix(plaintext: string): string {
  return plaintext.slice(0, 10);
}

/** Keys whose values are redacted before a webhook payload is persisted. */
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|signature|access[_-]?token|refresh[_-]?token|client[_-]?secret|card|cvv|pan|iban)/i;

/**
 * Deep-redacts secret-bearing fields from an arbitrary webhook payload so raw
 * third-party credentials/PII are never stored in `webhook_logs`. Returns a new
 * structure (does not mutate the input). Caps recursion depth to bound work.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}
