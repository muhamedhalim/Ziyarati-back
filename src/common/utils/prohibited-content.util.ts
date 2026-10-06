import { DIGIT_RUN_SOURCE, toAsciiDigits } from './log-scrubber.util';

/**
 * Content that must not travel over a patient-messaging channel (WhatsApp,
 * email) whatever the template says (residency plan P5 / P8).
 *
 * Two families, deliberately kept apart because they fail differently:
 *
 *  - IDENTIFIERS (national ID / Iqama, card number, insurance number, bearer
 *    credentials) are recognised by SHAPE and can be detected reliably. They
 *    are blocked wherever they appear.
 *  - CLINICAL TERMS (diagnosis, prescription, result, medication ...) are a
 *    word list. A word list will always have false positives and false
 *    negatives, so it is applied only to structured VARIABLE values, never to
 *    the tenant's own approved template body, and its result names only the
 *    category — never the matched text.
 *
 * Nothing here is a legal determination of what a clinic may message; it is a
 * conservative technical backstop. Whether a specialty or doctor name may be
 * sent is a policy question for counsel and is NOT inferred from the text.
 */

export type ProhibitedCategory =
  | 'national_id'
  | 'card_number'
  | 'insurance_number'
  | 'credential'
  | 'clinical_term';

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;
const BEARER_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;
const INSURANCE_RE =
  /\b(?:insurance|policy|member)\s*(?:no\.?|number|id|#)\s*[:=-]?\s*[A-Za-z0-9-]{5,}/i;
const INSURANCE_AR_RE =
  /(?:رقم\s*(?:التأمين|البوليصة|العضوية))\s*[:=-]?\s*[A-Za-z0-9٠-٩-]{5,}/;

/** Unambiguous result / medication / diagnosis vocabulary. English, then Arabic. */
export const CLINICAL_TERMS_EN = [
  'diagnosis',
  'diagnosed',
  'prescription',
  'prescribed',
  'medication',
  'medications',
  'lab result',
  'lab results',
  'test result',
  'test results',
  'biopsy',
  'chemotherapy',
  'radiotherapy',
  'hiv',
  'pregnancy',
  'pregnant',
];
export const CLINICAL_TERMS_AR = [
  'تشخيص',
  'وصفة طبية',
  'الوصفة الطبية',
  'نتيجة التحليل',
  'نتائج التحليل',
  'نتائج التحاليل',
  'نتيجة الفحص',
  'نتائج الفحص',
  'الأدوية',
  'دواء',
];

const CLINICAL_EN_RE = new RegExp(
  `\\b(?:${CLINICAL_TERMS_EN.map((t) => t.replace(/ /g, '\\s+')).join('|')})\\b`,
  'i',
);
const CLINICAL_AR_RE = new RegExp(CLINICAL_TERMS_AR.join('|'));

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function classifyDigitRun(match: string): ProhibitedCategory | null {
  const digits = toAsciiDigits(match).replace(/\D/g, '');
  const bare = !/[ +-]/.test(match);
  if (bare && digits.length === 10 && /^[12]/.test(digits))
    return 'national_id';
  if (bare && digits.length === 14 && /^[23]/.test(digits))
    return 'national_id';
  if (digits.length >= 13 && luhn(digits)) return 'card_number';
  if (digits.length > 15) return 'national_id';
  return null;
}

/** Identifier categories present in `text`. Empty when it is clean. */
export function findProhibitedIdentifiers(text: string): ProhibitedCategory[] {
  if (!text) return [];
  const found = new Set<ProhibitedCategory>();
  for (const m of text.matchAll(new RegExp(DIGIT_RUN_SOURCE, 'g'))) {
    const category = classifyDigitRun(m[0]);
    if (category) found.add(category);
  }
  if (INSURANCE_RE.test(text) || INSURANCE_AR_RE.test(text)) {
    found.add('insurance_number');
  }
  if (JWT_RE.test(text) || BEARER_RE.test(text)) found.add('credential');
  return [...found];
}

/** True when `text` contains a clinical term from the conservative list. */
export function containsClinicalTerm(text: string): boolean {
  return !!text && (CLINICAL_EN_RE.test(text) || CLINICAL_AR_RE.test(text));
}

/**
 * `text` with every prohibited identifier replaced by `[REDACTED]` — used where
 * blocking the whole message would be worse than sending it without the
 * identifier (free-text email notices).
 */
export function redactProhibitedIdentifiers(text: string): string {
  if (!text) return text;
  return text
    .replace(new RegExp(DIGIT_RUN_SOURCE, 'g'), (m) =>
      classifyDigitRun(m) ? '[REDACTED]' : m,
    )
    .replace(new RegExp(INSURANCE_RE.source, 'gi'), '[REDACTED]')
    .replace(new RegExp(INSURANCE_AR_RE.source, 'g'), '[REDACTED]')
    .replace(new RegExp(JWT_RE.source, 'g'), '[REDACTED]')
    .replace(new RegExp(BEARER_RE.source, 'gi'), '[REDACTED]');
}
