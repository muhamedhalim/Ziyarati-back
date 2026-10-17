import { formatFromAddress, resolveEmailConfig } from './email.config';

const configFrom = (env: Record<string, string | undefined>) =>
  ({ get: jest.fn((k: string) => env[k]) }) as never;

describe('formatFromAddress', () => {
  it('wraps a plain address with the display name', () => {
    expect(formatFromAddress('no-reply@ziyaratech.com', 'ZiyaraTech')).toBe(
      'ZiyaraTech <no-reply@ziyaratech.com>',
    );
  });

  it('defaults the display name when EMAIL_FROM_NAME is unset or blank', () => {
    expect(formatFromAddress('a@b.co', undefined)).toBe('ZiyaraTech <a@b.co>');
    expect(formatFromAddress('a@b.co', '   ')).toBe('ZiyaraTech <a@b.co>');
  });

  // The production incident: worker EMAIL_FROM was "" → sender "ZiyaraTech <>".
  it.each(['', '   ', null, undefined])(
    'treats a blank EMAIL_FROM (%p) as unusable instead of producing "Name <>"',
    (value) => {
      expect(formatFromAddress(value as string, 'ZiyaraTech')).toBeNull();
    },
  );

  it('accepts an already-formatted "Name <addr>" as-is instead of double-wrapping it', () => {
    expect(
      formatFromAddress('ZiyaraTech <no-reply@ziyaratech.com>', 'Other'),
    ).toBe('ZiyaraTech <no-reply@ziyaratech.com>');
  });

  it.each(['not-an-email', 'a@b', 'Name <not-an-email>', 'a b@c.co', '<>'])(
    'rejects a malformed sender %p',
    (value) => {
      expect(formatFromAddress(value, 'ZiyaraTech')).toBeNull();
    },
  );

  it('rejects a display name that would break the header', () => {
    expect(formatFromAddress('a@b.co', 'Evil <x@y.z>')).toBeNull();
  });
});

describe('resolveEmailConfig().from', () => {
  it('never yields an empty mailbox when EMAIL_FROM is an empty string', () => {
    const cfg = resolveEmailConfig(
      configFrom({ EMAIL_FROM: '', EMAIL_FROM_NAME: 'ZiyaraTech' }),
    );
    expect(cfg.from).toBe('ZiyaraTech <no-reply@example.com>');
    expect(cfg.from).not.toContain('<>');
  });

  it('uses the configured sender when valid', () => {
    const cfg = resolveEmailConfig(
      configFrom({
        EMAIL_FROM: 'hello@ziyaratech.com',
        EMAIL_FROM_NAME: 'ZiyaraTech',
      }),
    );
    expect(cfg.from).toBe('ZiyaraTech <hello@ziyaratech.com>');
  });

  it('falls back safely even when EMAIL_FROM_NAME itself is malformed', () => {
    const cfg = resolveEmailConfig(
      configFrom({ EMAIL_FROM: '', EMAIL_FROM_NAME: 'a<b' }),
    );
    expect(cfg.from).toBe('ZiyaraTech <no-reply@example.com>');
  });
});
