import {
  containsIdentifier,
  scrubError,
  scrubFailureReason,
  scrubText,
  summarizeBodyForLog,
} from './log-scrubber.util';

describe('scrubText', () => {
  it('leaves ordinary diagnostic text alone', () => {
    const line =
      'Failed to dispatch email "welcome" (tenant=3f2b8c4d-1a2b-4c3d-9e8f-0a1b2c3d4e5f, key=welcome:3f2b8c4d) after 3 attempts in 1250ms';
    expect(scrubText(line)).toBe(line);
  });

  it('removes email addresses', () => {
    expect(scrubText('The to address sara.ahmed@example.com is invalid')).toBe(
      'The to address [EMAIL] is invalid',
    );
  });

  it.each([
    ['Saudi mobile, local', '0501234567'],
    ['Saudi mobile, international', '+966501234567'],
    ['Saudi mobile, grouped', '+966 50 123 4567'],
    ['Saudi national ID', '1012345678'],
    ['Egyptian national ID', '29801011234567'],
    ['card number', '4111 1111 1111 1111'],
  ])('removes a %s', (_label, value) => {
    const out = scrubText(`recipient ${value} rejected`);
    expect(out).not.toContain(value.replace(/\D/g, ''));
    expect(out).toContain('[NUMBER]');
  });

  it('keeps a millisecond epoch timestamp and short numbers', () => {
    expect(scrubText('at 1759772000000 took 30000ms port 3000')).toBe(
      'at 1759772000000 took 30000ms port 3000',
    );
  });

  it('does not bite into a UUID or a hex token', () => {
    const uuid = '12345678-1234-4234-8234-123456789012';
    expect(scrubText(`id=${uuid}`)).toBe(`id=${uuid}`);
    expect(scrubText('auto:9a8b7c6d5e4f30211234567890abcdef')).toBe(
      'auto:9a8b7c6d5e4f30211234567890abcdef',
    );
  });

  it('removes JWTs and bearer credentials', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    const out = scrubText(
      `token ${jwt} and Authorization: Bearer abcdef1234567890`,
    );
    expect(out).not.toContain('eyJhbGci');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('removes presigned-URL signatures but keeps the parameter names', () => {
    const url =
      'GET https://bucket.s3.example/doc.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAXXXX%2F2026&X-Amz-Signature=abcdef0123456789&X-Amz-Expires=300 failed';
    const out = scrubText(url);
    expect(out).not.toContain('abcdef0123456789');
    expect(out).not.toContain('AKIAXXXX');
    expect(out).toContain('X-Amz-Signature=[REDACTED]');
    expect(out).toContain('failed');
  });

  it('removes row values the PostgreSQL driver quotes', () => {
    expect(
      scrubText(
        'duplicate key value violates unique constraint "uq_user_email_global"',
      ),
    ).toBe(
      'duplicate key value violates unique constraint "uq_user_email_global"',
    );
    expect(scrubText('Key (email)=(sara@example.com) already exists.')).toBe(
      'Key (email)=([REDACTED]) already exists.',
    );
    expect(
      scrubText('Failing row contains (a1, Sara Ahmed, 0501234567, null).'),
    ).toBe('Failing row contains ([REDACTED]).');
    expect(scrubText('invalid input syntax for type uuid: "Sara Ahmed"')).toBe(
      'invalid input syntax for type uuid: "[REDACTED]"',
    );
  });

  it('is bounded on pathological input and never throws', () => {
    const huge = 'a'.repeat(200_000);
    expect(() => scrubText(huge)).not.toThrow();
    expect(scrubText(huge).length).toBeLessThan(11_000);
    expect(scrubText('')).toBe('');
  });

  it('containsIdentifier reports whether anything would change', () => {
    expect(containsIdentifier('nothing to see')).toBe(false);
    expect(containsIdentifier('call 0501234567')).toBe(true);
  });
});

describe('scrubFailureReason', () => {
  it('accepts an Error, a string, undefined and arbitrary objects', () => {
    expect(scrubFailureReason(new Error('bad address a@b.co'))).toBe(
      'bad address [EMAIL]',
    );
    expect(scrubFailureReason('plain')).toBe('plain');
    expect(scrubFailureReason(undefined)).toBe('unknown');
    expect(scrubFailureReason({ to: '0501234567' })).not.toContain(
      '0501234567',
    );
  });

  it('caps the length', () => {
    const out = scrubFailureReason('x'.repeat(2_000), 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith('…')).toBe(true);
  });

  it('survives an unserialisable value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(scrubFailureReason(cyclic)).toBe('unserializable failure reason');
  });
});

describe('scrubError', () => {
  it('scrubs message and stack but keeps the class name', () => {
    const err = new TypeError('cannot send to +966501234567');
    err.stack =
      'TypeError: cannot send to +966501234567\n    at send (mailer.ts:10:5)';
    const out = scrubError(err);
    expect(out.name).toBe('TypeError');
    expect(out.message).not.toContain('966501234567');
    expect(out.stack).not.toContain('966501234567');
    expect(out.stack).toContain('mailer.ts:10:5');
  });
});

describe('summarizeBodyForLog', () => {
  it('shows field names, types and lengths but never text', () => {
    const out = summarizeBodyForLog({
      fullName: 'Sara Ahmed',
      reason: 'chest pain since Tuesday',
      age: 41,
      urgent: true,
      tags: ['a', 'b'],
      nested: { clinicSlug: 'noor-clinic' },
    }) as Record<string, any>;

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('Sara');
    expect(serialized).not.toContain('chest pain');
    expect(serialized).not.toContain('noor-clinic');
    expect(out.reason).toBe('[string:24]');
    expect(out.age).toBe(41);
    expect(out.urgent).toBe(true);
    expect(out.tags).toEqual(['[string:1]', '[string:1]']);
    expect(out.fullName).toBe('[REDACTED]');
  });

  it('redacts values under sensitive or free-text keys regardless of type', () => {
    const out = summarizeBodyForLog({
      password: 'x',
      national_id: 29801011234567,
      content: 'hello',
      Notes: 'private',
    }) as Record<string, unknown>;
    expect(Object.values(out)).toEqual([
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
    ]);
  });

  it('caps depth and breadth', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 80; i += 1) wide[`k${i}`] = i;
    const out = summarizeBodyForLog(wide) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(51);
    expect(out['[more]']).toBe(30);

    let deep: unknown = 'leaf';
    for (let i = 0; i < 8; i += 1) deep = { n: deep };
    expect(JSON.stringify(summarizeBodyForLog(deep))).toContain('[Truncated]');
  });

  it('passes null, undefined and scalars sensibly', () => {
    expect(summarizeBodyForLog(null)).toBeNull();
    expect(summarizeBodyForLog(undefined)).toBeUndefined();
    expect(summarizeBodyForLog('abc')).toBe('[string:3]');
    expect(summarizeBodyForLog(Number.NaN)).toBe('number');
  });
});
