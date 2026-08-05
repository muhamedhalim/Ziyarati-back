import { validate } from './env.validation';

const base = {
  DATABASE_URL: 'postgres://x',
  JWT_ACCESS_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  REDIS_URL: 'redis://localhost:6379',
};

// A valid 32-byte key (HRD-001 requires one in production) — shared by every
// test below that needs production to boot cleanly past that check so it can
// exercise its OWN, unrelated concern.
const PROD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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

  describe('DEFAULT_LOCALE (T159 / CAP-I18N / FR-H002)', () => {
    it('defaults to "en" when unset', () => {
      const value = validate({ ...base });
      expect(value.DEFAULT_LOCALE).toBe('en');
    });

    it('accepts every locale in the supported set', () => {
      expect(validate({ ...base, DEFAULT_LOCALE: 'en' }).DEFAULT_LOCALE).toBe('en');
      expect(validate({ ...base, DEFAULT_LOCALE: 'ar' }).DEFAULT_LOCALE).toBe('ar');
    });

    it('rejects a locale outside the supported set — constrained, not a free-form string', () => {
      expect(() => validate({ ...base, DEFAULT_LOCALE: 'fr' })).toThrow(/Env validation error/);
    });
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
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.PAYMENT_PROVIDER).toBe('moyasar');
    });

    it('boots in production with payments explicitly disabled (PAYMENT_PROVIDER=noop)', () => {
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
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

  // HRD-002: the platform Meta App config stays legitimately OPTIONAL in
  // production (many deployments never use WhatsApp — same reasoning as
  // FND-035/AD-08's AI fail-fast, not the unconditional payments/HRD-001
  // pattern). What must fail fast is a PARTIAL configuration: an operator who
  // has started setting Meta keys but left the set incomplete would otherwise
  // silently get a half-working (or, for the webhook signature pair
  // specifically, insecurely inconsistent) integration with no boot-time
  // signal. Mirrors `MetaConfig.embeddedSignupConfigured`'s own existing
  // "all of appId + embeddedSignupConfigId + appSecret" definition of
  // configured, extended with `webhookVerifyToken` (the signature pair's
  // other half) — the coherent set this check enforces.
  describe('Meta app config fail-fast (production, HRD-002)', () => {
    it('boots in production with NO Meta config at all (legitimately optional — not every deployment uses WhatsApp)', () => {
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        MOYASAR_SECRET_KEY: 'sk',
        MOYASAR_WEBHOOK_SECRET: 'whs',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.META_APP_ID).toBeUndefined();
    });

    it('FAILS the boot in production when only META_APP_ID is set (partial config)', () => {
      expect(() =>
        validate({
          ...base,
          NODE_ENV: 'production',
          MOYASAR_SECRET_KEY: 'sk',
          MOYASAR_WEBHOOK_SECRET: 'whs',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          META_APP_ID: 'app-123',
        }),
      ).toThrow(/META_APP_SECRET.*META_EMBEDDED_SIGNUP_CONFIG_ID.*META_WEBHOOK_VERIFY_TOKEN|META_APP_SECRET, META_EMBEDDED_SIGNUP_CONFIG_ID, META_WEBHOOK_VERIFY_TOKEN/);
    });

    it('FAILS when 3 of 4 are set, naming only the ONE missing variable', () => {
      let thrown: Error | undefined;
      try {
        validate({
          ...base,
          NODE_ENV: 'production',
          MOYASAR_SECRET_KEY: 'sk',
          MOYASAR_WEBHOOK_SECRET: 'whs',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          META_APP_ID: 'app-123',
          META_APP_SECRET: 'top-secret-value',
          META_EMBEDDED_SIGNUP_CONFIG_ID: 'config-123',
          // META_WEBHOOK_VERIFY_TOKEN deliberately omitted
        });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain('META_WEBHOOK_VERIFY_TOKEN');
      expect(thrown!.message).not.toContain('META_APP_ID');
      expect(thrown!.message).not.toContain('top-secret-value');
    });

    it('boots in production once all four Meta variables are set', () => {
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        MOYASAR_SECRET_KEY: 'sk',
        MOYASAR_WEBHOOK_SECRET: 'whs',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        META_APP_ID: 'app-123',
        META_APP_SECRET: 'top-secret-value',
        META_EMBEDDED_SIGNUP_CONFIG_ID: 'config-123',
        META_WEBHOOK_VERIFY_TOKEN: 'verify-123',
      });
      expect(value.META_APP_ID).toBe('app-123');
    });

    it('the legacy WHATSAPP_APP_SECRET/WHATSAPP_VERIFY_TOKEN aliases also count as configured (MetaConfig honours them as a fallback — this check must not force a premature migration)', () => {
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        MOYASAR_SECRET_KEY: 'sk',
        MOYASAR_WEBHOOK_SECRET: 'whs',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        META_APP_ID: 'app-123',
        META_EMBEDDED_SIGNUP_CONFIG_ID: 'config-123',
        WHATSAPP_APP_SECRET: 'legacy-secret',
        WHATSAPP_VERIFY_TOKEN: 'legacy-verify',
      });
      expect(value.META_APP_ID).toBe('app-123');
    });

    it('does not fail-fast outside production, even with a partial Meta config (dev/test keep the flexible path)', () => {
      const value = validate({ ...base, META_APP_ID: 'app-123' });
      expect(value.META_APP_ID).toBe('app-123');
    });
  });

  // FND-006: an insecure local-development reset-token exposure channel
  // must never be enabled in production. Mirrors the payments fail-fast
  // pattern above — the reference pattern constitution XXIX names.
  describe('reset-token exposure fail-fast (production)', () => {
    it('FAILS the boot in production when AUTH_EXPOSE_RESET_TOKEN=true', () => {
      expect(() =>
        validate({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          AUTH_EXPOSE_RESET_TOKEN: 'true',
        }),
      ).toThrow(/AUTH_EXPOSE_RESET_TOKEN/);
    });

    it('names ONLY the variable, never a value', () => {
      try {
        validate({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          AUTH_EXPOSE_RESET_TOKEN: 'true',
        });
        fail('expected validation to throw');
      } catch (err) {
        expect((err as Error).message).toContain('AUTH_EXPOSE_RESET_TOKEN');
        // The message must never contain a token-shaped value or the literal 'true'
        // as a quoted assigned value — only the variable's name is permitted.
        expect((err as Error).message).not.toMatch(/[0-9a-f]{64}/);
      }
    });

    it('boots in production when AUTH_EXPOSE_RESET_TOKEN is false (default)', () => {
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.AUTH_EXPOSE_RESET_TOKEN).toBe('false');
    });

    it('boots outside production even when AUTH_EXPOSE_RESET_TOKEN=true', () => {
      const value = validate({ ...base, AUTH_EXPOSE_RESET_TOKEN: 'true' });
      expect(value.AUTH_EXPOSE_RESET_TOKEN).toBe('true');
    });

    it('rejects a non-boolean-string value for AUTH_EXPOSE_RESET_TOKEN', () => {
      expect(() => validate({ ...base, AUTH_EXPOSE_RESET_TOKEN: 'yes' })).toThrow(/Env validation error/);
    });
  });

  // HRD-001: production must refuse to boot without a usable credential
  // encryption key — today it boots fine and only fails later, at first USE,
  // inside EncryptionService. Mirrors the payments fail-fast pattern above.
  describe('credential-encryption fail-fast (production)', () => {
    it('FAILS the boot in production when CREDENTIALS_ENCRYPTION_KEY is unset', () => {
      expect(() =>
        validate({ ...base, NODE_ENV: 'production', PAYMENT_PROVIDER: 'noop' }),
      ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('FAILS the boot in production when CREDENTIALS_ENCRYPTION_KEY is an empty string', () => {
      expect(() =>
        validate({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: '',
        }),
      ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('FAILS the boot in production when the key does not decode to 32 bytes', () => {
      expect(() =>
        validate({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: Buffer.from('too-short').toString('base64'),
        }),
      ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('names ONLY the variable, never the key value', () => {
      const key = Buffer.alloc(32, 7).toString('base64');
      try {
        validate({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: 'sk',
        });
        fail('expected validation to throw');
      } catch (err) {
        expect((err as Error).message).toContain('CREDENTIALS_ENCRYPTION_KEY');
        expect((err as Error).message).not.toContain(key);
      }
    });

    it('boots in production once a valid 32-byte base64 key is set', () => {
      const key = Buffer.alloc(32, 7).toString('base64');
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: key,
      });
      expect(value.CREDENTIALS_ENCRYPTION_KEY).toBe(key);
    });

    it('boots in production once a valid 32-byte hex key is set', () => {
      const key = Buffer.alloc(32, 7).toString('hex');
      const value = validate({
        ...base,
        NODE_ENV: 'production',
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: key,
      });
      expect(value.CREDENTIALS_ENCRYPTION_KEY).toBe(key);
    });

    it('boots keyless outside production (dev/test unaffected)', () => {
      const value = validate({ ...base });
      expect(value.CREDENTIALS_ENCRYPTION_KEY).toBeUndefined();
    });
  });

  // FND-008: account-aware login-protection thresholds must be configurable
  // and floored so a misconfiguration cannot silently disable the control.
  describe('login-protection configuration', () => {
    it('applies the documented defaults (5 attempts / 900s window)', () => {
      const value = validate({ ...base });
      expect(value.AUTH_LOGIN_MAX_FAILED_ATTEMPTS).toBe(5);
      expect(value.AUTH_LOGIN_LOCKOUT_TTL_SECONDS).toBe(900);
    });

    it('rejects a zero or negative AUTH_LOGIN_MAX_FAILED_ATTEMPTS', () => {
      expect(() => validate({ ...base, AUTH_LOGIN_MAX_FAILED_ATTEMPTS: 0 })).toThrow(/Env validation error/);
      expect(() => validate({ ...base, AUTH_LOGIN_MAX_FAILED_ATTEMPTS: -1 })).toThrow(/Env validation error/);
    });

    it('rejects a zero or negative AUTH_LOGIN_LOCKOUT_TTL_SECONDS', () => {
      expect(() => validate({ ...base, AUTH_LOGIN_LOCKOUT_TTL_SECONDS: 0 })).toThrow(/Env validation error/);
      expect(() => validate({ ...base, AUTH_LOGIN_LOCKOUT_TTL_SECONDS: -1 })).toThrow(/Env validation error/);
    });

    it('accepts configured overrides', () => {
      const value = validate({
        ...base,
        AUTH_LOGIN_MAX_FAILED_ATTEMPTS: 10,
        AUTH_LOGIN_LOCKOUT_TTL_SECONDS: 300,
      });
      expect(value.AUTH_LOGIN_MAX_FAILED_ATTEMPTS).toBe(10);
      expect(value.AUTH_LOGIN_LOCKOUT_TTL_SECONDS).toBe(300);
    });
  });
});
