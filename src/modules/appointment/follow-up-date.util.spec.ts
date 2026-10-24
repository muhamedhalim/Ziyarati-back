import {
  FOLLOW_UP_MAX_DAYS,
  assertFollowUpDate,
  dateOnlyEpoch,
  localDateIn,
} from './follow-up-date.util';

describe('follow-up date helpers', () => {
  describe('dateOnlyEpoch', () => {
    it('is UTC midnight of a real date', () => {
      expect(dateOnlyEpoch('2026-12-01')).toBe(Date.UTC(2026, 11, 1));
    });

    it.each([
      '2026-02-31',
      '2026-13-01',
      '2026-00-10',
      '2026-1-1',
      'tomorrow',
      '',
    ])('is NaN for %p', (v) => {
      expect(dateOnlyEpoch(v)).toBeNaN();
    });

    it('accepts 29 February only in a leap year', () => {
      expect(dateOnlyEpoch('2028-02-29')).not.toBeNaN();
      expect(dateOnlyEpoch('2027-02-29')).toBeNaN();
    });
  });

  describe('localDateIn', () => {
    // 22:30Z on 31 Oct is already 1 Nov in Riyadh (UTC+3) but still 31 Oct in UTC.
    const instant = new Date('2026-10-31T22:30:00Z');

    it("is the clinic's wall-clock date, not the server's", () => {
      expect(localDateIn(instant, 'Asia/Riyadh')).toBe('2026-11-01');
      expect(localDateIn(instant, 'UTC')).toBe('2026-10-31');
    });

    it('falls back to UTC for a missing or unknown zone', () => {
      expect(localDateIn(instant, undefined)).toBe('2026-10-31');
      expect(localDateIn(instant, 'Not/AZone')).toBe('2026-10-31');
    });
  });

  describe('assertFollowUpDate', () => {
    const now = new Date('2026-10-31T22:30:00Z'); // 1 Nov in Riyadh

    it("accepts today in the clinic's zone, which can be tomorrow in UTC", () => {
      expect(() =>
        assertFollowUpDate('2026-11-01', 'Asia/Riyadh', now),
      ).not.toThrow();
    });

    it("rejects the clinic's yesterday", () => {
      expect(() =>
        assertFollowUpDate('2026-10-31', 'Asia/Riyadh', now),
      ).toThrow(/past/);
    });

    it('rejects an impossible date', () => {
      expect(() => assertFollowUpDate('2026-02-31', 'UTC', now)).toThrow(
        /valid/,
      );
    });

    it('allows the maximum horizon and rejects one day beyond', () => {
      const edge = new Date(
        Date.UTC(2026, 9, 31) + FOLLOW_UP_MAX_DAYS * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const over = new Date(
        Date.UTC(2026, 9, 31) + (FOLLOW_UP_MAX_DAYS + 1) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      expect(() => assertFollowUpDate(edge, 'UTC', now)).not.toThrow();
      expect(() => assertFollowUpDate(over, 'UTC', now)).toThrow(/far/);
    });
  });
});
