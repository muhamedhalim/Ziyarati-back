import { scrubText } from './log-scrubber.util';

/**
 * Keys whose values must never be written to logs. Matched case-insensitively,
 * with separators (`-`, `_`, spaces) stripped from both sides first, and as
 * substrings — so `password_hash`, `newPassword`, `api-key`, `X-Api-Key`, etc.
 * are all caught regardless of naming convention.
 */
const SENSITIVE_KEY_PATTERNS = [
  // Credentials
  'password',
  'secret',
  // Tokens / auth (covers accessToken, refreshToken, Authorization header, JWTs)
  'token',
  'authorization',
  'apikey',
  // Session / cookies
  'cookie',
  // Payment data
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'iban',
  'bankaccount',
  'accountnumber',
  'routingnumber',
  // National identifiers
  'ssn',
];

/**
 * PII field names (FND-043). EXACT-match only, deliberately separate from
 * SENSITIVE_KEY_PATTERNS above — these names are common SUBSTRINGS of
 * legitimate, non-PII operational keys (`emailEnabled`, `emailProvider`,
 * `emailTemplateId`, `emailDefaultLocale`, ...), so substring-matching them
 * the way credentials/tokens are matched would redact exactly the
 * diagnostic fields an engineer needs when debugging a delivery failure
 * (AD-05). Compared against the SAME normalized (lowercased, separator-
 * stripped) key as the substring set, so `full_name`/`fullName`/`FULL-NAME`
 * all match one entry.
 */
const SENSITIVE_KEY_EXACT = [
  'email',
  'phone',
  'fullname',
  'dateofbirth',
  // Sensitive patient data (chronic-disease intake) — never written to logs.
  'chronicdiseases',
  // Government identity number (`Customer.national_id`) — normalizes from
  // `national_id` / `nationalId`. Exact-match so unrelated keys stay readable.
  'nationalid',
  // Free text a patient, clinician or staff member wrote (residency plan P7).
  // None of these is operational config, so exact-match is safe; the value is
  // whatever was typed, which is exactly what must not reach a log.
  'content',
  'notes',
  'note',
  'text',
  'prompt',
  'reply',
  'body',
  'diagnosis',
  'symptoms',
  'complaint',
  'medication',
  'medications',
  'allergies',
  'address',
  'firstname',
  'lastname',
  'patientname',
  'customername',
  'recipientname',
  'guestname',
  'insurancenumber',
];

/**
 * Free-text search query-param names. Their values are whatever the user typed
 * — for the CRM customer search that can be a national ID, phone, email or name
 * — so a logged URL must not carry them. Exact-match on the normalized key.
 */
const SENSITIVE_QUERY_PARAMS = ['q', 'search'];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

/** Lowercases and strips separators so `api-key`, `API_KEY`, `apiKey` all compare equal. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEY_PATTERNS.some((p) => normalized.includes(p)) ||
    SENSITIVE_KEY_EXACT.includes(normalized)
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWERCASE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * Capability tokens ride in the PATH of the public routes
 * (`/pay/:token`, `/appointment-action/:token`, `/unsubscribe/:token`, ...).
 * A segment that looks like a random token — long, base64url/hex, mixing
 * letters and digits, not a UUID and not a plain lowercase slug — is replaced.
 * UUIDs stay: they are the record ids an engineer needs, and are not secrets.
 */
function redactPathTokens(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment.length < 24 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
        return segment;
      }
      if (UUID_RE.test(segment) || LOWERCASE_SLUG_RE.test(segment)) {
        return segment;
      }
      return /[A-Za-z]/.test(segment) && /[0-9]/.test(segment)
        ? ':token'
        : segment;
    })
    .join('/');
}

/**
 * Returns a request URL that is safe to log: the path and every parameter NAME
 * are kept (so an operator can still see which filters were used), but the
 * VALUE of any sensitive or free-text-search param is replaced with
 * `[REDACTED]`. Non-sensitive params (`page`, `limit`, `isActive`, ...) pass
 * through byte-for-byte. A URL with no query string is returned unchanged.
 */
export function sanitizeUrlForLog(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return redactPathTokens(url);

  const path = redactPathTokens(url.slice(0, queryStart));
  const query = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // Malformed escape — fall back to the raw key; still checked below.
      }
      // Strip a trailing `[]` / `[n]` so `q[]=...` is treated as `q`.
      const name = key.replace(/\[[^\]]*\]$/, '');
      return isSensitiveKey(name) ||
        SENSITIVE_QUERY_PARAMS.includes(normalizeKey(name))
        ? `${rawKey}=${REDACTED}`
        : pair;
    })
    .join('&');
  return `${path}?${query}`;
}

/**
 * Deep-clones a value with sensitive fields redacted, for safe logging.
 * Caps recursion depth to avoid blowing up on cyclic/huge payloads.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  // Key-based redaction cannot see an identifier embedded in a string value
  // (a driver message, a provider error, a pasted URL) — scrub those by shape.
  if (typeof value === 'string') return scrubText(value);
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
