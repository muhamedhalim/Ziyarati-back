/**
 * Deterministic secret/credential scanner for Feature 011 (T016).
 *
 * Patterns are drawn directly from the credential-shaped configuration keys in
 * `Ziyarati-back/src/config/env.validation.ts` (JWT_ACCESS_SECRET,
 * JWT_REFRESH_SECRET, TAP_TEST_SECRET_KEY, TAP_LIVE_SECRET_KEY,
 * RESEND_API_KEY, META_APP_SECRET, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN,
 * CREDENTIALS_ENCRYPTION_KEY, OPENAI_API_KEY, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, METRICS_TOKEN) plus generic shapes (OpenAI-style
 * `sk-...` keys, JWT-shaped three-part base64url tokens, Postgres/Redis
 * connection strings carrying an embedded password, generic 32+ hex/base64
 * high-entropy tokens, AWS-style access-key ids).
 *
 * Used by W8 (T119–T132) to scan captured provider context, tool output,
 * emitted logs, and error bodies for anything that should never have crossed
 * those boundaries (SC-006). Deliberately conservative — a pattern match is
 * reported as a HIT for a human/finding-writer to judge, not silently
 * swallowed; false positives are cheap here, false negatives are not.
 */

export interface SecretHit {
  /** Human-readable pattern name, used in redaction markers and evidence tables — never the raw value. */
  pattern: string;
  /** The exact substring that matched — evidence files must redact this before persisting (see context-capture.ts's redactForEvidence). */
  matchedText: string;
  /** 0-indexed character offset of the match in the scanned text. */
  index: number;
}

interface NamedPattern {
  name: string;
  regex: RegExp;
}

// `g` flag required for repeated matchAll(); patterns are intentionally
// structural (shape-based), never a specific known value, so this file is
// itself safe to commit and never carries a real secret.
const PATTERNS: NamedPattern[] = [
  { name: 'openai-style-key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'jwt-token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'postgres-connection-string-with-password', regex: /\bpostgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+/gi },
  { name: 'redis-connection-string-with-password', regex: /\bredis(?:s)?:\/\/[^:\s'"]*:[^@\s'"]+@[^\s'"]+/gi },
  { name: 'aws-style-access-key-id', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Tap secret keys (sk_test_… / sk_live_…). Public keys (pk_…) are browser-safe
  // by design and deliberately NOT matched.
  { name: 'tap-secret-key', regex: /\bsk_(?:test|live)_[A-Za-z0-9]{16,}\b/g },
  // Named env vars: `KEY=value` / `KEY: "value"` / `KEY = 'value'` shapes for
  // every credential-bearing config key in env.validation.ts. Requires a
  // non-trivial value (>=6 chars) so `OPENAI_API_KEY=` (empty, the audit's
  // own safe default) never false-positives.
  {
    name: 'named-credential-env-assignment',
    regex:
      /\b(JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|TAP_TEST_SECRET_KEY|TAP_LIVE_SECRET_KEY|RESEND_API_KEY|META_APP_SECRET|WHATSAPP_APP_SECRET|WHATSAPP_VERIFY_TOKEN|CREDENTIALS_ENCRYPTION_KEY|OPENAI_API_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|METRICS_TOKEN|DB_PASSWORD)\s*[:=]\s*['"]?([^\s'",;]{6,})['"]?/g,
  },
  // Generic high-entropy bearer token in an Authorization header.
  { name: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g },
];

/** Scan one string; returns every hit with the pattern name and matched span (never mutates or logs the input). */
export function scanText(text: string): SecretHit[] {
  if (!text) return [];
  const hits: SecretHit[] = [];
  for (const { name, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      hits.push({ pattern: name, matchedText: match[0], index: match.index ?? -1 });
    }
  }
  return hits;
}

/** Recursively scan any JSON-serializable value (captured request objects, tool-call results, log payloads, error bodies) — walks strings at every depth. `path` accumulates for reporting where the hit was found. */
export function scanValue(value: unknown, path = '$'): (SecretHit & { path: string })[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    return scanText(value).map((hit) => ({ ...hit, path }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => scanValue(item, `${path}[${i}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
      scanValue(v, `${path}.${key}`),
    );
  }
  return [];
}

/**
 * Self-test: MUST detect a planted SYNTHETIC canary (never a real credential —
 * per FR-035/plan.md, this audit uses synthetic secrets only) and MUST report
 * zero hits on ordinary clinical/business text. Run this in
 * `ai-w0-harness.spec.ts` and in every W8 spec that uses `scanText`/`scanValue`
 * as its own guard against a silently-broken pattern set.
 */
export function selfTest(): { plantedDetected: boolean; cleanTextIsClean: boolean } {
  const syntheticCanary = 'sk-audit-synthetic-canary-0000000000000000';
  const plantedDetected = scanText(`Here is the key: ${syntheticCanary}`).some(
    (h) => h.matchedText === syntheticCanary,
  );
  const cleanText =
    'The clinic is open Monday to Friday, 9am to 5pm. Dr. Amina will see you at 3pm for your follow-up appointment.';
  const cleanTextIsClean = scanText(cleanText).length === 0;
  return { plantedDetected, cleanTextIsClean };
}
