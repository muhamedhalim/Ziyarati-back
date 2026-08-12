import { constantTimeEqual } from './constant-time.util';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('a-shared-secret', 'a-shared-secret')).toBe(true);
  });

  it('returns false for same-length strings that differ', () => {
    expect(constantTimeEqual('a-shared-secretA', 'a-shared-secretB')).toBe(false);
  });

  it('returns false for different-length strings, without throwing', () => {
    expect(() => constantTimeEqual('short', 'a-much-longer-value')).not.toThrow();
    expect(constantTimeEqual('short', 'a-much-longer-value')).toBe(false);
  });

  it('returns false when one operand is empty and the other is not', () => {
    expect(constantTimeEqual('', 'non-empty')).toBe(false);
    expect(constantTimeEqual('non-empty', '')).toBe(false);
  });

  it('returns true for two empty strings — a defined, documented result', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('handles multi-byte UTF-8 (Arabic) content without throwing, comparing correctly', () => {
    expect(constantTimeEqual('مرحبا-بالعالم', 'مرحبا-بالعالم')).toBe(true);
    expect(constantTimeEqual('مرحبا-بالعالم', 'مرحبا-بالعالن')).toBe(false);
  });

  // No timing assertions — research.md R10 rejects them as inherently
  // CI-flaky; behaviour and structure are what is asserted, here and by the
  // permanent invariant (FR-039).
});
