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

    // FND-043 (AD-05): email is now PII-redacted via the exact-match set —
    // this assertion previously encoded the pre-fix (insecure) behavior; see
    // the dedicated "PII redaction (FND-043)" block below for full coverage.
    expect(out.email).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.password_hash).toBe('[REDACTED]');
    expect(out.newPassword).toBe('[REDACTED]');
    expect(out.accessToken).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.cvv).toBe('[REDACTED]');
  });

  it('redacts cookies, hyphenated headers, and payment-data fields', () => {
    const out = sanitizeForLog({
      cookie: 'session=abc',
      Cookie: 'session=abc',
      'set-cookie': 'refresh_token=xyz',
      'x-api-key': 'k',
      'Authorization-Token': 'z',
      refreshToken: 'r',
      creditCardNumber: '4111111111111111',
      cvc: '123',
      iban: 'SA0000000000000000000000',
      bankAccountNumber: '12345',
      routingNumber: '999',
      clientSecret: 's',
      ssn: '000-00-0000',
      email: 'a@b.com',
    }) as Record<string, unknown>;

    for (const key of [
      'cookie',
      'Cookie',
      'set-cookie',
      'x-api-key',
      'Authorization-Token',
      'refreshToken',
      'creditCardNumber',
      'cvc',
      'iban',
      'bankAccountNumber',
      'routingNumber',
      'clientSecret',
      'ssn',
    ]) {
      expect(out[key]).toBe('[REDACTED]');
    }
    // FND-043 (AD-05): see note in the previous test — email is PII now.
    expect(out.email).toBe('[REDACTED]');
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

  // ── FND-043 — RED: SENSITIVE_KEY_PATTERNS (substring-matched) has no PII
  // entries at all. AD-05: the fix must NOT simply add 'email' etc. to that
  // substring list — see the regression-guard case below for exactly why —
  // it needs a SEPARATE, exact-match PII pattern set evaluated alongside it.
  describe('PII redaction (FND-043)', () => {
    it('[FND-043] redacts email, phone, full_name, and date_of_birth — case/separator naming variants, nested objects, and arrays', () => {
      const out = sanitizeForLog({
        email: 'patient@example.test',
        Email: 'patient@example.test',
        phone: '+966500000000',
        Phone: '+966500000000',
        full_name: 'Sara Ahmed',
        fullName: 'Sara Ahmed',
        date_of_birth: '1990-01-01',
        dateOfBirth: '1990-01-01',
        nested: { email: 'x@y.com', phone: '000' },
        list: [{ full_name: 'Zed', date_of_birth: '2000-01-01' }],
      }) as any;

      expect(out.email).toBe('[REDACTED]');
      expect(out.Email).toBe('[REDACTED]');
      expect(out.phone).toBe('[REDACTED]');
      expect(out.Phone).toBe('[REDACTED]');
      expect(out.full_name).toBe('[REDACTED]');
      expect(out.fullName).toBe('[REDACTED]');
      expect(out.date_of_birth).toBe('[REDACTED]');
      expect(out.dateOfBirth).toBe('[REDACTED]');
      expect(out.nested.email).toBe('[REDACTED]');
      expect(out.nested.phone).toBe('[REDACTED]');
      expect(out.list[0].full_name).toBe('[REDACTED]');
      expect(out.list[0].date_of_birth).toBe('[REDACTED]');
    });

    // This is the case that makes "just add 'email' to the substring list" a
    // regression rather than a fix: emailEnabled/emailProvider/emailTemplateId
    // are operational config keys (not PII) that a substring match on 'email'
    // would ALSO redact, destroying exactly the diagnostics an engineer needs
    // when debugging a delivery failure. Passes today (list is untouched) —
    // must still pass once the exact-match set is added (AD-05).
    it('[FND-043/AD-05] does NOT redact operational keys that merely contain "email" as a substring', () => {
      const out = sanitizeForLog({
        emailEnabled: true,
        emailProvider: 'resend',
        emailTemplateId: 'tmpl-1',
        emailDefaultLocale: 'en',
      }) as any;

      expect(out.emailEnabled).toBe(true);
      expect(out.emailProvider).toBe('resend');
      expect(out.emailTemplateId).toBe('tmpl-1');
      expect(out.emailDefaultLocale).toBe('en');
    });
  });
});
