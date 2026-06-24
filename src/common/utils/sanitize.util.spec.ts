import { sanitizeForLog } from './sanitize.util';

describe('sanitizeForLog', () => {
  it('passes through primitives and null', () => {
    expect(sanitizeForLog('hello')).toBe('hello');
    expect(sanitizeForLog(42)).toBe(42);
    expect(sanitizeForLog(null)).toBeNull();
    expect(sanitizeForLog(true)).toBe(true);
  });

  it('redacts sensitive keys (case-insensitive, substring match)', () => {
    const out = sanitizeForLog({
      email: 'a@b.com',
      password: 'secret',
      password_hash: 'x',
      newPassword: 'y',
      accessToken: 'tok',
      Authorization: 'Bearer z',
      apiKey: 'k',
      api_key: 'k2',
      cvv: '123',
    }) as Record<string, unknown>;

    expect(out.email).toBe('a@b.com');
    expect(out.password).toBe('[REDACTED]');
    expect(out.password_hash).toBe('[REDACTED]');
    expect(out.newPassword).toBe('[REDACTED]');
    expect(out.accessToken).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.cvv).toBe('[REDACTED]');
  });

  it('recurses into nested objects and arrays', () => {
    const out = sanitizeForLog({
      user: { name: 'x', token: 't' },
      items: [{ secret: 's', ok: 1 }],
    }) as any;
    expect(out.user.name).toBe('x');
    expect(out.user.token).toBe('[REDACTED]');
    expect(out.items[0].secret).toBe('[REDACTED]');
    expect(out.items[0].ok).toBe(1);
  });

  it('caps recursion depth to avoid huge/cyclic payloads', () => {
    // Build an object nested deeper than MAX_DEPTH (6).
    let deep: any = { leaf: true };
    for (let i = 0; i < 8; i += 1) deep = { nested: deep };
    const out = JSON.stringify(sanitizeForLog(deep));
    expect(out).toContain('[Truncated]');
  });
});
