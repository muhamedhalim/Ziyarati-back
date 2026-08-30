import { ACTIVITY_VISIBLE_AUDIT_ACTIONS, isActivityVisible } from './activity-allowlist';

describe('activity-allowlist (T023, FR-U007)', () => {
  it('an unlisted action is invisible — the default is exclusion', () => {
    expect(isActivityVisible('some.brand_new.action_nobody_reviewed')).toBe(false);
    expect(isActivityVisible('')).toBe(false);
  });

  it('every listed action is visible', () => {
    for (const action of ACTIVITY_VISIBLE_AUDIT_ACTIONS) {
      expect(isActivityVisible(action)).toBe(true);
    }
  });

  it('the list has no duplicates', () => {
    expect(new Set(ACTIVITY_VISIBLE_AUDIT_ACTIONS).size).toBe(
      ACTIVITY_VISIBLE_AUDIT_ACTIONS.length,
    );
  });
});
