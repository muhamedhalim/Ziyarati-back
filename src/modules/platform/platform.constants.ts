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
