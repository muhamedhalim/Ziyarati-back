import { validate } from './env.validation';

const base = {
  DATABASE_URL: 'postgres://x',
  JWT_ACCESS_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  REDIS_URL: 'redis://localhost:6379',
};

describe('env.validation', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const value = validate({ ...base });
    expect(value.NODE_ENV).toBe('development');
    expect(value.TYPEORM_SYNCHRONIZE).toBe('false');
    expect(value.QUEUE_DEFAULT_ATTEMPTS).toBe(5);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validate({ JWT_ACCESS_SECRET: 'secret' })).toThrow(/Env validation error/);
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    expect(() => validate({ DATABASE_URL: 'postgres://x', JWT_REFRESH_SECRET: 'r' })).toThrow(/Env validation error/);
  });

  it('throws when JWT_REFRESH_SECRET is missing', () => {
    expect(() => validate({ DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 's' })).toThrow(/Env validation error/);
  });

  it('throws when REDIS_URL is missing (the queue subsystem cannot boot without it — Phase 0 correction)', () => {
    expect(() =>
      validate({
        DATABASE_URL: 'postgres://x',
        JWT_ACCESS_SECRET: 'secret',
        JWT_REFRESH_SECRET: 'refresh-secret',
      }),
    ).toThrow(/Env validation error/);
  });

  it('rejects an invalid NODE_ENV enum', () => {
    expect(() => validate({ ...base, NODE_ENV: 'staging' })).toThrow(/Env validation error/);
  });

  it('rejects an invalid boolean-string flag', () => {
    expect(() => validate({ ...base, TYPEORM_SYNCHRONIZE: 'yes' })).toThrow(/Env validation error/);
  });

  it('floors ANALYTICS_EVENT_RETENTION_DAYS at 1', () => {
    expect(() => validate({ ...base, ANALYTICS_EVENT_RETENTION_DAYS: 0 })).toThrow();
  });

  it('allows unknown keys to pass through', () => {
    const value = validate({ ...base, SOME_OTHER_KEY: 'x' });
    expect(value.SOME_OTHER_KEY).toBe('x');
  });

  describe('payments fail-fast (production)', () => {
    it('FAILS the boot in production when the real provider has no credentials', () => {
      expect(() => validate({ ...base, NODE_ENV: 'production' })).toThrow(
        /MOYASAR_SECRET_KEY.*MOYASAR_WEBHOOK_SECRET|MOYASAR_SECRET_KEY, MOYASAR_WEBHOOK_SECRET/,
      );
    });

    it('names ONLY the missing variables, never values', () => {
      try {
        validate({ ...base, NODE_ENV: 'production', MOYASAR_SECRET_KEY: 'sk_live_secret' });
        fail('expected validation to throw');
      } catch (err) {
        expect((err as Error).message).toContain('MOYASAR_WEBHOOK_SECRET');
        expect((err as Error).message).not.toContain('sk_live_secret');
      }
    });

    it('boots in production once the essential payment variables are set', () => {
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        MOYASAR_SECRET_KEY: 'sk',
        MOYASAR_WEBHOOK_SECRET: 'whs',
      });
      expect(value.PAYMENT_PROVIDER).toBe('moyasar');
    });

    it('boots in production with payments explicitly disabled (PAYMENT_PROVIDER=noop)', () => {
      const value = validate({ ...base, NODE_ENV: 'production', PAYMENT_PROVIDER: 'noop' });
      expect(value.PAYMENT_PROVIDER).toBe('noop');
    });

    it('boots keyless outside production (Noop dev flow)', () => {
      const value = validate({ ...base });
      expect(value.PAYMENT_PROVIDER).toBe('moyasar');
      expect(value.MOYASAR_MARKETPLACE_ENABLED).toBe('false');
    });

    it('rejects an unknown PAYMENT_PROVIDER', () => {
      expect(() => validate({ ...base, PAYMENT_PROVIDER: 'stripe' })).toThrow(/Env validation error/);
    });
  });
});
