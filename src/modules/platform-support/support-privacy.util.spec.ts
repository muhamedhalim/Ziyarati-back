import {
  isoOrNull,
  maskEmail,
  maskPersonName,
  maskPhone,
  sanitizeFailureReason,
  SUPPORT_FAILURE_REASON_MAX_LENGTH,
} from './support-privacy.util';

describe('support privacy helpers', () => {
  describe('maskPersonName', () => {
    it('keeps one initial per word so a support agent can confirm a match', () => {
      expect(maskPersonName('Mohamed Abdelhalim')).toBe('M*** A***');
      expect(maskPersonName('Sara')).toBe('S***');
    });

    it('handles Arabic exactly the same way — first grapheme kept, rest masked', () => {
      expect(maskPersonName('محمد عبدالحليم')).toBe('م*** ع***');
    });

    it('collapses irregular whitespace rather than emitting empty segments', () => {
      expect(maskPersonName('  Ali   Al  Otaibi ')).toBe('A*** A*** O***');
    });

    it('returns null for absent or blank input', () => {
      expect(maskPersonName(null)).toBeNull();
      expect(maskPersonName(undefined)).toBeNull();
      expect(maskPersonName('   ')).toBeNull();
    });
  });

  describe('maskEmail', () => {
    it('keeps the domain — the diagnostically useful half — and masks the local part', () => {
      expect(maskEmail('mohamed.halem@gmail.com')).toBe('m***@gmail.com');
    });

    it('strips a +alias along with the local part, since an alias often contains a real name', () => {
      expect(maskEmail('mohamed+clinicvisit@gmail.com')).toBe('m***@gmail.com');
    });

    it('discloses nothing when the value is not address-shaped', () => {
      expect(maskEmail('not-an-address')).toBe('***');
      expect(maskEmail('@nolocal.com')).toBe('***');
    });

    it('returns null for absent input', () => {
      expect(maskEmail(null)).toBeNull();
    });
  });

  describe('maskPhone', () => {
    it('keeps the country/operator prefix and the last three digits', () => {
      expect(maskPhone('+966501234567')).toBe('+9665*****567');
    });

    it('fully masks a short value rather than partially revealing it', () => {
      expect(maskPhone('1234567')).toBe('*******');
    });

    it('returns null for absent input', () => {
      expect(maskPhone('')).toBeNull();
    });
  });

  describe('sanitizeFailureReason', () => {
    it('KEEPS the diagnosis when a credential word appears without a value', () => {
      // The whole point of the failure reason. An earlier over-broad pattern
      // turned this into "Meta error 190: [redacted]", removing the one fact
      // the support agent opened the page for.
      expect(sanitizeFailureReason('Meta error 190: token expired')).toBe(
        'Meta error 190: token expired',
      );
      expect(sanitizeFailureReason('invalid token supplied')).toBe('invalid token supplied');
    });

    it('redacts the VALUE of a key=value credential while keeping the key', () => {
      expect(sanitizeFailureReason('rejected token=re_live_abcdef')).toBe(
        'rejected token=[redacted]',
      );
      expect(sanitizeFailureReason('api_key: sk_live_9f8a7b6c5d')).toBe('api_key: [redacted]');
    });

    it('redacts a bearer credential', () => {
      expect(sanitizeFailureReason('Authorization Bearer eyJabc.def')).toContain('Bearer [redacted]');
    });

    it('collapses a whole URL, since query strings carry tokens and identifiers', () => {
      expect(
        sanitizeFailureReason('see https://api.moyasar.com/v1/payments/x?secret=sk_live_1'),
      ).toBe('see [url]');
    });

    it('redacts bare provider-key shapes that appear with no delimiter', () => {
      expect(sanitizeFailureReason('key sk_live_abcdefgh rejected')).toBe(
        'key [redacted] rejected',
      );
      expect(sanitizeFailureReason('EAAGabcdefghijkl is invalid')).toBe('[redacted] is invalid');
    });

    it('removes email addresses and long digit runs (phones, PANs, account numbers)', () => {
      expect(sanitizeFailureReason('failed for mohamed@gmail.com / 4111111111111111')).toBe(
        'failed for [email] / [number]',
      );
    });

    it('caps the length LAST, so a long value cannot smuggle an unredacted tail', () => {
      const long = `prefix ${'x'.repeat(400)} token=secretvalue`;
      const out = sanitizeFailureReason(long)!;

      expect(out.length).toBeLessThanOrEqual(SUPPORT_FAILURE_REASON_MAX_LENGTH + 1);
      expect(out).not.toContain('secretvalue');
      expect(out.endsWith('…')).toBe(true);
    });

    it('returns null for absent or blank input', () => {
      expect(sanitizeFailureReason(null)).toBeNull();
      expect(sanitizeFailureReason('   ')).toBeNull();
    });
  });

  describe('isoOrNull', () => {
    it('normalises Date and string inputs to ISO', () => {
      expect(isoOrNull(new Date('2026-08-01T10:00:00Z'))).toBe('2026-08-01T10:00:00.000Z');
      expect(isoOrNull('2026-08-01T10:00:00Z')).toBe('2026-08-01T10:00:00.000Z');
    });

    it('returns null for absent or unparseable input rather than "Invalid Date"', () => {
      expect(isoOrNull(null)).toBeNull();
      expect(isoOrNull('not a date')).toBeNull();
    });
  });
});
