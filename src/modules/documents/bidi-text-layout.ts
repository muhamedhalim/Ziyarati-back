/**
 * Spec 014 (Clinic Platform Completion) — T021/T001. Bidi run-splitting for
 * `pdfkit` + `fontkit`, proven in the T001 spike (see research.md O-1 for
 * the full findings this codifies):
 *
 *  - `fontkit` shapes Arabic correctly (contextual joining + RTL glyph
 *    placement) when fed a LOGICAL-order substring — never reverse an
 *    Arabic-letter run's characters.
 *  - `fontkit` assigns shaping direction by Unicode SCRIPT, not bidi type,
 *    so an LTR-resolved run that is still Arabic-block (Arabic-Indic
 *    digits) gets auto-reversed by fontkit's own script detection unless
 *    counter-reversed here first.
 *  - The Arabic-subset font asset has no Latin/punctuation glyphs (and vice
 *    versa), so a mixed-script run must be split further into per-script
 *    segments, each drawn with the font that actually has its glyphs.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bidiFactory = require('bidi-js');
const bidi = bidiFactory();

export const ARABIC_BLOCK = /[؀-ۿ]/;

export interface BidiSegment {
  text: string;
  /** Which registered pdfkit font name to draw this segment with. */
  font: 'arabic' | 'latin';
}

interface BidiRun {
  text: string;
  rtl: boolean;
}

/** Runs in VISUAL (left-to-right draw) order; each run's `text` stays in
 *  logical order (never character-reversed). */
function bidiRuns(text: string): BidiRun[] {
  const embeddingLevelsResult = bidi.getEmbeddingLevels(text);
  const indices: number[] = bidi.getReorderedIndices(text, embeddingLevelsResult);
  const runs: BidiRun[] = [];
  let i = 0;
  while (i < indices.length) {
    const start = indices[i];
    let j = i;
    let dir = 0;
    while (j + 1 < indices.length) {
      const delta = indices[j + 1] - indices[j];
      if (delta !== 1 && delta !== -1) break;
      if (dir === 0) dir = delta;
      if (delta !== dir) break;
      j++;
    }
    const end = indices[j];
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    let runText = text.slice(lo, hi + 1);
    // Counter-reverse an LTR-resolved run that is still Arabic-block (see
    // module docblock) so fontkit's own auto-reversal cancels out.
    if (dir === 1 && ARABIC_BLOCK.test(runText)) {
      runText = [...runText].reverse().join('');
    }
    runs.push({ text: runText, rtl: dir === -1 });
    i = j + 1;
  }
  return runs;
}

/** Split one run into homogeneous-script segments, in VISUAL order — the
 *  Arabic-subset font has no Latin/punctuation glyphs, and bidi correctly
 *  keeps a neutral character (e.g. ':') attached to its surrounding run. */
function scriptSegments(run: BidiRun): BidiSegment[] {
  const parts = run.text.match(/[؀-ۿ]+|[^؀-ۿ]+/g) ?? [run.text];
  const segments: BidiSegment[] = parts.map((text) => ({
    text,
    font: ARABIC_BLOCK.test(text) ? 'arabic' : 'latin',
  }));
  return run.rtl ? segments.reverse() : segments;
}

/** The full pipeline: a logical-order string in, visual-order per-script
 *  draw segments out. Callers place these left-to-right starting from the
 *  computed left edge of a right-aligned line (see DocumentRendererService). */
export function layoutBidiText(text: string): BidiSegment[] {
  return bidiRuns(text).flatMap(scriptSegments);
}
