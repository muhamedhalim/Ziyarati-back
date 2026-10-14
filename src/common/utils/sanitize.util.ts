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
  // MFA / one-time codes / sessions / request signing (LOGGING.md §Redaction).
  // A 6-digit OTP is too short for the value-shape digit scrubber, so these
  // must be caught by name.
  'mfa',
  'totp',
  'otpcode',
  'recoverycode',
  'backupcode',
  'passcode',
  'pincode',
  'securitycode',
  'sessionid',
  'signature',
  'privatekey',
  'credential',
  'cardholder',
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
  // Short credential names that are too common as substrings (`footprint`,
  // `spinner`, `company`) to match any other way.
  'otp',
  'pin',
  'pan',
  'sid',
  // LSA-04 stop-gap: names the 2026-10-14 audit proved leaked (canary S1).
  // Generic names (`code`, `message`, `reason`, `data`, …) are NOT listed —
  // they carry operational values too; the structured-field allow-list
  // (`sanitizeLogFields`) handles their free text instead.
  'phonenumber',
  'patientphone',
  'mobile',
  'mobilenumber',
  'whatsappnumber',
  'waid',
  'msisdn',
  'emailaddress',
  'patientemail',
  'name',
  'doctorname',
  'staffname',
  'guardianname',
  'parentname',
  'guardian',
  'medicalnotes',
  'clinicalnotes',
  'diagnoses',
  'icd10',
  'symptom',
  'chiefcomplaint',
  'prescription',
  'medicalhistory',
  'iqama',
  'iqamanumber',
  'passportnumber',
  'idnumber',
  'dob',
  'birthdate',
  'gender',
  'policynumber',
  'verificationcode',
  'visitreason',
  'transcript',
  'caption',
  'comment',
  'answer',
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

const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A literal route word (`customers`, `by-phone`, `v1`, `v20.0`) or an Express
// template placeholder (`:id`). Anything else — digits, mixed case, tokens,
// percent-encoding, non-ASCII — is a value and becomes `:param`.
const STATIC_SEGMENT_RE =
  /^(?:[a-z][a-z_-]{0,39}|v\d+(?:\.\d+)?|:[A-Za-z_]\w{0,39})$/;

/**
 * A URL safe to put in a log line or a span (LSA-03/LSA-04): no query string,
 * no fragment, no userinfo, and every path segment that is not a literal route
 * word, a `:param` placeholder or a UUID replaced by `:param`.
 */
export function redactUrlForLog(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(clean);
  const origin = m ? m[1].replace(/\/\/[^@/]*@/, '//') : '';
  const path = m ? m[2] : clean;
  return (
    origin +
    path
      .split('/')
      .map((seg) =>
        seg === '' || STATIC_SEGMENT_RE.test(seg) || UUID_SEGMENT_RE.test(seg)
          ? seg
          : ':param',
      )
      .join('/')
  );
}

const QUERY_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const MAX_QUERY_KEYS = 20;

/**
 * The query-parameter NAMES of a URL, for the error log (LSA-06) — never a
 * value. Sorted and de-duplicated; a name that is not a plain identifier (an
 * attacker-chosen key can itself carry a phone or a name) becomes `[key]`.
 * Returns `undefined` when the URL has no query string.
 */
export function queryKeysForLog(url: string | undefined): string[] | undefined {
  if (typeof url !== 'string') return undefined;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return undefined;
  const names = new Set<string>();
  for (const pair of url
    .slice(queryStart + 1)
    .split('#')[0]
    .split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    let name = eq === -1 ? pair : pair.slice(0, eq);
    try {
      name = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      // malformed escape — judged as-is below
    }
    name = name.replace(/\[[^\]]*\]$/, '');
    names.add(QUERY_KEY_RE.test(name) ? name : '[key]');
    if (names.size >= MAX_QUERY_KEYS) break;
  }
  return names.size ? [...names].sort() : undefined;
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

// ─── Structured log fields: allow-list (LSA-04) ──────────────────────────── //

/** A field name that is a plain identifier — anything else is user-chosen text. */
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

/**
 * Keys whose STRING values are operational by construction (identifiers,
 * enums, machine names), so they are kept (still shape-scrubbed). Matched on
 * the last `_`/camel-case word of the key: `appointment_id`, `tenantId`,
 * `error_code`, `jobStatus`, `http_method` …
 */
