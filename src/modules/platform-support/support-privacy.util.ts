/**
 * ============================================================================
 *  SUPPORT PRIVACY — least-disclosure helpers
 * ============================================================================
 *
 * Platform Customer Service gets the operational data required to troubleshoot,
 * never unrestricted tenant access. Where a support case genuinely needs to
 * MATCH a record against a ticket ("the patient says their booking on Tuesday
 * failed"), a masked value is enough to confirm the match without disclosing
 * the person.
 *
 * These are formatting helpers, not a security boundary — the boundary is the
 * DTO projection that decides a field is emitted at all. Masking is applied on
 * top, so even the fields we DO emit disclose the minimum.
 *
 * Deliberately not placed in `common/utils`: the only correct callers are the
 * Support diagnostic mappers. A general-purpose masking utility invites use as
 * a substitute for not selecting the column in the first place.
 */

/** What every masking helper returns when the input is absent/empty. */
const ABSENT = null;

/**
 * `Mohamed Abdelhalim` -> `M*** A***`. Preserves the initial of each word so a
 * support agent can confirm "yes, that's the person on the ticket" without the
 * name itself. Non-Latin scripts (Arabic) work identically — the first
 * grapheme is kept and the rest replaced.
 */
export function maskPersonName(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return ABSENT;
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${[...word][0]}***`)
    .join(' ');
}

/**
 * `mohamed.halem@gmail.com` -> `m***@gmail.com`. The domain is kept in full:
 * it is the diagnostically useful half (a clinic reporting "our Gmail users
 * aren't getting mail" needs the domain), and it identifies no individual.
 *
 * A `+alias` is stripped along with the rest of the local part rather than
 * preserved — an alias frequently contains a real name.
 */
export function maskEmail(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return ABSENT;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '***'; // not an address shape — disclose nothing
  const domain = trimmed.slice(at + 1);
  const local = trimmed.slice(0, at);
  return `${[...local][0]}***@${domain}`;
}

/**
 * `+966501234567` -> `+9665*****567`. Keeps the country/operator prefix and
 * the last three digits — enough to correlate with what a clinic quotes in a
 * ticket, not enough to dial. Short values are fully masked rather than
 * partially revealed.
 */
export function maskPhone(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return ABSENT;
  const chars = [...trimmed];
  if (chars.length <= 7) return '*'.repeat(chars.length);
  const head = chars.slice(0, 5).join('');
  const tail = chars.slice(-3).join('');
  return `${head}${'*'.repeat(chars.length - 8)}${tail}`;
}

/**
 * Provider/gateway/internal failure text, reduced to something safe to render.
 *
 * Failure strings come straight from third parties and from our own exception
 * messages, so they can carry a bearer token in a URL, a full request body, a
 * customer's email, or a stack trace. This strips the known-dangerous shapes
 * and hard-caps the length: a support agent needs the failure CATEGORY, not
 * the provider's raw diagnostic payload.
 *
 * The cap is applied last so a long value cannot smuggle an unredacted tail.
 */
/**
 * Order matters. URLs are scrubbed FIRST because a query string is the most
 * common carrier of a credential, and collapsing the whole URL to `[url]`
 * removes the token, the path and any identifier in one step — running the
 * credential patterns first would leave the rest of the URL behind.
 *
 * The credential patterns require an actual assignment delimiter (`:` / `=`)
 * or a recognisable key shape. An earlier version matched the bare WORD
 * `token` followed by anything, which destroyed the single most useful
 * WhatsApp diagnosis there is — "Meta error 190: token expired" became
 * "Meta error 190: [redacted]". A sanitizer that eats the diagnosis is worse
 * than no sanitizer, because it silently removes the reason a support agent
 * opened the page.
 */
const SANITIZE_PATTERNS: readonly [RegExp, string][] = [
  // URLs (query strings routinely carry tokens) — always first.
  [/\bhttps?:\/\/\S+/gi, '[url]'],
  // `Authorization: Bearer <value>` and friends.
  [/\b(bearer)\s+\S+/gi, '$1 [redacted]'],
  // key=value / key: value forms. The KEY is kept — knowing WHICH credential
  // was rejected is diagnostic; the value never is.
  [
    /\b(token|secret|password|passwd|api[_-]?key|apikey|signature|authorization|access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*)\S+/gi,
    '$1$2[redacted]',
  ],
  // Bare provider-key shapes (Stripe `sk_`/`pk_`, Resend `re_`, Meta `EAA…`),
  // which appear with no delimiter at all in some provider messages.
  [/\b(?:sk|pk|re|rk)[-_][A-Za-z0-9_-]{6,}\b/g, '[redacted]'],
  [/\bEAA[A-Za-z0-9]{10,}\b/g, '[redacted]'],
  // JWT-shaped values.
  [/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]'],
  // Email addresses.
  [/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[email]'],
  // Long digit runs — phone numbers, card PANs, account numbers.
  [/\b\d{7,}\b/g, '[number]'],
];

export const SUPPORT_FAILURE_REASON_MAX_LENGTH = 300;

export function sanitizeFailureReason(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return ABSENT;
  let out = trimmed;
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > SUPPORT_FAILURE_REASON_MAX_LENGTH
    ? `${out.slice(0, SUPPORT_FAILURE_REASON_MAX_LENGTH)}…`
    : out;
}

/** ISO string or null — every Support DTO emits dates in exactly this shape. */
export function isoOrNull(value?: Date | string | null): string | null {
  if (!value) return ABSENT;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? ABSENT : date.toISOString();
}
