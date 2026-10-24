import {
  beforeRowsPattern,
  buildRuleSourceRef,
  kindOfTrigger,
  parseRuleSourceRef,
  staleReason,
} from './rule-source-ref';

const START = new Date('2026-11-01T10:00:00Z');

describe('rule source_ref', () => {
  it('round-trips with and without a start epoch', () => {
    const a = buildRuleSourceRef({
      ruleId: 'r1',
      kind: 'before',
      appointmentId: 'a1',
      startEpoch: 123,
    });
    expect(a).toBe('rule:r1:before:a1:123');
    expect(parseRuleSourceRef(a)).toEqual({
      ruleId: 'r1',
      kind: 'before',
      appointmentId: 'a1',
      startEpoch: 123,
    });
    const b = buildRuleSourceRef({
      ruleId: 'r1',
      kind: 'completed',
      appointmentId: 'a1',
    });
    expect(parseRuleSourceRef(b)).toEqual({
      ruleId: 'r1',
      kind: 'completed',
      appointmentId: 'a1',
      startEpoch: undefined,
    });
  });

  it('is deterministic — the property the unique index relies on', () => {
    const one = buildRuleSourceRef({
      ruleId: 'r1',
      kind: 'confirmed',
      appointmentId: 'a1',
    });
    const two = buildRuleSourceRef({
      ruleId: 'r1',
      kind: 'confirmed',
      appointmentId: 'a1',
    });
    expect(one).toBe(two);
  });

  it('differs per rule, per appointment and per start time', () => {
    const base = {
      ruleId: 'r1',
      kind: 'before',
      appointmentId: 'a1',
      startEpoch: 1,
    };
    const refs = new Set([
      buildRuleSourceRef(base),
      buildRuleSourceRef({ ...base, ruleId: 'r2' }),
      buildRuleSourceRef({ ...base, appointmentId: 'a2' }),
      buildRuleSourceRef({ ...base, startEpoch: 2 }),
    ]);
    expect(refs.size).toBe(4);
  });

  it('refuses to parse anything that is not a rule key', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'appointment-reminder:a1:1440',
      'rule:x',
      'rule:a:b:c:d:e',
      'rule:a:b:c:nan',
    ]) {
      expect(parseRuleSourceRef(bad as string)).toBeNull();
    }
  });

  it('maps a trigger to its kind', () => {
    expect(kindOfTrigger('appointment.completed')).toBe('completed');
    expect(kindOfTrigger('appointment.no_show')).toBe('no_show');
  });

  it('the cancel pattern matches before-rows of one appointment only', () => {
    const pattern = beforeRowsPattern('a1');
    const re = new RegExp(`^${pattern.replace(/%/g, '.*')}$`);
    expect(re.test('rule:r1:before:a1:99')).toBe(true);
    expect(re.test('rule:r1:completed:a1')).toBe(false); // a post-visit row is NOT cancelled
    expect(re.test('rule:r1:before:a2:99')).toBe(false);
    expect(re.test('appointment-reminder:a1:1440')).toBe(false);
  });
});

describe('staleReason', () => {
  const ref = (kind: string, startEpoch?: number) => ({
    ruleId: 'r',
    kind,
    appointmentId: 'a',
    startEpoch,
  });

  it('a missing appointment is stale', () => {
    expect(staleReason(ref('before', 1), null)).toBe('APPOINTMENT_CHANGED');
  });

  it.each(['CANCELLED', 'NO_SHOW', 'COMPLETED'])(
    'a before-row is stale when the appointment is %s',
    (status) => {
      expect(
        staleReason(ref('before', START.getTime()), {
          status,
          start_at: START,
        }),
      ).toBe('APPOINTMENT_CHANGED');
    },
  );

  it('a before-row is stale when the appointment moved, fine when unchanged', () => {
    expect(
      staleReason(ref('before', START.getTime()), {
        status: 'CONFIRMED',
        start_at: new Date(START.getTime() + 60_000),
      }),
    ).toBe('APPOINTMENT_CHANGED');
    expect(
      staleReason(ref('before', START.getTime()), {
        status: 'CONFIRMED',
        start_at: START,
      }),
    ).toBeNull();
  });

  it('a completed-row needs a COMPLETED visit', () => {
    expect(
      staleReason(ref('completed'), { status: 'COMPLETED', start_at: START }),
    ).toBeNull();
    expect(
      staleReason(ref('completed'), { status: 'CANCELLED', start_at: START }),
    ).toBe('APPOINTMENT_CHANGED');
  });

  it('a confirmed-row survives a visit that already happened, but not a cancellation', () => {
    expect(
      staleReason(ref('confirmed'), { status: 'COMPLETED', start_at: START }),
    ).toBeNull();
    expect(
      staleReason(ref('confirmed'), { status: 'CANCELLED', start_at: START }),
    ).toBe('APPOINTMENT_CHANGED');
  });

  describe('a follow-up row (kind "followup", pinned to one date)', () => {
    const DUE = '2026-12-01';
    const EPOCH = Date.UTC(2026, 11, 1);
    const visit = (over: Record<string, unknown> = {}) => ({
      status: 'COMPLETED',
      start_at: START,
      follow_up_due_on: DUE,
      ...over,
    });

    it('is fine while the same date is still set on the completed visit', () => {
      expect(staleReason(ref('followup', EPOCH), visit())).toBeNull();
    });

    it('is stale when the clinician cleared the date', () => {
      expect(
        staleReason(ref('followup', EPOCH), visit({ follow_up_due_on: null })),
      ).toBe('APPOINTMENT_CHANGED');
    });

    it('is stale when the clinician moved the date', () => {
      expect(
        staleReason(
          ref('followup', EPOCH),
          visit({ follow_up_due_on: '2026-12-15' }),
        ),
      ).toBe('APPOINTMENT_CHANGED');
    });

    it('is stale when the visit is no longer completed, or is gone', () => {
      expect(
        staleReason(ref('followup', EPOCH), visit({ status: 'CANCELLED' })),
      ).toBe('APPOINTMENT_CHANGED');
      expect(staleReason(ref('followup', EPOCH), null)).toBe(
        'APPOINTMENT_CHANGED',
      );
    });

    it('round-trips through build/parse so dispatch can read the date back', () => {
      const key = buildRuleSourceRef({
        ruleId: 'r',
        kind: 'followup',
        appointmentId: 'a',
        startEpoch: EPOCH,
      });
      expect(parseRuleSourceRef(key)).toEqual({
        ruleId: 'r',
        kind: 'followup',
        appointmentId: 'a',
        startEpoch: EPOCH,
      });
    });
  });

  it('other kinds (e.g. a "your appointment moved" message) are never held back', () => {
    expect(
      staleReason(ref('rescheduled', 5), {
        status: 'CANCELLED',
        start_at: START,
      }),
    ).toBeNull();
  });
});
