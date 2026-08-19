export interface AiEvaluationCase {
  id: string;
  language: 'ar' | 'en';
  channel: 'API' | 'WEBSITE' | 'WHATSAPP';
  capability: 'booking' | 'faq' | 'tool_calling' | 'handover' | 'rag' | 'multi_turn';
  turns: string[];
  /**
   * MECHANICAL expectations only — things a script can check without judging
   * prose. Used by the opt-in live benchmark to compare a candidate model
   * against the incumbent on capability PARITY, which is the part that can be
   * asserted. Answer quality itself is reported for a human to read, never
   * scored by another model (a model must not be the control that decides
   * whether a model is good enough).
   */
  expect: {
    /** The reply should be in the same language the customer wrote in. */
    repliesInSameLanguage: boolean;
    /** The model should emit at least one tool call to serve this turn. */
    emitsToolCall: boolean;
  };
}

/** Provider-neutral, non-PHI smoke set. */
export const AI_EVALUATION_CASES: AiEvaluationCase[] = [
  {
    id: 'ar-booking', language: 'ar', channel: 'WHATSAPP', capability: 'booking',
    turns: ['أريد حجز موعد غدًا', 'الساعة الخامسة مساءً'],
    expect: { repliesInSameLanguage: true, emitsToolCall: true },
  },
  {
    id: 'en-booking', language: 'en', channel: 'WEBSITE', capability: 'tool_calling',
    turns: ['Book the next available dental appointment'],
    expect: { repliesInSameLanguage: true, emitsToolCall: true },
  },
  {
    id: 'ar-faq-rag', language: 'ar', channel: 'API', capability: 'rag',
    turns: ['ما هي مواعيد العمل يوم الجمعة؟'],
    expect: { repliesInSameLanguage: true, emitsToolCall: false },
  },
  {
    id: 'en-faq', language: 'en', channel: 'API', capability: 'faq',
    turns: ['What documents should I bring?'],
    expect: { repliesInSameLanguage: true, emitsToolCall: false },
  },
  {
    id: 'ar-handover', language: 'ar', channel: 'WHATSAPP', capability: 'handover',
    turns: ['أريد التحدث مع موظف'],
    expect: { repliesInSameLanguage: true, emitsToolCall: false },
  },
  {
    id: 'en-multiturn', language: 'en', channel: 'WEBSITE', capability: 'multi_turn',
    turns: ['I need a dermatologist', 'Prefer the downtown branch', 'Tomorrow afternoon'],
    expect: { repliesInSameLanguage: true, emitsToolCall: false },
  },
];

/** True when `text` contains at least one Arabic-script character. */
export function containsArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

/**
 * Whether a reply answered in the language it was asked in. Deliberately a
 * script-range check, not a language model: for the AR/EN pair this product
 * actually serves, script presence is an unambiguous signal, and a benchmark
 * that used a model to grade a model would inherit exactly the failure mode it
 * exists to detect.
 */
export function repliesInSameLanguage(
  language: 'ar' | 'en',
  reply: string,
): boolean {
  if (!reply.trim()) return false;
  return language === 'ar' ? containsArabic(reply) : !containsArabic(reply);
}