const SAFE_WORDS =
  'id|ids|uuid|keys|origin|type|status|state|code|codes|event|route|method|provider|queue|channel|model|operation|table|constraint|kind|mode|role|roles|action|outcome|result|category|source|locale|language|currency|plan|tier|feature|version|env|region|level|context|sqlstate|errno|scope|host|hostname';
const capitalize = (words: string) =>
  words
    .split('|')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('|');
const SAFE_STRING_KEY_RE = new RegExp(
  // snake/dotted (`appointment_id`, `error.code`, `status`) …
  `(?:^|[_.])(?:${SAFE_WORDS}|reason_code|template_name|job_name|queue_name|key_prefix)$` +
    // … or camelCase (`tenantId`, `jobStatus`) — case-sensitive on purpose so
    // `paid`/`valid` do not read as `…Id`.
    `|[a-z0-9](?:${capitalize(SAFE_WORDS)})$`,
);

/** Numeric-valued keys where a long integer is a measurement, not an identifier. */
const MEASURE_WORDS =
  'ms|at|bytes|count|size|total|seconds|id|ids|limit|offset|max|min|ttl|depth|attempt|attempts|port|status|code|epoch|timestamp|version';
const NUMERIC_MEASURE_KEY_RE = new RegExp(
  `(?:^|[_.])(?:${MEASURE_WORDS})$|[a-z0-9](?:${capitalize(MEASURE_WORDS)})$`,
);

