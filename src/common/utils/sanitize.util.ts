/**
 * Keys whose values must never be written to logs. Matched case-insensitively
 * and as substrings (so `password_hash`, `newPassword`, etc. are all caught).
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'token',
  'secret',
  'authorization',
  'apikey',
  'api_key',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Deep-clones a value with sensitive fields redacted, for safe logging.
 * Caps recursion depth to avoid blowing up on cyclic/huge payloads.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeForLog(val, depth + 1);
  }
  return out;
}
