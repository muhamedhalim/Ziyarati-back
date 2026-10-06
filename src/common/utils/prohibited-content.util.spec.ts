import {
  containsClinicalTerm,
  findProhibitedIdentifiers,
  redactProhibitedIdentifiers,
} from './prohibited-content.util';

describe('findProhibitedIdentifiers', () => {
  it.each([
    [
      'Saudi national ID / Iqama',
      'Your ID 1012345678 is registered',
      'national_id',
    ],
    ['Egyptian national ID', 'ID: 29801011234567', 'national_id'],
    ['Arabic-Indic national ID', 'الهوية ١٠١٢٣٤٥٦٧٨', 'national_id'],
    ['card number', 'card 4111 1111 1111 1111', 'card_number'],
    ['insurance number', 'Insurance number: BUPA-998877', 'insurance_number'],
    ['Arabic insurance number', 'رقم التأمين: AB12345', 'insurance_number'],
    [
      'bearer credential',
      'Authorization: Bearer abcdefghijklmnop',
      'credential',
    ],
  ])('flags a %s', (_label, text, category) => {
    expect(findProhibitedIdentifiers(text)).toContain(category);
  });

  it('does not flag a phone number, a date, an amount or an appointment time', () => {
    for (const text of [
      'call 0501234567',
      'call +966 50 123 4567',
      'on 2026-10-07 at 09:30',
      'total SAR 1,250.00',
      'slot 3f2b8c4d-1a2b-4c3d-9e8f-0a1b2c3d4e5f',
      'booking ref 20261007',
    ]) {
      expect(findProhibitedIdentifiers(text)).toEqual([]);
    }
  });

  it('is empty for empty input', () => {
    expect(findProhibitedIdentifiers('')).toEqual([]);
  });
});

describe('containsClinicalTerm', () => {
  it.each([
    'your lab results are ready',
    'Your prescription is ready for pickup',
    'following your diagnosis',
    'نتائج التحاليل جاهزة',
    'تم تحديث وصفة طبية',
  ])('flags "%s"', (text) => {
    expect(containsClinicalTerm(text)).toBe(true);
  });

  it.each([
    'Your appointment is confirmed for 09:30',
    'Dental cleaning',
    'علاج الأسنان',
    'Please arrive 10 minutes early',
    'Hiverton Clinic',
  ])('does not flag "%s"', (text) => {
    expect(containsClinicalTerm(text)).toBe(false);
  });
});

describe('redactProhibitedIdentifiers', () => {
  it('replaces identifiers and keeps the rest of the sentence', () => {
    expect(
      redactProhibitedIdentifiers(
        'Your ID 1012345678 and card 4111111111111111 were updated.',
      ),
    ).toBe('Your ID [REDACTED] and card [REDACTED] were updated.');
  });

  it('leaves clean text and phone numbers untouched', () => {
    const text = 'Call us on 0501234567 about booking 2026-10-07.';
    expect(redactProhibitedIdentifiers(text)).toBe(text);
  });
});
