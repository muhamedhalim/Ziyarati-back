/**
 * FND-024 — inbound WhatsApp opt-out keyword matching.
 *
 * The keyword set is DATA (read from the `whatsapp.opt_out_keywords` platform
 * setting — see `settings.registry.ts`), never hardcoded here, so it can be
 * extended (new terms, dialects) without a deploy.
 *
 * Matching is EXACT on the whole (normalized) message, not a substring
 * search — the standard opt-out UX is a customer texting just "STOP", and
 * substring matching would false-positive on an unrelated sentence that
 * happens to contain a keyword-shaped word.
 */

/**
 * Trim, collapse internal whitespace, strip trailing punctuation (Latin and
 * Arabic), and lowercase. `.toLowerCase()` is a safe no-op on Arabic script
 * (no case distinction), so this one normalizer covers both scripts.
 */
function normalizeForOptOutMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!؟?,،]+$/g, '')
    .trim();
}

/** Parses the comma-separated setting value into a normalized, de-duplicated keyword list. */
export function parseOptOutKeywords(keywordsCsv: string): string[] {
  return Array.from(
    new Set(
      keywordsCsv
        .split(',')
        .map((k) => normalizeForOptOutMatch(k))
        .filter(Boolean),
    ),
  );
}

/** True when `content` (an inbound message) exactly matches one of the configured opt-out keywords, after normalization. */
export function isOptOutMessage(content: string, keywordsCsv: string): boolean {
  const normalized = normalizeForOptOutMatch(content);
  if (!normalized) return false;
  return parseOptOutKeywords(keywordsCsv).includes(normalized);
}
