/**
 * Free-text scrubbing for anything that ends up in a log line, a stored failure
 * reason or a job `failedReason` (residency plan P7).
 *
 * `sanitize.util.ts` redacts by KEY NAME. That cannot catch an identifier
 * embedded in a STRING: a driver message such as `invalid input syntax for type
 * uuid: "0501234567"`, a provider error echoing a recipient address, a
 * presigned URL with its signature, or a patient's own words in a chat turn.
 * This module scrubs by VALUE SHAPE instead. It is deliberately conservative in
 * one direction only: when unsure, it removes. A log line that loses a number
 * is an inconvenience; one that keeps a national ID is an incident.
 *
 * It never throws and never returns more text than it was given (plus short
 * placeholder tokens), so it is safe on every error path.
 */

const MAX_SCRUB_INPUT = 10_000;
const DEFAULT_REASON_LENGTH = 500;

/** `[REDACTED]` is what `sanitize.util` already writes — keep one vocabulary. */
const R = '[REDACTED]';

// JWT: three base64url segments, the first two starting `eyJ` (a JSON header/payload).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

// `Authorization: Bearer abc` / `Basic abc` fragments pasted into an error.
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

// Signed-URL / credential query parameters. The name is kept so an operator can
// still see THAT a URL was signed; only the value goes.
const SECRET_QUERY_RE =
  /([?&](?:X-Amz-[A-Za-z0-9-]+|AWSAccessKeyId|Signature|Expires|sig|token|access_token|refresh_token|api[_-]?key|key|code)=)[^&\s"'<>)]+/gi;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// A run of 9–19 digits, optionally grouped with single spaces or dashes and an
// optional leading `+`. Covers phone numbers (+9665…, 05…, 01…), national /
// Iqama / Egyptian IDs (10 and 14 digits) and card numbers (13–19). The lookarounds
// stop it biting into the middle of a UUID or a longer token.
// ASCII, Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9)
// digits: Gulf users routinely type a phone number or ID in Arabic numerals.
const DIGIT_CLASS = '[0-9\\u0660-\\u0669\\u06F0-\\u06F9]';
const DIGIT_RUN_RE = new RegExp(
  `(?<![\\w-])\\+?${DIGIT_CLASS}(?:[ -]?${DIGIT_CLASS}){8,18}(?![\\w-])`,
  'g',
);

// 13 digits starting with 1 is a millisecond epoch (2001–2033), not an
// identifier; timestamps in messages are worth keeping.
const EPOCH_MS_RE = /^1\d{12}$/;

// PostgreSQL driver detail that quotes row values.
const PG_KEY_DETAIL_RE = /\bKey \(([^)]*)\)=\(([^)]*)\)/g;
const PG_FAILING_ROW_RE = /\bFailing row contains \([^)]*\)/g;
const PG_INVALID_INPUT_RE =
  /(\binvalid input (?:syntax|value) for [^:"]*:\s*)"[^"]*"/gi;
const PG_QUOTED_VALUE_RE =
  /(\bvalue\s+)"[^"]*"(\s+(?:is out of range|too long|violates))/gi;

/** Maps Arabic-Indic and Extended Arabic-Indic digits to ASCII; everything else is returned unchanged. */
export function toAsciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (c) => {
    const code = c.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function scrubDigits(match: string): string {
  const digits = toAsciiDigits(match).replace(/\D/g, '');
  if (
    digits.length === 13 &&
    EPOCH_MS_RE.test(digits) &&
    !/[ +-]/.test(match)
  ) {
    return match;
  }
  return '[NUMBER]';
}

/**
 * Removes identifier-shaped substrings from free text. Input longer than
 * {@link MAX_SCRUB_INPUT} is truncated first so a pathological string cannot
 * make the scrubber itself a cost.
 */
export function scrubText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out =
    input.length > MAX_SCRUB_INPUT
      ? `${input.slice(0, MAX_SCRUB_INPUT)}…[truncated]`
      : input;

  out = out
    .replace(PG_KEY_DETAIL_RE, `Key ($1)=([REDACTED])`)
    .replace(PG_FAILING_ROW_RE, 'Failing row contains ([REDACTED])')
    .replace(PG_INVALID_INPUT_RE, `$1"${R}"`)
    .replace(PG_QUOTED_VALUE_RE, `$1"${R}"$2`)
    .replace(JWT_RE, '[JWT]')
    .replace(AUTH_SCHEME_RE, `$1 ${R}`)
    .replace(SECRET_QUERY_RE, `$1${R}`)
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(DIGIT_RUN_RE, scrubDigits);
  return out;
}

/** True if scrubbing would change the text — used by tests and counters. */
export function containsIdentifier(input: string): boolean {
  return scrubText(input) !== input;
}

/**
 * A failure reason that is safe to put in Redis, a DLQ envelope, an
 * `email_logs.error` column or a log line: scrubbed and length-capped.
 * Accepts whatever a `catch` clause or a provider result hands over.
 */
export function scrubFailureReason(
  reason: unknown,
  maxLength = DEFAULT_REASON_LENGTH,
): string {
  let text: string;
  if (reason instanceof Error) text = reason.message;
  else if (typeof reason === 'string') text = reason;
  else if (reason === undefined || reason === null) text = 'unknown';
  else {
    try {
      text = JSON.stringify(reason) ?? 'unknown';
    } catch {
      text = 'unserializable failure reason';
    }
  }
  const scrubbed = scrubText(text);
  return scrubbed.length > maxLength
    ? `${scrubbed.slice(0, maxLength)}…`
    : scrubbed;
}

export interface ScrubbedError {
  name: string;
  message: string;
  stack?: string;
}

/** `{name, message, stack}` of an error with message and stack scrubbed. */
export function scrubError(err: unknown): ScrubbedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: scrubText(err.message),
      stack: err.stack ? scrubText(err.stack) : undefined,
    };
  }
  return { name: 'NonError', message: scrubFailureReason(err) };
}

