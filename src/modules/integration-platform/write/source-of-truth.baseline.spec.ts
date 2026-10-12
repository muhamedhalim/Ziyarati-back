import { decideConflict, viewFingerprint } from './source-of-truth';
import { CONFLICT_POLICY } from '../integration-platform.constants';

describe('decideConflict — default policy with a sync baseline (F01)', () => {
  const current = { full_name: 'Amal', phone: '+966500000001' };
  const incoming = { full_name: 'Amal Khan', phone: '+966500000001' };

  it('reject_and_report REPORTS a divergence when the platform record may have been edited (no/stale baseline)', () => {
    const d = decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, incoming, current);
    expect(d).toEqual({ apply: false, report: true, changedFields: ['full_name'] });
    const d2 = decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, incoming, current, { platformUntouched: false });
    expect(d2.report).toBe(true);
  });

  it('reject_and_report APPLIES when the record is exactly what the integration last wrote', () => {
    const d = decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, incoming, current, { platformUntouched: true });
    expect(d).toEqual({ apply: true, report: false, changedFields: ['full_name'] });
  });

  it('does not change the other policies', () => {
    expect(decideConflict(CONFLICT_POLICY.PLATFORM_WINS, incoming, current, { platformUntouched: true })).toEqual({
      apply: false, report: false, changedFields: ['full_name'],
    });
    expect(decideConflict(CONFLICT_POLICY.EXTERNAL_WINS, incoming, current)).toEqual({
      apply: true, report: false, changedFields: ['full_name'],
    });
  });

  it('no difference is never a conflict, baseline or not', () => {
    expect(decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, { phone: '+966500000001' }, current)).toEqual({
      apply: false, report: false, changedFields: [],
    });
  });

  it('compares id lists as sets (order and duplicates are not a change)', () => {
    const cur = { serviceIds: ['a', 'b'] };
    expect(decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, { serviceIds: ['b', 'a', 'a'] }, cur).changedFields).toEqual([]);
    expect(decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, { serviceIds: ['a'] }, cur).changedFields).toEqual(['serviceIds']);
    expect(decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, { serviceIds: ['a', 'c'] }, cur).changedFields).toEqual(['serviceIds']);
    expect(decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, { serviceIds: [] }, { serviceIds: [] }).changedFields).toEqual([]);
  });
});

describe('viewFingerprint', () => {
  it('is stable, key-order independent and value-sensitive', () => {
    const a = viewFingerprint({ name: 'X', durationMinutes: 30, isActive: true });
    expect(viewFingerprint({ isActive: true, name: 'X', durationMinutes: 30 })).toBe(a);
    expect(viewFingerprint({ name: 'X', durationMinutes: 45, isActive: true })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats id lists as sets and null/undefined alike', () => {
    expect(viewFingerprint({ ids: ['b', 'a'] })).toBe(viewFingerprint({ ids: ['a', 'b'] }));
    expect(viewFingerprint({ n: null })).toBe(viewFingerprint({ n: undefined }));
  });

  it('does not contain the values (one-way)', () => {
    expect(viewFingerprint({ full_name: 'Sensitive Patient Name' })).not.toContain('Sensitive');
  });
});
