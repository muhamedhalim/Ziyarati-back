/**
 * Handling for text the platform did not write but has to show the model:
 * retrieved knowledge, recalled memory, tool results, and the clinic-owned names
 * pinned into the booking context.
 *
 * Pure and dependency-free so the prompt builder, the booking-context builders
 * and the scope guard all apply exactly the same rules.
 */

/**
 * Characters that render as nothing. A model still reads them, which makes them
 * a way to put text in a prompt that no person reviewing the source can see:
 * zero-width space, word joiner, soft hyphen, the bidi embedding/override/isolate
 * controls and the Unicode "tag" block (U+E0000–U+E007F), whose characters map
 * one-to-one onto ASCII and are read back as ordinary letters.
 *
 * ZWNJ / ZWJ / LRM / RLM (U+200C–U+200F) are NOT in this set: Persian and some
 * Arabic orthography, and emoji sequences, use them legitimately. They are
 * tolerated inside a delimiter instead (see `PROMPT_DELIMITER_PATTERN`).
 */
const HIDDEN_CHARACTERS =
  /[\u00AD\u180E\u200B\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/gu;

/** Every invisible format character, including the joiners left alone above. */
const ALL_INVISIBLE_CHARACTERS =
  /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/gu;

export function stripHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, '');
}

/** Joiners / directional marks that may sit between the letters of a tag name. */
const JOINERS = '[\\u200C-\\u200F]*';
const GAP = '[\\s\\u200C-\\u200F]*';
/** `<`, and the full-width and small-form look-alikes a model reads the same way. */
const OPEN = '[<\\uFF1C\\uFE64]';
const CLOSE = '[>\\uFF1E\\uFE65]';
const TAG_NAMES = [
  'knowledge',
  'memory',
  'system',
  'assistant',
  'user',
  'tool',
  'developer',
]
  .map((name) => name.split('').join(JOINERS))
  .join('|');

/**
 * The wrapper tags the prompt builder uses, and the chat-template role markers
 * some models honour — in every spelling that still reads as the tag:
 * whitespace or joiners inside it, attributes, full-width brackets, and a tag
 * left unclosed at the end of a line.
 */
const PROMPT_DELIMITER_PATTERN = new RegExp(
  `${OPEN}${GAP}\\/?${GAP}(?:${TAG_NAMES})(?![A-Za-z0-9_])(?:[^<>\\uFF1C\\uFF1E\\uFE64\\uFE65]{0,200}${CLOSE}|(?=[^\\S\\n]*$))` +
    `|${OPEN}\\|[^|<>\\n]{0,40}\\|${CLOSE}`,
  'gimu',
);

const BRACKETS = /[<\uFF1C\uFE64]|[>\uFF1E\uFE65]/g;

/**
 * Makes third-party text unable to close (or reopen) the block it is quoted in.
 *
 * Retrieved knowledge and recalled memory are wrapped in `<knowledge>` /
 * `<memory>` and the model is told to treat everything between the tags as
 * data. That instruction is only as strong as the tags: a knowledge entry
 * containing the literal closing tag ended the block early, and whatever
 * followed it was read at the same level as the platform's own framing. On the
 * public assistant the knowledge belongs to whichever clinic the visitor
 * selected, so one clinic's text could address the shared assistant directly.
 *
 * Only the wrapper tags are rewritten, to a visibly inert form — ordinary angle
 * brackets, HTML in a policy document and every other visible character are
 * left exactly as written. Hidden characters are removed first, so a tag cannot
 * be disguised with them and text nobody can see never reaches the model.
 */
export function neutralizePromptDelimiters(text: string): string {
  return stripHiddenCharacters(text).replace(PROMPT_DELIMITER_PATTERN, (tag) =>
    tag.replace(BRACKETS, (c) => (/[<\uFF1C\uFE64]/.test(c) ? '‹' : '›')),
  );
}

/**
 * One short, single-line value for a SYSTEM message.
 *
 * A system message is the one place the model treats text as the platform's own
 * voice, so a clinic-owned name placed there must not be able to add a line,
 * carry a paragraph, or imitate the block's structure. Whitespace (including
 * every line break) collapses to single spaces, invisible characters go, wrapper
 * tags are neutralised and the value is cut to `max` characters.
 */
export function promptLine(text: string | null | undefined, max = 80): string {
  const flat = String(text ?? '')
    .replace(ALL_INVISIBLE_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim();
  return neutralizePromptDelimiters(flat).slice(0, max).trim();
}

/**
 * The form of a message the scope guard matches against — never the form that is
 * stored or sent to the model.
 *
 * The guard's patterns are plain ASCII / Arabic regular expressions, so every
 * one of them was defeated by a character that changes the bytes without
 * changing what a person (or the model) reads: a zero-width space inside
 * "ignore", full-width or mathematical letters, an Arabic tatweel or vowel mark
 * inside a keyword, or the whole instruction written in invisible tag
 * characters. This folds those back: compatibility-normalises (NFKC), decodes
 * tag characters to the ASCII they stand for, drops invisible characters, and
 * removes tatweel and Arabic vowel marks.
 */
export function normalizeForScreening(text: string): string {
  return (text ?? '')
    .replace(/[\u{E0020}-\u{E007E}]/gu, (c) =>
      String.fromCodePoint((c.codePointAt(0) ?? 0xe0020) - 0xe0000),
    )
    .normalize('NFKC')
    .replace(ALL_INVISIBLE_CHARACTERS, '')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\u0670/g, '');
}

/** ISO-8601 instant with seconds optional and an explicit offset or `Z`. */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * `new Date(x)` accepts far more than a timestamp ("see you at 5" parses), so a
 * value that is going to be stored and later shown to the model is checked
 * against the shape first.
 */
export function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_INSTANT.test(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}
