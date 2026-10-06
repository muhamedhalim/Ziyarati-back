import { sanitizeForLog, sanitizeUrlForLog } from './sanitize.util';

describe('sanitizeUrlForLog', () => {
  it('redacts the free-text search term but keeps path and every other param', () => {
    expect(
      sanitizeUrlForLog('/api/v1/crm/customers/search?q=29801011234567&page=2&limit=20&isActive=true'),
    ).toBe('/api/v1/crm/customers/search?q=[REDACTED]&page=2&limit=20&isActive=true');
  });

  it('never leaves the raw term anywhere in the output', () => {
    const out = sanitizeUrlForLog('/x?q=29801011234567');
    expect(out).not.toContain('29801011234567');
    expect(out).toBe('/x?q=[REDACTED]');
  });

  it('returns a URL without a query string unchanged', () => {
    expect(sanitizeUrlForLog('/api/v1/crm/customers/abc')).toBe('/api/v1/crm/customers/abc');
  });

  it('leaves params without an "=" and non-sensitive params byte-for-byte', () => {
    expect(sanitizeUrlForLog('/x?flag&page=1&tagIds=a%2Cb')).toBe('/x?flag&page=1&tagIds=a%2Cb');
  });

  it('handles encoded keys, array-style keys, and `search`', () => {
    expect(sanitizeUrlForLog('/x?%71=secret')).toBe('/x?%71=[REDACTED]');
    expect(sanitizeUrlForLog('/x?q[]=a&q[]=b')).toBe('/x?q[]=[REDACTED]&q[]=[REDACTED]');
    expect(sanitizeUrlForLog('/x?search=abc&page=1')).toBe('/x?search=[REDACTED]&page=1');
  });

  it('redacts credential-style params via the shared key rules', () => {
    expect(sanitizeUrlForLog('/x?access_token=abc&national_id=123&page=1')).toBe(
      '/x?access_token=[REDACTED]&national_id=[REDACTED]&page=1',
    );
  });

  it('does not throw on a malformed percent-escape in a key', () => {
    expect(() => sanitizeUrlForLog('/x?%E0%A4%A=1&q=1')).not.toThrow();
    expect(sanitizeUrlForLog('/x?%E0%A4%A=1&q=1')).toBe('/x?%E0%A4%A=1&q=[REDACTED]');
  });
});

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

    it('redacts national_id — naming variants, nested objects — without touching lookalike keys', () => {
      const out = sanitizeForLog({
        national_id: '29801011234567',
        nationalId: '29801011234567',
        NATIONAL_ID: '29801011234567',
        nested: { national_id: '1' },
        list: [{ nationalId: '2' }],
        // Not the identity number itself — must stay readable for diagnostics.
        national_id_verified: true,
        nationality: 'EG',
      }) as any;

      expect(out.national_id).toBe('[REDACTED]');
      expect(out.nationalId).toBe('[REDACTED]');
      expect(out.NATIONAL_ID).toBe('[REDACTED]');
      expect(out.nested.national_id).toBe('[REDACTED]');
      expect(out.list[0].nationalId).toBe('[REDACTED]');
      expect(out.national_id_verified).toBe(true);
      expect(out.nationality).toBe('EG');
    });

    it('redacts chronic_diseases (sensitive patient data) — naming variants, nested objects', () => {
      const out = sanitizeForLog({
        chronic_diseases: 'Type 2 diabetes',
        chronicDiseases: 'Type 2 diabetes',
        has_chronic_diseases: true,
        nested: { chronic_diseases: 'Hypertension' },
      }) as any;

      expect(out.chronic_diseases).toBe('[REDACTED]');
      expect(out.chronicDiseases).toBe('[REDACTED]');
      // has_chronic_diseases is a boolean flag, not the sensitive detail — not redacted.
      expect(out.has_chronic_diseases).toBe(true);
      expect(out.nested.chronic_diseases).toBe('[REDACTED]');
    });
  });
});

// ── Residency plan P7 — free text and capability tokens ───────────────────── //
describe('free-text and token redaction (residency plan P7)', () => {
  it('redacts keys that hold text a person typed', () => {
    const out = sanitizeForLog({
      content: 'I have chest pain',
      notes: 'allergic to penicillin',
      body: 'Hello Sara',
      prompt: 'summarise my record',
      diagnosis: 'x',
      first_name: 'Sara',
      lastName: 'Ahmed',
      patientName: 'Sara Ahmed',
      address: '12 Olaya St',
      jobId: 'job-1',
      status: 'FAILED',
    }) as Record<string, unknown>;

    for (const key of [
      'content',
      'notes',
      'body',
      'prompt',
      'diagnosis',
      'first_name',
      'lastName',
      'patientName',
      'address',
    ]) {
      expect(out[key]).toBe('[REDACTED]');
    }
    expect(out.jobId).toBe('job-1');
    expect(out.status).toBe('FAILED');
  });

  it('scrubs an identifier embedded in a string value that no key rule can see', () => {
    const out = sanitizeForLog({
      reason: 'invalid input syntax for type uuid: "0501234567"',
      detail: 'Key (email)=(sara@example.com) already exists.',
      nested: { error: 'recipient 29801011234567 rejected' },
      list: ['call +966501234567'],
    }) as any;

    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/0501234567|sara@example\.com|29801011234567|966501234567/);
    expect(out.reason).toContain('invalid input syntax for type uuid');
  });

  it('scrubs a top-level string and leaves other primitives alone', () => {
    expect(sanitizeForLog('call 0501234567')).toBe('call [NUMBER]');
    expect(sanitizeForLog(7)).toBe(7);
  });

  it('keeps operational keys readable', () => {
    const out = sanitizeForLog({
      emailProvider: 'resend',
      contentType: 'application/json',
      bodyLength: 120,
      textSearchEnabled: true,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      emailProvider: 'resend',
      contentType: 'application/json',
      bodyLength: 120,
      textSearchEnabled: true,
    });
  });
});

describe('sanitizeUrlForLog — capability tokens in the path', () => {
  it('replaces a random token segment but keeps UUIDs and slugs', () => {
    expect(sanitizeUrlForLog('/api/v1/public/payments/Xk3PqR9vTn2LmB7wYz4HdC8s/status')).toBe(
      '/api/v1/public/payments/:token/status',
    );
    expect(
      sanitizeUrlForLog('/api/v1/appointments/3f2b8c4d-1a2b-4c3d-9e8f-0a1b2c3d4e5f'),
    ).toBe('/api/v1/appointments/3f2b8c4d-1a2b-4c3d-9e8f-0a1b2c3d4e5f');
    expect(sanitizeUrlForLog('/api/v1/public/clinics/noor-dental-clinic-riyadh')).toBe(
      '/api/v1/public/clinics/noor-dental-clinic-riyadh',
    );
  });

  it('handles a tokenised path that also has a query string', () => {
    expect(
      sanitizeUrlForLog('/api/v1/public/unsubscribe/Xk3PqR9vTn2LmB7wYz4HdC8s?q=abc&page=1'),
    ).toBe('/api/v1/public/unsubscribe/:token?q=[REDACTED]&page=1');
  });
});
