export interface AiEvaluationCase {
  id: string;
  language: 'ar' | 'en';
  channel: 'API' | 'WEBSITE' | 'WHATSAPP';
  capability: 'booking' | 'faq' | 'tool_calling' | 'handover' | 'rag' | 'multi_turn';
  turns: string[];
}

/** Provider-neutral, non-PHI smoke set. Live semantic scoring is intentionally pending credits. */
export const AI_EVALUATION_CASES: AiEvaluationCase[] = [
  { id: 'ar-booking', language: 'ar', channel: 'WHATSAPP', capability: 'booking', turns: ['أريد حجز موعد غدًا', 'الساعة الخامسة مساءً'] },
  { id: 'en-booking', language: 'en', channel: 'WEBSITE', capability: 'tool_calling', turns: ['Book the next available dental appointment'] },
  { id: 'ar-faq-rag', language: 'ar', channel: 'API', capability: 'rag', turns: ['ما هي مواعيد العمل يوم الجمعة؟'] },
  { id: 'en-faq', language: 'en', channel: 'API', capability: 'faq', turns: ['What documents should I bring?'] },
  { id: 'ar-handover', language: 'ar', channel: 'WHATSAPP', capability: 'handover', turns: ['أريد التحدث مع موظف'] },
  { id: 'en-multiturn', language: 'en', channel: 'WEBSITE', capability: 'multi_turn', turns: ['I need a dermatologist', 'Prefer the downtown branch', 'Tomorrow afternoon'] },
];
