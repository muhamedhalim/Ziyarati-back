import { assertDelay, normalizeConditions } from './rule-conditions';
import { findRuleDef, RULE_LIBRARY } from './rule-library.catalog';

const def = (key: string) => findRuleDef(key)!;

describe('rule conditions', () => {
  it('fills the defaults for a rule that sent nothing', () => {
    expect(normalizeConditions(def('patient_reengagement'), undefined)).toEqual(
      {
        sendWindow: { startHour: 9, endHour: 21 },
        inactivityDays: 180,
        cooldownDays: 90,
        dailyCap: 100,
      },
    );
  });

  it('keeps what the clinic set and defaults the rest', () => {
    expect(
      normalizeConditions(def('patient_reengagement'), {
        dailyCap: 25,
        inactivityDays: 365,
      }),
    ).toMatchObject({ dailyCap: 25, inactivityDays: 365, cooldownDays: 90 });
  });

  it.each([
    ['inactivityDays', 29],
    ['inactivityDays', 731],
    ['cooldownDays', 10],
    ['cooldownDays', 366],
    ['dailyCap', 0],
    ['dailyCap', 1001],
    ['dailyCap', 1.5],
    ['dailyCap', '50'],
  ])('refuses %s = %p', (key, value) => {
    expect(() =>
      normalizeConditions(def('patient_reengagement'), { [key]: value }),
    ).toThrow();
  });

  it('refuses a setting the rule does not have, rather than ignore it', () => {
    expect(() =>
      normalizeConditions(def('booking_confirmation'), { sendWindow: {} }),
    ).toThrow(/not a setting/);
    expect(() =>
      normalizeConditions(def('reminder_24h'), { dailyCap: 5 }),
    ).toThrow(/not a setting/);
  });

  it('refuses a malformed send window', () => {
    for (const sendWindow of [
      { startHour: 21, endHour: 9 },
      { startHour: 9, endHour: 9 },
      { startHour: 9, endHour: 25 },
      { startHour: '9', endHour: 21 },
      null,
      'always',
    ]) {
      expect(() =>
        normalizeConditions(def('reminder_24h'), { sendWindow }),
      ).toThrow();
    }
  });

  it('is data only: nothing in a condition is ever evaluated', () => {
    // A value that looks like code is just an invalid number.
    expect(() =>
      normalizeConditions(def('patient_reengagement'), {
        dailyCap: 'process.exit(1)',
      }),
    ).toThrow();
  });

  describe('delay', () => {
    it('accepts each rule’s default and refuses outside its range', () => {
      for (const d of RULE_LIBRARY)
        expect(() => assertDelay(d, d.defaultDelayMinutes)).not.toThrow();
      expect(() => assertDelay(def('post_visit_followup'), 29)).toThrow();
      expect(() => assertDelay(def('post_visit_followup'), 4321)).toThrow();
      expect(() => assertDelay(def('post_visit_followup'), 30)).not.toThrow();
      expect(() => assertDelay(def('booking_confirmation'), 61)).toThrow();
      expect(() => assertDelay(def('reminder_24h'), 1440.5)).toThrow();
    });
  });

  describe('the catalog itself', () => {
    it('defines six distinct rules whose defaults satisfy their own validation', () => {
      expect(RULE_LIBRARY).toHaveLength(6);
      expect(new Set(RULE_LIBRARY.map((d) => d.key)).size).toBe(6);
      for (const d of RULE_LIBRARY) {
        expect(() => normalizeConditions(d, d.defaultConditions)).not.toThrow();
        expect(() => assertDelay(d, d.defaultDelayMinutes)).not.toThrow();
      }
    });

    it('marks every marketing-content rule so consent is explained', () => {
      const marketing = RULE_LIBRARY.filter((d) => d.marketing).map(
        (d) => d.key,
      );
      expect(marketing).toEqual(
        expect.arrayContaining([
          'post_visit_followup',
          'followup_due',
          'scheduled_promotion',
          'patient_reengagement',
        ]),
      );
      expect(marketing).not.toContain('booking_confirmation');
      expect(marketing).not.toContain('reminder_24h');
    });

    it('every ready-made rule has its feature, so none is unavailable', () => {
      expect(
        RULE_LIBRARY.filter((d) => !d.available).map((d) => d.key),
      ).toEqual([]);
    });
  });
});