// A machine token: no whitespace, and either lowercase/uppercase-only or
// containing a digit/separator — `meta_graph`, `RATE_LIMITED`, `msg_4fA9`,
// `v2.3`, `2026-10-14T10:00:00.000Z`. A capitalised word (`Sara`) or anything
// with a space is free text.
const LOWER_TOKEN_RE = /^[a-z0-9_.:/+#=-]{1,80}$/;
const UPPER_TOKEN_RE = /^[A-Z0-9_.:/+#=-]{1,80}$/;
// Mixed case needs a DIGIT to count as machine-made (`msg_4fA9`, `wamid.HBg1`);
// `Sara-Ahmed` or `Hyper-Tension` does not.
const MIXED_TOKEN_RE = /^(?=.*[0-9])[A-Za-z0-9_.:/+#=-]{1,80}$/;
// A single capitalised word is allowed under identifier/enum keys only
// (`type: 'Error'`, `status: 'Pending'`).
const CAPITALISED_WORD_RE = /^[A-Z][a-z]{1,30}$/;
/**
 * Keys whose string value is free text by definition: never kept, whatever its
 * shape (normalized: lower-cased, separators removed).
 */
const FREE_TEXT_KEYS = new Set([
  'to',
  'whatsapp',
  'from',
  'payload',
  'data',
  'details',
  'detail',
  'description',
  // NOT `reason`: it carries operational enums (`unauthenticated`,
  // `rate_limited`) that alarms query; free text under it is still hidden by
  // the token rule below.
  'query',
  'search',
  'q',
  'subject',
  'title',
  'label',
  'value',
  'input',
  'output',
  'response',
  'request',
  'error_message',
  'errormessage',
  'providermessage',
  'raw',
]);
const URL_KEY_RE =
  /(?:^|[_.])(?:url|uri|href|link|endpoint)$|[a-z0-9](?:Url|Uri|Href|Link|Endpoint)$/;
// camelCase / PascalCase identifiers with at least two humps (`uncaughtException`,
// `NotFoundException`). A single capitalised word (`Sara`) is not one.
const CAMEL_TOKEN_RE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
// The sanitizers' own placeholders (`[key]`, `[REDACTED]`, `[string:12]`).
const PLACEHOLDER_RE = /^\[[A-Za-z_]+(?::\d+)?\]$/;
const PASCAL_TOKEN_RE = /^(?:[A-Z][a-z0-9]+){2,}$/;
// 4–8 bare digits outside an id/measure key: an OTP, PIN or short local
// number is the likeliest reading.
const SINGLE_WORD_RE = /^\S{1,128}$/;
const SHORT_DIGITS_RE = /^[0-9٠-٩۰-۹]{4,8}$/;

const FIELD_MAX_DEPTH = 5;
const FIELD_MAX_ARRAY = 50;
const FIELD_MAX_KEYS = 50;

function isMachineToken(value: string): boolean {
  return (
    PLACEHOLDER_RE.test(value) ||
    LOWER_TOKEN_RE.test(value) ||
    UPPER_TOKEN_RE.test(value) ||
    MIXED_TOKEN_RE.test(value) ||
    (value.length <= 80 &&
      (CAMEL_TOKEN_RE.test(value) || PASCAL_TOKEN_RE.test(value)))
  );
}

function allowedString(key: string, value: string): string {
  if (FREE_TEXT_KEYS.has(normalizeKey(key).replace(/\W/g, '')))
    return `[string:${value.length}]`;
  if (URL_KEY_RE.test(key)) return scrubText(redactUrlForLog(value));
  if (SAFE_STRING_KEY_RE.test(key)) {
    // Identifier/enum keys: a machine token, a bare number (`131047`) or one
    // capitalised word (`Error`) — never free text.
    return SINGLE_WORD_RE.test(value) &&
      (isMachineToken(value) || CAPITALISED_WORD_RE.test(value))
      ? scrubText(value)
      : `[string:${value.length}]`;
  }
  if (SHORT_DIGITS_RE.test(value)) return `[digits:${value.length}]`;
  if (isMachineToken(value)) return scrubText(value);
  return `[string:${value.length}]`;
}

function allowedNumber(key: string, value: number): number | string {
  if (!Number.isFinite(value)) return String(value);
  if (
    Number.isInteger(value) &&
    Math.abs(value) >= 1_000_000 &&
    !NUMERIC_MEASURE_KEY_RE.test(key)
  ) {
    // A 7+ digit integer under a neutral key reads like a phone or an ID.
    return '[NUMBER]';
  }
  return value;
}

function allowedValue(key: string, value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return allowedNumber(key, value);
  if (typeof value === 'bigint') return allowedString(key, value.toString());
  if (typeof value === 'string') return allowedString(key, value);
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return {
      type: (value.name || 'Error').slice(0, 64),
      message: scrubText(value.message ?? '').slice(0, 2_048),
    };
  }
  if (depth >= FIELD_MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) {
    const head = value
      .slice(0, FIELD_MAX_ARRAY)
      .map((v) => allowedValue(key, v, depth + 1));
    return value.length > FIELD_MAX_ARRAY
      ? [...head, `[+${value.length - FIELD_MAX_ARRAY} more]`]
      : head;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `[${(value as object).constructor?.name ?? 'Object'}]`;
  }
  return allowedObject(value as Record<string, unknown>, depth + 1);
}

function allowedObject(
  obj: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(obj);
  let opaque = 0;
  for (const [key, val] of entries.slice(0, FIELD_MAX_KEYS)) {
    if (val === undefined) continue;
    const outKey = FIELD_KEY_RE.test(key) ? key : `[key:${++opaque}]`;
    out[outKey] = isSensitiveKey(key)
      ? REDACTED
      : allowedValue(outKey, val, depth);
  }
  if (entries.length > FIELD_MAX_KEYS)
    out['[more]'] = entries.length - FIELD_MAX_KEYS;
  return out;
}

/**
 * The structured-field gate for the application logger (LSA-04). Unlike the
 * deny-list `sanitizeForLog`, a value survives only if it is safe BY SHAPE OF
 * ITS KEY OR ITSELF:
 *  - sensitive key names (credential/PII deny-list) → `[REDACTED]`;
 *  - strings: kept under identifier/enum keys (`*_id`, `status`, `provider`,
 *    `code`, …) or when the value is a machine token; otherwise
 *    `[string:<length>]` — names, clinical text, provider prose never pass;
 *  - 4–8 bare digits under a neutral key (OTP/PIN) → `[digits:N]`;
 *  - integers ≥ 7 digits under a neutral key (phone/ID) → `[NUMBER]`;
 *  - non-identifier keys (user-chosen map keys) → `[key:N]`;
 *  - class instances → `[ClassName]`; depth/breadth capped.
 * Every kept string is also shape-scrubbed (`scrubText`).
 */
export function sanitizeLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return allowedObject(fields, 0);
}
