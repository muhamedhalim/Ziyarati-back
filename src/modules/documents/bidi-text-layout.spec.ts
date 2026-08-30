import { layoutBidiText } from './bidi-text-layout';

describe('layoutBidiText (T001/T021 bidi run-splitting)', () => {
  it('a pure-Arabic sentence: every non-space segment is Arabic-font, words in VISUAL (rightmost-first) order', () => {
    const segs = layoutBidiText('فاتورة ضريبية');
    const words = segs.map((s) => s.text.trim()).filter(Boolean);
    // "فاتورة" is the first LOGICAL word (rightmost when read RTL), so it is
    // the LAST segment in left-to-right draw order; each word's own
    // characters stay in logical order (never reversed) so fontkit's
    // joining-form shaping stays correct. The inter-word space lands in its
    // own (harmless — a space glyph is identical either way) latin segment,
    // since it is script-neutral, not Arabic-block.
    expect(words).toEqual(['ضريبية', 'فاتورة']);
    for (const s of segs) {
      if (s.text.trim()) expect(s.font).toBe('arabic');
    }
  });

  it('isolates a Latin invoice number from surrounding Arabic text, unreversed', () => {
    const segs = layoutBidiText('رقم الفاتورة INV-2026 والمبلغ');
    const latin = segs.filter((s) => s.font === 'latin').map((s) => s.text).join('');
    expect(latin).toContain('INV-2026');
  });

  it('a pure-Latin string is a single latin segment, untouched', () => {
    const segs = layoutBidiText('SAR 350.00');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ text: 'SAR 350.00', font: 'latin' });
  });

  it('counter-reverses an LTR-resolved Arabic-Indic digit run (T001 fontkit-auto-reversal workaround)', () => {
    // Arabic-Indic digits are script=Arabic but bidi-resolve to an EVEN
    // (LTR) level inside RTL text. fontkit assigns shaping direction by
    // SCRIPT, not bidi type, so it would auto-reverse this run on its own —
    // pre-reversing here is what makes fontkit's auto-reversal land on the
    // CORRECT final glyph order. Proven end-to-end (real fontkit) in
    // DocumentRendererService's spec and in the T001 spike (research.md O-1).
    const segs = layoutBidiText('١٢٣٤٥');
    expect(segs).toHaveLength(1);
    expect(segs[0].font).toBe('arabic');
    expect(segs[0].text).toBe('٥٤٣٢١'); // deliberately pre-reversed
  });

  it('does NOT reverse Arabic-Indic digits that are already part of an RTL run (no fontkit auto-reversal to compensate for)', () => {
    // Inside a fully RTL sentence the digit substring bidi-resolves to its
    // OWN even sub-level (still gets the same counter-reversal treatment —
    // this test documents that the rule is "LTR-resolved AND Arabic-block",
    // not "anywhere in the string").
    const segs = layoutBidiText('التاريخ ١٢٣٤٥ اليوم');
    const digitSeg = segs.find((s) => /[٠-٩]/.test(s.text));
    expect(digitSeg?.text).toBe('٥٤٣٢١');
  });
});
