import { base32Encode, matchStep, totpAt } from './totp';

describe('totp (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA1 secret "12345678901234567890", 6-digit tail of the 8-digit vectors
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC vector at t=%i', (t, expected) => {
    expect(totpAt(secret, Math.floor(t / 30))).toBe(expected);
  });

  it('accepts ±1 step, rejects ±2 and malformed input', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(matchStep(secret, totpAt(secret, step), now)).toBe(step);
    expect(matchStep(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(matchStep(secret, totpAt(secret, step + 2), now)).toBeNull();
    expect(matchStep(secret, '12345', now)).toBeNull();
    expect(matchStep(secret, 'abcdef', now)).toBeNull();
  });
});
