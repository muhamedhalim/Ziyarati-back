/**
 * One phone-number rule for every person-identifying phone the API accepts
 * (patients, staff, public bookings) — CRM-PHONE-01: these fields used to take
 * any string up to their length cap, so "not-a-phone" became a patient's phone.
 *
 * Deliberately format-tolerant rather than strict E.164, because the numbers
 * already stored are in three shapes and all three are legitimate:
 *   - national, as typed at a Saudi front desk:   0500000000
 *   - international:                               +966 50 000 0000 / 00966…
 *   - WhatsApp ids (digits only, no plus):          966500000000
 * Converting between them needs the country, which a raw national number does
 * not carry (see `normalizeE164` in whatsapp/template-components.util.ts), so
 * nothing is rewritten here: the value is stored as given (trimmed).
 *
 * The rule: an optional leading `+`, then 7–15 digits (E.164's ceiling is 15),
 * which may be grouped by spaces, dashes, dots or parentheses. Letters, a `+`
 * anywhere but the start, and too few/too many digits are refused.
 */
export const PHONE_PATTERN = /^\+?(?:[\s().-]*\d){7,15}[\s().-]*$/;

export const PHONE_MESSAGE =
  'phone must be a phone number: 7–15 digits, optionally starting with + (spaces, dashes, dots and brackets allowed)';

/**
 * The digits of a phone number, for comparing two spellings of the same number
 * ("050 000 0000" vs "0500000000"). Never stored — only compared.
 */
export function phoneDigits(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\D/g, '');
}
