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

// A valid FRONTEND_ORIGIN (ZT-005 requires one in production) — same
// "boot cleanly past this check" role as PROD_ENCRYPTION_KEY above, for
// every production-mode test that is not itself about FRONTEND_ORIGIN.
const PROD_FRONTEND_ORIGIN = 'https://app.example.com';
// A DB_SSL_CA value (ZT-012 requires one in production) — same "boot cleanly
// past this check" role as PROD_ENCRYPTION_KEY/PROD_FRONTEND_ORIGIN, for
// every production-mode test that is not itself about DB_SSL_CA/CERT. This
// is a representative PATH string only — content is never inspected by the
// schema (presence/shape only), so no real certificate is needed here.
const PROD_DB_SSL_CA = '/etc/ssl/certs/db-ca.pem';
const prodBase = {
  ...base,
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: PROD_FRONTEND_ORIGIN,
  DB_SSL_CA: PROD_DB_SSL_CA,
};

describe('env.validation', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const value = validate({ ...base });
    expect(value.NODE_ENV).toBe('development');
    expect(value.TYPEORM_SYNCHRONIZE).toBe('false');
    expect(value.QUEUE_DEFAULT_ATTEMPTS).toBe(5);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validate({ JWT_ACCESS_SECRET: 'secret' })).toThrow(
      /Env validation error/,
    );
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    expect(() =>
      validate({ DATABASE_URL: 'postgres://x', JWT_REFRESH_SECRET: 'r' }),
    ).toThrow(/Env validation error/);
  });

  it('throws when JWT_REFRESH_SECRET is missing', () => {
    expect(() =>
      validate({ DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 's' }),
    ).toThrow(/Env validation error/);
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
    expect(() => validate({ ...base, NODE_ENV: 'staging' })).toThrow(
      /Env validation error/,
    );
  });

  it('rejects an invalid boolean-string flag', () => {
    expect(() => validate({ ...base, TYPEORM_SYNCHRONIZE: 'yes' })).toThrow(
      /Env validation error/,
    );
  });

  it('floors ANALYTICS_EVENT_RETENTION_DAYS at 1', () => {
    expect(() =>
      validate({ ...base, ANALYTICS_EVENT_RETENTION_DAYS: 0 }),
    ).toThrow();
  });

  it('allows unknown keys to pass through', () => {
    const value = validate({ ...base, SOME_OTHER_KEY: 'x' });
    expect(value.SOME_OTHER_KEY).toBe('x');
  });

  // ZT-001: both documentation flags resolve independently, defaulting to
  // disabled in production and enabled elsewhere, and never defaulting from
  // or deriving from each other.
  describe('ENABLE_API_DOCS / ENABLE_INTEGRATION_DOCS (ZT-001)', () => {
    it('both default to false in production when unset', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.ENABLE_API_DOCS).toBe('false');
      expect(value.ENABLE_INTEGRATION_DOCS).toBe('false');
    });

    it('both default to true outside production when unset', () => {
      const value = validate({ ...base });
      expect(value.ENABLE_API_DOCS).toBe('true');
      expect(value.ENABLE_INTEGRATION_DOCS).toBe('true');
    });

    it("resolve independently — one explicitly set does not change the other's default", () => {
      const prod = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        ENABLE_INTEGRATION_DOCS: 'true',
      });
      expect(prod.ENABLE_INTEGRATION_DOCS).toBe('true');
      expect(prod.ENABLE_API_DOCS).toBe('false'); // still the production default

      const dev = validate({ ...base, ENABLE_API_DOCS: 'false' });
      expect(dev.ENABLE_API_DOCS).toBe('false');
      expect(dev.ENABLE_INTEGRATION_DOCS).toBe('true'); // still the dev default
    });

    it('accepts explicit true/false for both, in either environment', () => {
      expect(
        validate({ ...base, ENABLE_API_DOCS: 'true' }).ENABLE_API_DOCS,
      ).toBe('true');
      expect(
        validate({ ...base, ENABLE_API_DOCS: 'false' }).ENABLE_API_DOCS,
      ).toBe('false');
      expect(
        validate({ ...base, ENABLE_INTEGRATION_DOCS: 'true' })
          .ENABLE_INTEGRATION_DOCS,
      ).toBe('true');
      expect(
        validate({ ...base, ENABLE_INTEGRATION_DOCS: 'false' })
          .ENABLE_INTEGRATION_DOCS,
      ).toBe('false');
    });

    it('rejects a non-boolean-string value, naming the offending variable', () => {
      expect(() => validate({ ...base, ENABLE_API_DOCS: 'yes' })).toThrow(
        /ENABLE_API_DOCS/,
      );
      expect(() =>
        validate({ ...base, ENABLE_INTEGRATION_DOCS: 'yes' }),
      ).toThrow(/ENABLE_INTEGRATION_DOCS/);
    });
  });

  // ZT-005: five security-relevant variables that previously escaped the
  // schema entirely (`allowUnknown: true` let each through unchecked).
  describe('FRONTEND_ORIGIN (ZT-005)', () => {
    it('accepts a single valid origin', () => {
      const value = validate({
        ...base,
        FRONTEND_ORIGIN: 'https://app.example.com',
      });
      expect(value.FRONTEND_ORIGIN).toBe('https://app.example.com');
    });

    it('accepts a comma-separated list of valid origins', () => {
      const value = validate({
        ...base,
        FRONTEND_ORIGIN: 'https://app.example.com, https://admin.example.com',
      });
      expect(value.FRONTEND_ORIGIN).toContain('https://app.example.com');
    });

    it('rejects a non-URI value', () => {
      expect(() => validate({ ...base, FRONTEND_ORIGIN: 'not a url' })).toThrow(
        /FRONTEND_ORIGIN/,
      );
    });

    it('rejects an empty string (no usable origin)', () => {
      expect(() => validate({ ...base, FRONTEND_ORIGIN: '' })).toThrow(
        /FRONTEND_ORIGIN/,
      );
    });

    it('is optional outside production', () => {
      const value = validate({ ...base });
      expect(value.FRONTEND_ORIGIN).toBeUndefined();
    });

    it('FAILS the boot in production when unset — no silent fallback to a dev origin', () => {
      expect(() =>
        validate({
          ...base,
          NODE_ENV: 'production',
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        }),
      ).toThrow(/FRONTEND_ORIGIN/);
    });

    it('boots in production once a valid FRONTEND_ORIGIN is set', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.FRONTEND_ORIGIN).toBe('https://app.example.com');
    });
  });

  describe('COOKIE_SAMESITE / COOKIE_DOMAIN (ZT-005)', () => {
    it('accepts each permitted SameSite value', () => {
      expect(
        validate({ ...base, COOKIE_SAMESITE: 'lax' }).COOKIE_SAMESITE,
      ).toBe('lax');
      expect(
        validate({ ...base, COOKIE_SAMESITE: 'strict' }).COOKIE_SAMESITE,
      ).toBe('strict');
    });

    it('rejects a SameSite value outside the permitted set', () => {
      expect(() => validate({ ...base, COOKIE_SAMESITE: 'invalid' })).toThrow(
        /COOKIE_SAMESITE/,
      );
    });

    it('is unset (no schema default) when absent — the service keeps its own "lax" fallback', () => {
      const value = validate({ ...base });
      expect(value.COOKIE_SAMESITE).toBeUndefined();
    });

    it('FAILS the boot when SameSite=none is set outside production (browsers reject None without Secure)', () => {
      expect(() => validate({ ...base, COOKIE_SAMESITE: 'none' })).toThrow(
        /COOKIE_SAMESITE/,
      );
    });

    it('accepts SameSite=none in production, where Secure is always true', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        COOKIE_SAMESITE: 'none',
      });
      expect(value.COOKIE_SAMESITE).toBe('none');
    });

    it('accepts a valid hostname for COOKIE_DOMAIN', () => {
      const value = validate({ ...base, COOKIE_DOMAIN: 'example.com' });
      expect(value.COOKIE_DOMAIN).toBe('example.com');
    });

    it('rejects a non-hostname value for COOKIE_DOMAIN', () => {
      expect(() =>
        validate({ ...base, COOKIE_DOMAIN: 'not a hostname!' }),
      ).toThrow(/COOKIE_DOMAIN/);
    });

    it('COOKIE_DOMAIN is optional', () => {
      expect(validate({ ...base }).COOKIE_DOMAIN).toBeUndefined();
    });
  });

  describe('PASSWORD_RESET_TTL_MIN (ZT-005)', () => {
    it('defaults to 30 when unset', () => {
      expect(validate({ ...base }).PASSWORD_RESET_TTL_MIN).toBe(30);
    });

    it('accepts a value within the sane bound', () => {
      expect(
        validate({ ...base, PASSWORD_RESET_TTL_MIN: 60 })
          .PASSWORD_RESET_TTL_MIN,
      ).toBe(60);
    });

    it('rejects a value below the minimum', () => {
      expect(() => validate({ ...base, PASSWORD_RESET_TTL_MIN: 1 })).toThrow(
        /PASSWORD_RESET_TTL_MIN/,
      );
    });

    it('rejects a value above the maximum', () => {
      expect(() =>
        validate({ ...base, PASSWORD_RESET_TTL_MIN: 99999 }),
      ).toThrow(/PASSWORD_RESET_TTL_MIN/);
    });

    it('rejects a non-integer value', () => {
      expect(() => validate({ ...base, PASSWORD_RESET_TTL_MIN: 30.5 })).toThrow(
        /PASSWORD_RESET_TTL_MIN/,
      );
    });
  });

  describe('SEED_ON_STARTUP (ZT-005)', () => {
    it('accepts true/false', () => {
      expect(
        validate({ ...base, SEED_ON_STARTUP: 'true' }).SEED_ON_STARTUP,
      ).toBe('true');
      expect(
        validate({ ...base, SEED_ON_STARTUP: 'false' }).SEED_ON_STARTUP,
      ).toBe('false');
    });

    it('rejects a non-boolean-string value', () => {
      expect(() => validate({ ...base, SEED_ON_STARTUP: 'yes' })).toThrow(
        /SEED_ON_STARTUP/,
      );
    });

    it('is unset (no schema default) when absent — the seeder keeps its own "true" fallback', () => {
      expect(validate({ ...base }).SEED_ON_STARTUP).toBeUndefined();
    });
  });

  describe('ZT-005 error messages name only the variable, never a value', () => {
    it('for FRONTEND_ORIGIN', () => {
      try {
        validate({
          ...base,
          FRONTEND_ORIGIN: 'super-secret-internal-hostname-value',
        });
        fail('expected validation to throw');
      } catch (err) {
        expect((err as Error).message).toContain('FRONTEND_ORIGIN');
        expect((err as Error).message).not.toContain(
          'super-secret-internal-hostname-value',
        );
      }
    });
  });

  // ZT-012: production database TLS trust anchor. Content is never asserted
  // against here — presence/shape only, per Constitution XXIX. Builds its
  // own production base WITHOUT `prodBase`'s default `DB_SSL_CA` — these
  // tests need to control that variable precisely (including its absence).
  describe('DB_SSL_CA / DB_SSL_CA_CERT (ZT-012)', () => {
    const prodWithoutDbSsl = {
      ...base,
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: PROD_FRONTEND_ORIGIN,
      PAYMENT_PROVIDER: 'noop',
      CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
    };

    it('both are optional outside production', () => {
      const value = validate({ ...base });
      expect(value.DB_SSL_CA).toBeUndefined();
      expect(value.DB_SSL_CA_CERT).toBeUndefined();
    });

    it('production refuses to boot when neither is set — never silently accepting any certificate', () => {
      expect(() => validate({ ...prodWithoutDbSsl })).toThrow(/DB_SSL_CA/);
    });

    it('production boots with DB_SSL_CA alone', () => {
      const value = validate({
        ...prodWithoutDbSsl,
        DB_SSL_CA: '/etc/ssl/certs/db-ca.pem',
      });
      expect(value.DB_SSL_CA).toBe('/etc/ssl/certs/db-ca.pem');
    });

    it('production boots with DB_SSL_CA_CERT alone', () => {
      const value = validate({
        ...prodWithoutDbSsl,
        DB_SSL_CA_CERT:
          '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
      });
      expect(value.DB_SSL_CA_CERT).toContain('BEGIN CERTIFICATE');
    });

    it('production refuses to boot when BOTH are set — alternatives, not a pair', () => {
      expect(() =>
        validate({
          ...prodWithoutDbSsl,
          DB_SSL_CA: '/etc/ssl/certs/db-ca.pem',
          DB_SSL_CA_CERT:
            '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
        }),
      ).toThrow(/DB_SSL_CA/);
    });

    it('rejects an empty-string value for either (shape check, not content)', () => {
      expect(() => validate({ ...base, DB_SSL_CA: '' })).toThrow(/DB_SSL_CA/);
      expect(() => validate({ ...base, DB_SSL_CA_CERT: '' })).toThrow(
        /DB_SSL_CA_CERT/,
      );
    });
  });

  describe('DEFAULT_LOCALE (T159 / CAP-I18N / FR-H002)', () => {
    it('defaults to "en" when unset', () => {
      const value = validate({ ...base });
      expect(value.DEFAULT_LOCALE).toBe('en');
    });

    it('accepts every locale in the supported set', () => {
      expect(validate({ ...base, DEFAULT_LOCALE: 'en' }).DEFAULT_LOCALE).toBe(
        'en',
      );
      expect(validate({ ...base, DEFAULT_LOCALE: 'ar' }).DEFAULT_LOCALE).toBe(
        'ar',
      );
    });

    it('rejects a locale outside the supported set — constrained, not a free-form string', () => {
      expect(() => validate({ ...base, DEFAULT_LOCALE: 'fr' })).toThrow(
        /Env validation error/,
      );
    });
  });

  describe('payments fail-fast (production)', () => {
    it('FAILS the boot in production when the real provider has no credentials', () => {
      expect(() => validate({ ...prodBase })).toThrow(
        /MOYASAR_SECRET_KEY.*MOYASAR_WEBHOOK_SECRET|MOYASAR_SECRET_KEY, MOYASAR_WEBHOOK_SECRET/,
      );
    });

    it('names ONLY the missing variables, never values', () => {
      try {
        validate({ ...prodBase, MOYASAR_SECRET_KEY: 'sk_live_secret' });
        fail('expected validation to throw');
      } catch (err) {
        expect((err as Error).message).toContain('MOYASAR_WEBHOOK_SECRET');
        expect((err as Error).message).not.toContain('sk_live_secret');
      }
    });

    it('boots in production once the essential payment variables are set', () => {
      const value = validate({
        ...prodBase,
        MOYASAR_SECRET_KEY: 'sk',
        MOYASAR_WEBHOOK_SECRET: 'whs',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.PAYMENT_PROVIDER).toBe('moyasar');
    });

    it('boots in production with payments explicitly disabled (PAYMENT_PROVIDER=noop)', () => {
      const value = validate({
        ...prodBase,
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
      expect(() => validate({ ...base, PAYMENT_PROVIDER: 'stripe' })).toThrow(
        /Env validation error/,
      );
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
        ...prodBase,
        MOYASAR_SECRET_KEY: 'sk',
        MOYASAR_WEBHOOK_SECRET: 'whs',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.META_APP_ID).toBeUndefined();
    });

    it('FAILS the boot in production when only META_APP_ID is set (partial config)', () => {
      expect(() =>
        validate({
          ...prodBase,
          MOYASAR_SECRET_KEY: 'sk',
          MOYASAR_WEBHOOK_SECRET: 'whs',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          META_APP_ID: 'app-123',
        }),
      ).toThrow(
        /META_APP_SECRET.*META_EMBEDDED_SIGNUP_CONFIG_ID.*META_WEBHOOK_VERIFY_TOKEN|META_APP_SECRET, META_EMBEDDED_SIGNUP_CONFIG_ID, META_WEBHOOK_VERIFY_TOKEN/,
      );
    });

    it('FAILS when 3 of 4 are set, naming only the ONE missing variable', () => {
      let thrown: Error | undefined;
      try {
        validate({
          ...prodBase,
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
        ...prodBase,
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
        ...prodBase,
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
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          AUTH_EXPOSE_RESET_TOKEN: 'true',
        }),
      ).toThrow(/AUTH_EXPOSE_RESET_TOKEN/);
    });

    it('names ONLY the variable, never a value', () => {
      try {
        validate({
          ...prodBase,
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
        ...prodBase,
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
      expect(() =>
        validate({ ...base, AUTH_EXPOSE_RESET_TOKEN: 'yes' }),
      ).toThrow(/Env validation error/);
    });
  });

  // HRD-001: production must refuse to boot without a usable credential
  // encryption key — today it boots fine and only fails later, at first USE,
  // inside EncryptionService. Mirrors the payments fail-fast pattern above.
  describe('credential-encryption fail-fast (production)', () => {
    it('FAILS the boot in production when CREDENTIALS_ENCRYPTION_KEY is unset', () => {
      expect(() => validate({ ...prodBase, PAYMENT_PROVIDER: 'noop' })).toThrow(
        /CREDENTIALS_ENCRYPTION_KEY/,
      );
    });

    it('FAILS the boot in production when CREDENTIALS_ENCRYPTION_KEY is an empty string', () => {
      expect(() =>
        validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY: '',
        }),
      ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('FAILS the boot in production when the key does not decode to 32 bytes', () => {
      expect(() =>
        validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          CREDENTIALS_ENCRYPTION_KEY:
            Buffer.from('too-short').toString('base64'),
        }),
      ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('names ONLY the variable, never the key value', () => {
      const key = Buffer.alloc(32, 7).toString('base64');
      try {
        validate({
          ...prodBase,
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
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        CREDENTIALS_ENCRYPTION_KEY: key,
      });
      expect(value.CREDENTIALS_ENCRYPTION_KEY).toBe(key);
    });

    it('boots in production once a valid 32-byte hex key is set', () => {
      const key = Buffer.alloc(32, 7).toString('hex');
      const value = validate({
        ...prodBase,
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
      expect(() =>
        validate({ ...base, AUTH_LOGIN_MAX_FAILED_ATTEMPTS: 0 }),
      ).toThrow(/Env validation error/);
      expect(() =>
        validate({ ...base, AUTH_LOGIN_MAX_FAILED_ATTEMPTS: -1 }),
      ).toThrow(/Env validation error/);
    });

    it('rejects a zero or negative AUTH_LOGIN_LOCKOUT_TTL_SECONDS', () => {
      expect(() =>
        validate({ ...base, AUTH_LOGIN_LOCKOUT_TTL_SECONDS: 0 }),
      ).toThrow(/Env validation error/);
      expect(() =>
        validate({ ...base, AUTH_LOGIN_LOCKOUT_TTL_SECONDS: -1 }),
      ).toThrow(/Env validation error/);
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
