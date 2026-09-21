/**
 * The output-side "did the reply recite the prompt or the tool catalogue?" check.
 *
 * Pure and dependency-free, and deliberately NOT a model call (a model must not be
 * the control that decides whether a model leaked — AI-009, FR-092/093). Split out
 * of `AiExecutionService` so the streaming gate and the two whole-reply call sites
 * share ONE index built once per turn iteration, and so it can be tested without
 * booting the engine.
 *
 * THREE INDEPENDENT SIGNALS — any one blocks:
 *
 *  1. VERBATIM (AI-009, unchanged): the share of the reply's `span`-word runs
 *     (default 8) that also occur in the source, at or above `threshold`. Catches a
 *     straight copy.
 *
 *  2. NEAR-VERBATIM (F-11): the share of the reply's WORDS that sit inside a
 *     3-word run also found in the source, at or above 0.7, for a reply of at
 *     least 20 words. Signal 1 was defeated by dropping every 5th word — no 8-word
 *     run survives — while the prompt still leaked in full. Counting how much of
 *     the reply is covered by short matching runs is not fooled by gaps: every
 *     4-word stretch between two gaps still matches, so the whole reply is
 *     covered. (A gap every 3rd word leaves no 3-word run at all — a copy that
 *     mangled is a paraphrase, which no lexical check can catch.) The word floor
 *     stops a short answer that merely shares a stock phrase from tripping it.
 *
 *  3. INTERNAL IDENTIFIERS (F-11): a reply naming three or more DISTINCT names
 *     that exist only inside the prompt or the tool catalogue (`list_cities`,
 *     `priceStatus`, `NOT_PUBLISHED`). A person talking to a clinic assistant never
 *     needs one; a list of them is the catalogue leaking — and it needs no long
 *     run of words, so signals 1-2 cannot see it (a plain list of tool names passed
 *     the filter). Only names that appear in the SYSTEM PROMPT or as TOOL NAMES
 *     count, not every field of every tool schema: `appointmentId` and `startAt`
 *     are also keys in results a staff member legitimately asks to see.
 *
 * WHAT THIS IS NOT. A lexical check cannot stop a determined extraction — a
 * paraphrase, a translation or a rewording defeats all three. The real defence is
 * that the prompt holds policy, not secrets, and that an explicit request to reveal
 * it never reaches the model on the public/WhatsApp surfaces (`scope-guard.ts`).
 * This catches the dump, not the summary.
 */

export interface DisclosureIndex {
  /** Word-run length for signal 1 (AI_PROMPT_SIMILARITY_SHINGLE_SPAN). */
  span: number;
  /** Overlap ratio for signal 1 (AI_PROMPT_SIMILARITY_THRESHOLD). */
  threshold: number;
  runs: Set<string>;
  shortRuns: Set<string>;
  identifiers: Set<string>;
}

export interface DisclosureVerdict {
  blocked: boolean;
  /** Signal 1's ratio (kept for callers/telemetry that already read it). */
  overlapRatio: number;
  reason?: 'verbatim' | 'near-verbatim' | 'identifiers';
}

/** Signal 2: run length, the covered share of the reply that blocks, and the fewest words a reply must have to be judged. */
export const NEAR_VERBATIM_SPAN = 3;
export const NEAR_VERBATIM_THRESHOLD = 0.7;
export const NEAR_VERBATIM_MIN_WORDS = 20;
/** Signal 3: distinct internal identifiers that make a reply a leak. */
export const IDENTIFIER_HITS_TO_BLOCK = 3;

/**
 * snake_case (`list_cities`), CONSTANT_CASE (`NOT_PUBLISHED`) and camelCase
 * (`priceStatus`) — the shapes the prompt and the catalogue use for their own
 * vocabulary and ordinary prose never does.
 */
const IDENTIFIER =
  /\b(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g;

/**
 * Lowercased, punctuation-stripped word list — the unit is a word, not a
 * character. Unicode-aware (`\p{L}`/`\p{N}`): an ASCII-only version strips every
 * Arabic character to nothing, so a reply that reproduced an Arabic prompt
 * produced zero runs and was never blocked (AIE-A01).
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Sliding word n-grams. A text shorter than `span` yields one run (itself). */
export function runsOf(text: string, span: number): string[] {
  const list = words(text);
  if (list.length === 0) return [];
  if (list.length < span) return [list.join(' ')];
  const out: string[] = [];
  for (let i = 0; i <= list.length - span; i += 1) {
    out.push(list.slice(i, i + span).join(' '));
  }
  return out;
}

function identifiersIn(text: string): string[] {
  return (text.match(IDENTIFIER) ?? []).map((t) => t.toLowerCase());
}

export function buildDisclosureIndex(
  systemPrompt: string | undefined,
  tools: ReadonlyArray<{ name: string }>,
  options: { span: number; threshold: number },
): DisclosureIndex {
  const prompt = systemPrompt ?? '';
  // Signals 1-2 see the tool schemas too (a schema recited in prose is a leak).
  const source = `${prompt}\n${JSON.stringify(tools)}`;
  const identifiers = new Set(identifiersIn(prompt));
  for (const tool of tools) {
    if (tool.name.includes('_')) identifiers.add(tool.name.toLowerCase());
  }
  return {
    span: options.span,
    threshold: options.threshold,
    runs: new Set(runsOf(source, options.span)),
    shortRuns: new Set(runsOf(source, NEAR_VERBATIM_SPAN)),
    identifiers,
  };
}

function overlap(replyRuns: string[], source: Set<string>): number {
  if (replyRuns.length === 0) return 0;
  let hits = 0;
  for (const run of replyRuns) if (source.has(run)) hits += 1;
  return hits / replyRuns.length;
}

/**
 * Share of the reply's words that belong to at least one `span`-word run present
 * in the source. Unlike `overlap` it counts WORDS, so a reply with holes in it
 * still scores by how much of it is copied text rather than by how many of its
 * runs happen to straddle a hole.
 */
export function coverage(
  replyWords: string[],
  source: Set<string>,
  span: number,
): number {
  if (replyWords.length < span) return 0;
  const covered = new Array<boolean>(replyWords.length).fill(false);
  for (let i = 0; i <= replyWords.length - span; i += 1) {
    if (source.has(replyWords.slice(i, i + span).join(' '))) {
      for (let j = i; j < i + span; j += 1) covered[j] = true;
    }
  }
  return covered.filter(Boolean).length / replyWords.length;
}

export function checkDisclosure(
  index: DisclosureIndex,
  reply: string,
): DisclosureVerdict {
  if (index.runs.size === 0 || !reply)
    return { blocked: false, overlapRatio: 0 };

  const overlapRatio = overlap(runsOf(reply, index.span), index.runs);
  if (overlapRatio >= index.threshold) {
    return { blocked: true, overlapRatio, reason: 'verbatim' };
  }

  const replyWords = words(reply);
  if (
    replyWords.length >= NEAR_VERBATIM_MIN_WORDS &&
    coverage(replyWords, index.shortRuns, NEAR_VERBATIM_SPAN) >=
      NEAR_VERBATIM_THRESHOLD
  ) {
    return { blocked: true, overlapRatio, reason: 'near-verbatim' };
  }

  const named = new Set(
    identifiersIn(reply).filter((token) => index.identifiers.has(token)),
  );
  if (named.size >= IDENTIFIER_HITS_TO_BLOCK) {
    return { blocked: true, overlapRatio, reason: 'identifiers' };
  }
  return { blocked: false, overlapRatio };
}