const SECRET_KEY_RE =
  /password|secret|token|authorization|apikey|api_key|cookie|cvv|cvc|iban|cardnumber|creditcard|accountnumber|nationalid|national_id|ssn|email|phone|fullname|full_name|dateofbirth|date_of_birth|chronic|content|notes?|text|prompt|reply|body|diagnos|symptom|medication|allerg/i;

/**
 * Shape-only view of a request body for the error log: which fields were sent,
 * their type and length, never their text. Values whose KEY is sensitive are
 * shown as `[REDACTED]`; booleans and numbers are kept (they are what an
 * engineer needs to reproduce a validation failure and carry no free text).
 * Depth and breadth are capped.
 */
export function summarizeBodyForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : 'number';
  if (typeof value === 'string') return `[string:${value.length}]`;
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= 4) return '[Truncated]';

  if (Array.isArray(value)) {
    const head = value
      .slice(0, 5)
      .map((v) => summarizeBodyForLog(v, depth + 1));
    return value.length > 5 ? [...head, `[+${value.length - 5} more]`] : head;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, val] of entries.slice(0, 50)) {
    out[key] = SECRET_KEY_RE.test(key)
      ? R
      : summarizeBodyForLog(val, depth + 1);
  }
  if (entries.length > 50) out['[more]'] = entries.length - 50;
  return out;
}

/**
 * Shared detection patterns, exported as SOURCE strings so every consumer builds
 * its own `RegExp` (a shared `/g` regex carries `lastIndex` state between calls).
 * The AI minimiser reuses them so that "what counts as a phone number or an
 * email" has exactly one definition.
 */
export const DIGIT_RUN_SOURCE = DIGIT_RUN_RE.source;
export const EMAIL_SOURCE = EMAIL_RE.source;
export const EPOCH_MS_SOURCE = EPOCH_MS_RE.source;
