import { changedFields } from './activity-redaction';

describe('changedFields (T023, S7)', () => {
  it('returns only key names, never returns a value', () => {
    const fields = changedFields(
      { plan_id: 'basic', api_key: 'sk_live_super_secret' },
      { plan_id: 'pro', api_key: 'sk_live_super_secret' },
    );
    expect(fields).toEqual(['api_key', 'plan_id']);
    // Structurally impossible to leak a value: the function's return type is
    // string[] of key names — but assert on the actual output too.
    expect(fields.join('')).not.toContain('sk_live_super_secret');
  });

  it('a payload containing a secret-shaped key yields only its name', () => {
    const fields = changedFields(null, {
      password: 'hunter2',
      token_digest: 'abc',
    });
    expect(fields).toEqual(['password', 'token_digest']);
  });

  it('handles null/undefined before and after', () => {
    expect(changedFields(null, null)).toEqual([]);
    expect(changedFields(undefined, undefined)).toEqual([]);
    expect(changedFields({ a: 1 }, null)).toEqual(['a']);
    expect(changedFields(null, { b: 2 })).toEqual(['b']);
  });

  it('sorts the result deterministically', () => {
    expect(changedFields({ zeta: 1, alpha: 2 }, {})).toEqual(['alpha', 'zeta']);
  });

  it('never descends into nested objects — depth 1 only, so a nested credential cannot surface even as a key path', () => {
    const fields = changedFields(
      { config: { secret: 'x' } },
      { config: { secret: 'y', extra: 'z' } },
    );
    expect(fields).toEqual(['config']);
  });
});
