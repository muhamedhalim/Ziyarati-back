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
// A representative AUTH_REGISTER_OWNER_ENDPOINT_CEILING (009 requires one in
// production) — same "boot cleanly past this check" role as the three
// constants above, for every production-mode test that is not itself about
// this variable. The dedicated describe block below constructs its own
// prodBase-derived object with this field explicitly omitted to exercise the
// missing-value fail-fast itself.
const PROD_REGISTER_OWNER_CEILING = 1000;
// A live SES sender (email defaults ON in production) — same "boot cleanly
// past this check" role as the constants above, for every production-mode
// test that is not itself about the email sender fail-fast.
const PROD_EMAIL = {
  AWS_REGION: 'eu-central-1',
  EMAIL_FROM: 'no-reply@example.com',
};
const prodBase = {
  ...base,
  ...PROD_EMAIL,
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: PROD_FRONTEND_ORIGIN,
  DB_SSL_CA: PROD_DB_SSL_CA,
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING: PROD_REGISTER_OWNER_CEILING,
  // Production wants two different secrets of at least 32 characters (CR-28).
  JWT_ACCESS_SECRET: 'prod-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'prod-refresh-secret-0123456789abcdef012345678',
  // `tap` is the default provider and (correctly) refuses to boot in production
  // without credentials; tests about OTHER concerns opt out explicitly.
  PAYMENT_PROVIDER: 'noop',
  ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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

  describe('FIN-S12 — the simulated gateway must not sit behind a public https URL', () => {
    const publicDev = {
      ...base,
      NODE_ENV: 'development',
      APP_URL: 'https://app.example-clinic.com',
    };

    it('refuses a development boot on a public https APP_URL with no usable Tap', () => {
      expect(() => validate(publicDev)).toThrow(/NODE_ENV=production/);
    });

    it('accepts it with the explicit acknowledgement', () => {
      expect(() =>
        validate({ ...publicDev, ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true' }),
      ).not.toThrow();
    });

    it('accepts it when Tap is actually configured for the selected TAP_ENV', () => {
      expect(() =>
        validate({
          ...publicDev,
          PAYMENT_PROVIDER: 'tap',
          TAP_ENV: 'sandbox',
          TAP_TEST_SECRET_KEY: 'sk_test_x',
          TAP_MERCHANT_ID: 'merchant_1',
        }),
      ).not.toThrow();
    });

    it.each([
      'http://localhost:3000',
      'https://localhost:3000',
      'https://clinic.localhost',
      'https://app.test',
    ])('never trips on a local address (%s)', (APP_URL) => {
      expect(() => validate({ ...base, NODE_ENV: 'development', APP_URL })).not.toThrow();
    });

    it('does not apply to the test environment', () => {
      expect(() =>
        validate({ ...base, NODE_ENV: 'test', APP_URL: 'https://app.example-clinic.com' }),
      ).not.toThrow();
    });
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
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        }),
      ).toThrow(/FRONTEND_ORIGIN/);
    });

    it('boots in production once a valid FRONTEND_ORIGIN is set', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        COOKIE_SAMESITE: 'none',
      });
      expect(value.COOKIE_SAMESITE).toBe('none');
    });

    // CSWSH: SameSite=None is legitimate (a cross-site Marketplace) and stays
    // available — the socket's Origin check holds regardless of SameSite. What it
    // makes the WHOLE exposure is the FRONTEND_ORIGIN allow-list, so a weak one
    // is refused alongside it.
    describe('SameSite=none requires a production-grade FRONTEND_ORIGIN', () => {
      const prod = (extra: Record<string, unknown>) =>
        validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          ...extra,
        });

      it.each(['COOKIE_SAMESITE', 'PUBLIC_COOKIE_SAMESITE'])(
        'accepts %s=none with an all-https, non-loopback allow-list — the capability is not removed',
        (variable) => {
          const value = prod({
            [variable]: 'none',
            FRONTEND_ORIGIN:
              'https://app.example.com, https://book.example.com',
          });
          expect(value[variable]).toBe('none');
        },
      );

      it.each([
        [
          'an http:// entry',
          'https://app.example.com,http://staging.example.com',
        ],
        ['a localhost entry', 'https://app.example.com,https://localhost:3000'],
        ['an IPv4 loopback entry', 'https://127.0.0.1:3000'],
        ['an IPv6 loopback entry', 'https://[::1]:3000'],
        ['a *.localhost entry', 'https://app.localhost'],
      ])('refuses COOKIE_SAMESITE=none alongside %s', (_label, origins) => {
        expect(() =>
          prod({ COOKIE_SAMESITE: 'none', FRONTEND_ORIGIN: origins }),
        ).toThrow(/COOKIE_SAMESITE or PUBLIC_COOKIE_SAMESITE/);
      });

      it('applies to PUBLIC_COOKIE_SAMESITE=none (the guest/booking cookies) as well', () => {
        expect(() =>
          prod({
            PUBLIC_COOKIE_SAMESITE: 'none',
            FRONTEND_ORIGIN: 'http://app.example.com',
          }),
        ).toThrow(/COOKIE_SAMESITE or PUBLIC_COOKIE_SAMESITE/);
      });

      it('does not touch lax/strict — an http or localhost entry there is a different concern', () => {
        expect(
          prod({
            COOKIE_SAMESITE: 'lax',
            FRONTEND_ORIGIN: 'http://localhost:3000',
          }).COOKIE_SAMESITE,
        ).toBe('lax');
        expect(
          prod({
            PUBLIC_COOKIE_SAMESITE: 'strict',
            FRONTEND_ORIGIN: 'https://localhost',
          }).PUBLIC_COOKIE_SAMESITE,
        ).toBe('strict');
      });

      it('names the variables only, never an origin value (the ZT-005 convention)', () => {
        try {
          prod({
            COOKIE_SAMESITE: 'none',
            FRONTEND_ORIGIN: 'http://super-secret-internal-host.example',
          });
          fail('expected validation to throw');
        } catch (err) {
          expect((err as Error).message).toContain('FRONTEND_ORIGIN');
          expect((err as Error).message).not.toContain(
            'super-secret-internal-host',
          );
        }
      });
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

    it('rejects a leading dot on COOKIE_DOMAIN — infra must emit a bare hostname', () => {
      // Real finding (residency plan P9): the Terraform platform module used to
      // emit ".<domain>", which fails here and would have kept the task from booting.
      expect(() => validate({ ...base, COOKIE_DOMAIN: '.example.com' })).toThrow(
        /COOKIE_DOMAIN/,
      );
    });

    describe('CSRF_COOKIE_DOMAIN (residency plan P9)', () => {
      it('accepts a bare hostname and is optional', () => {
        expect(validate({ ...base, CSRF_COOKIE_DOMAIN: 'example.com' }).CSRF_COOKIE_DOMAIN).toBe(
          'example.com',
        );
        expect(validate({ ...base }).CSRF_COOKIE_DOMAIN).toBeUndefined();
      });

      it.each(['.example.com', 'https://example.com', 'not a hostname!'])(
        'rejects %s',
        (value) => {
          expect(() => validate({ ...base, CSRF_COOKIE_DOMAIN: value })).toThrow(
            /CSRF_COOKIE_DOMAIN/,
          );
        },
      );
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
      ...PROD_EMAIL,
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: PROD_FRONTEND_ORIGIN,
      PAYMENT_PROVIDER: 'noop',
      ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
      CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      AUTH_REGISTER_OWNER_ENDPOINT_CEILING: PROD_REGISTER_OWNER_CEILING,
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
    // Tap credentials are OPTIONAL at boot: the app must start without them and
    // a Tap operation fails clearly at call time (PaymentGatewayFactory spec).
    it('the default provider (tap) boots in production once TAP_ENV is chosen, with no other Tap variable', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: undefined,
        TAP_ENV: 'live',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.PAYMENT_PROVIDER).toBe('tap');
    });

    // CR-10: the simulator and the silent sandbox default must not be reachable by accident.
    describe('production guards (CR-10, CR-28)', () => {
      const prod = { ...prodBase, CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY };

      it('refuses PAYMENT_PROVIDER=noop in production without the explicit acknowledgement', () => {
        const { ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: _ack, ...noAck } = prod;
        expect(() => validate({ ...noAck, PAYMENT_PROVIDER: 'noop' })).toThrow(/PAYMENT_PROVIDER=noop/);
        expect(() => validate({ ...noAck, PAYMENT_PROVIDER: 'noop', ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'false' })).toThrow(
          /PAYMENT_PROVIDER=noop/,
        );
      });

      it('accepts noop in production only with ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION=true', () => {
        expect(
          validate({ ...prod, PAYMENT_PROVIDER: 'noop', ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true' }).PAYMENT_PROVIDER,
        ).toBe('noop');
      });

      it('is not enforced outside production', () => {
        expect(() => validate({ ...base, PAYMENT_PROVIDER: 'noop' })).not.toThrow();
      });

      it('requires TAP_ENV to be chosen when production uses tap', () => {
        expect(() => validate({ ...prod, PAYMENT_PROVIDER: 'tap' })).toThrow(/TAP_ENV is not set/);
        expect(() => validate({ ...prod, PAYMENT_PROVIDER: 'tap', TAP_ENV: '' })).toThrow(/TAP_ENV is not set/);
        expect(() => validate({ ...prod, PAYMENT_PROVIDER: 'tap', TAP_ENV: 'sandbox' })).not.toThrow();
        expect(() => validate({ ...prod, PAYMENT_PROVIDER: 'tap', TAP_ENV: 'live' })).not.toThrow();
      });

      it('refuses the no-network test OAuth provider in production', () => {
        expect(() => validate({ ...prod, INTEGRATION_OAUTH_TEST_PROVIDER: 'true' })).toThrow(
          /INTEGRATION_OAUTH_TEST_PROVIDER/,
        );
        expect(() => validate({ ...base, INTEGRATION_OAUTH_TEST_PROVIDER: 'true' })).not.toThrow();
      });

      it('refuses identical access and refresh secrets in production', () => {
        const same = 'same-secret-0123456789abcdef0123456789abcdef';
        expect(() => validate({ ...prod, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same })).toThrow(
          /must be different values/,
        );
        expect(() => validate({ ...base, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same })).not.toThrow();
      });

      it('warns (without echoing the value) when a production JWT secret is shorter than 32 characters', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          validate({ ...prod, JWT_ACCESS_SECRET: 'short-secret-value' });
          const text = warn.mock.calls.map((c) => String(c[0])).join(' ');
          expect(text).toContain('JWT_ACCESS_SECRET');
          expect(text).not.toContain('short-secret-value');
        } finally {
          warn.mockRestore();
        }
      });
    });

    describe('Tap (PAYMENT_PROVIDER=tap) in production', () => {
      const tapProd = {
        ...prodBase,
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
        PAYMENT_PROVIDER: 'tap',
      };
      const sandboxOk = {
        ...tapProd,
        TAP_ENV: 'sandbox',
        TAP_MERCHANT_ID: '1234567',
        TAP_TEST_SECRET_KEY: 'sk_test_SandboxKeyNotARealSecret',
        TAP_WEBHOOK_URL: 'https://api.example.com/api/v1/payments/webhooks/tap',
      };
      const liveOk = {
        ...tapProd,
        TAP_ENV: 'live',
        TAP_MERCHANT_ID: '1234567',
        TAP_LIVE_SECRET_KEY: 'sk_live_LiveKeyNotARealSecretValue',
        TAP_WEBHOOK_URL: 'https://api.example.com/api/v1/payments/webhooks/tap',
      };

      it('BOOTS when PAYMENT_PROVIDER=tap and only TAP_ENV is set (credentials stay optional at boot)', () => {
        const value = validate({ ...tapProd, TAP_ENV: 'live' });
        expect(value.PAYMENT_PROVIDER).toBe('tap');
        expect(value.TAP_ENV).toBe('live');
        expect(value.TAP_LIVE_SECRET_KEY).toBeUndefined();
      });

      it('still boots once the Tap variables are provided later', () => {
        expect(validate({ ...tapProd, TAP_ENV: 'live' }).PAYMENT_PROVIDER).toBe('tap');
        expect(validate({ ...sandboxOk }).TAP_TEST_SECRET_KEY).toBeDefined();
      });

      it('boots with a complete SANDBOX configuration (staging runs NODE_ENV=production with test keys)', () => {
        const value = validate({ ...sandboxOk });
        expect(value.PAYMENT_PROVIDER).toBe('tap');
        expect(value.TAP_ENV).toBe('sandbox');
      });

      it('boots with a complete LIVE configuration', () => {
        expect(validate({ ...liveOk }).TAP_ENV).toBe('live');
      });

      it.each([
        ['plain http', 'http://api.example.com/hook'],
        ['localhost', 'https://localhost/hook'],
        ['127.0.0.1', 'https://127.0.0.1:3000/hook'],
        ['IPv6 loopback', 'https://[::1]/hook'],
        ['a non-URL', 'not a url'],
      ])('rejects a webhook URL that Tap cannot reach: %s', (_label, url) => {
        expect(() => validate({ ...sandboxOk, TAP_WEBHOOK_URL: url })).toThrow(
          /TAP_WEBHOOK_URL must be a public https URL/,
        );
      });

      // PAY-011: the live secret key is sent as a Bearer token to TAP_API_BASE.
      it.each([
        ['another host', 'https://tap-proxy.example.com'],
        ['plain http', 'http://api.tap.company'],
        ['a lookalike host', 'https://api.tap.company.evil.test'],
      ])('rejects TAP_API_BASE with the live key in production: %s', (_label, base) => {
        expect(() => validate({ ...liveOk, TAP_API_BASE: base })).toThrow(
          /TAP_API_BASE must be unset or https:\/\/api\.tap\.company/,
        );
      });

      it('accepts TAP_API_BASE unset, empty or exactly Tap with the live key in production', () => {
        expect(() => validate({ ...liveOk })).not.toThrow();
        expect(() => validate({ ...liveOk, TAP_API_BASE: '' })).not.toThrow();
        expect(() =>
          validate({ ...liveOk, TAP_API_BASE: 'https://api.tap.company/' }),
        ).not.toThrow();
      });

      it('still allows a TAP_API_BASE stub with SANDBOX keys in production (lab/staging)', () => {
        expect(() =>
          validate({ ...sandboxOk, TAP_API_BASE: 'http://127.0.0.1:4455' }),
        ).not.toThrow();
      });

      it('Tap variables are NOT required when payments are explicitly disabled, even in production', () => {
        expect(() =>
          validate({ ...prodBase, CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY, PAYMENT_PROVIDER: 'noop' }),
        ).not.toThrow();
      });

      it('is not enforced outside production (dev can run keyless)', () => {
        expect(() => validate({ ...base, PAYMENT_PROVIDER: 'tap' })).not.toThrow();
      });

      it('TAP_RECURRING_ENABLED is optional, defaults to unset, and accepts only true/false', () => {
        expect(() => validate({ ...sandboxOk })).not.toThrow();
        expect(validate({ ...sandboxOk }).TAP_RECURRING_ENABLED).toBeUndefined();
        expect(validate({ ...sandboxOk, TAP_RECURRING_ENABLED: 'true' }).TAP_RECURRING_ENABLED).toBe(true);
        expect(validate({ ...sandboxOk, TAP_RECURRING_ENABLED: 'false' }).TAP_RECURRING_ENABLED).toBe(false);
        expect(validate({ ...sandboxOk, TAP_RECURRING_ENABLED: '' }).TAP_RECURRING_ENABLED).toBeUndefined();
        expect(() => validate({ ...sandboxOk, TAP_RECURRING_ENABLED: 'maybe' })).toThrow(/TAP_RECURRING_ENABLED/);
      });
    });

    describe('Tap key prefixes (every environment) — a live key in the test slot is how real money moves from "sandbox"', () => {
      it.each([
        ['TAP_TEST_SECRET_KEY', 'sk_live_LooksLikeALiveKeyValue000'],
        ['TAP_TEST_SECRET_KEY', 'pk_test_ThisIsAPublicKeyNotSecret'],
        ['TAP_LIVE_SECRET_KEY', 'sk_test_LooksLikeATestKeyValue0000'],
        ['TAP_LIVE_SECRET_KEY', 'garbage'],
      ])('rejects %s=%s — naming the variable, never echoing the value', (name, value) => {
        try {
          validate({ ...base, [name]: value });
          fail('expected validation to throw');
        } catch (err) {
          const m = (err as Error).message;
          expect(m).toContain(name);
          expect(m).toMatch(/must start with/);
          expect(m).not.toContain(value);
        }
      });

      it('accepts correctly-prefixed keys, and blank ones (unset)', () => {
        expect(() =>
          validate({
            ...base,
            TAP_TEST_SECRET_KEY: 'sk_test_ok',
            TAP_LIVE_SECRET_KEY: 'sk_live_ok',
          }),
        ).not.toThrow();
        expect(() => validate({ ...base, TAP_TEST_SECRET_KEY: '', TAP_LIVE_SECRET_KEY: '' })).not.toThrow();
      });

      it('the prefix check applies even when Tap is not the selected provider (the key is still wrong)', () => {
        expect(() =>
          validate({ ...base, PAYMENT_PROVIDER: 'noop', TAP_TEST_SECRET_KEY: 'sk_live_wrongSlot000000' }),
        ).toThrow(/TAP_TEST_SECRET_KEY/);
      });
    });

    describe('a LIVE Tap key outside production (warn, never fail)', () => {
      let warn: jest.SpyInstance;
      beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      });
      afterEach(() => warn.mockRestore());

      const LIVE = 'sk_live_NotARealSecretValue0000';

      it('warns in development, naming the variable and never the value — and still boots', () => {
        expect(() =>
          validate({ ...base, NODE_ENV: 'development', TAP_LIVE_SECRET_KEY: LIVE }),
        ).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = String(warn.mock.calls[0][0]);
        expect(msg).toContain('TAP_LIVE_SECRET_KEY');
        expect(msg).not.toContain(LIVE);
      });

      it('is silent in production (live keys belong there) and under test', () => {
        validate({
          ...prodBase,
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          PAYMENT_PROVIDER: 'tap',
          TAP_ENV: 'live',
          TAP_LIVE_SECRET_KEY: LIVE,
        });
        validate({ ...base, NODE_ENV: 'test', TAP_LIVE_SECRET_KEY: LIVE });
        expect(warn).not.toHaveBeenCalled();
      });

      it('is silent when no live key is set (a test key alone is fine in development)', () => {
        validate({
          ...base,
          NODE_ENV: 'development',
          TAP_TEST_SECRET_KEY: 'sk_test_NotARealSecretValue0000',
        });
        expect(warn).not.toHaveBeenCalled();
      });
    });

    describe('SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS', () => {
      it('defaults to 7 days', () => {
        expect(validate({ ...base }).SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS).toBe(7);
      });

      it('accepts 0 (sweep off) up to a year, and rejects a fraction, a negative, or more', () => {
        expect(validate({ ...base, SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS: '0' }).SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS).toBe(0);
        expect(validate({ ...base, SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS: '365' }).SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS).toBe(365);
        for (const bad of ['1.5', '-1', '366', 'soon']) {
          expect(() => validate({ ...base, SUBSCRIPTION_PENDING_PAYMENT_TTL_DAYS: bad })).toThrow(/Env validation error/);
        }
      });
    });

    describe('Tap schema', () => {
      it('accepts sandbox | live (or unset) for TAP_ENV and rejects anything else', () => {
        expect(validate({ ...base, TAP_ENV: 'live' }).TAP_ENV).toBe('live');
        expect(validate({ ...base, TAP_ENV: '' }).TAP_ENV).toBeUndefined();
        expect(() => validate({ ...base, TAP_ENV: 'production' })).toThrow(/Env validation error/);
      });

      it('bounds the charge-expiry window to Tap\'s 5–60 minutes', () => {
        expect(validate({ ...base, TAP_CHARGE_EXPIRY_MINUTES: '45' }).TAP_CHARGE_EXPIRY_MINUTES).toBe(45);
        expect(() => validate({ ...base, TAP_CHARGE_EXPIRY_MINUTES: '4' })).toThrow(/Env validation error/);
        expect(() => validate({ ...base, TAP_CHARGE_EXPIRY_MINUTES: '61' })).toThrow(/Env validation error/);
      });

      it('bounds the request timeout', () => {
        expect(validate({ ...base, TAP_REQUEST_TIMEOUT_MS: '8000' }).TAP_REQUEST_TIMEOUT_MS).toBe(8000);
        expect(() => validate({ ...base, TAP_REQUEST_TIMEOUT_MS: '10' })).toThrow(/Env validation error/);
      });

      it('an EMPTY PAYMENT_PROVIDER line means "unset" (default), not an invalid value that refuses to boot', () => {
        expect(validate({ ...base, PAYMENT_PROVIDER: '' }).PAYMENT_PROVIDER).toBe('tap');
      });

      it('accepts tap as a provider', () => {
        expect(validate({ ...base, PAYMENT_PROVIDER: 'tap' }).PAYMENT_PROVIDER).toBe('tap');
      });
    });

    describe('Tap booking payments (Phase 4)', () => {
      it('TAP_BOOKING_PAYMENTS_ENABLED is optional, defaults to unset, and accepts only true/false', () => {
        expect(validate({ ...base }).TAP_BOOKING_PAYMENTS_ENABLED).toBeUndefined();
        expect(validate({ ...base, TAP_BOOKING_PAYMENTS_ENABLED: '' }).TAP_BOOKING_PAYMENTS_ENABLED).toBeUndefined();
        expect(validate({ ...base, TAP_BOOKING_PAYMENTS_ENABLED: 'false' }).TAP_BOOKING_PAYMENTS_ENABLED).toBe(false);
        expect(() => validate({ ...base, TAP_BOOKING_PAYMENTS_ENABLED: 'maybe' })).toThrow(
          /TAP_BOOKING_PAYMENTS_ENABLED/,
        );
      });

      it('refuses to boot with the flag ON and no TAP_PLATFORM_ID — every clinic charge would be refused at run time', () => {
        expect(() => validate({ ...base, TAP_BOOKING_PAYMENTS_ENABLED: 'true' })).toThrow(
          /TAP_BOOKING_PAYMENTS_ENABLED is true but TAP_PLATFORM_ID is not set/,
        );
        expect(() =>
          validate({ ...base, TAP_BOOKING_PAYMENTS_ENABLED: 'true', TAP_PLATFORM_ID: '  ' }),
        ).toThrow(/TAP_PLATFORM_ID/);
      });

      it('boots with the flag ON when the platform id is set', () => {
        const v = validate({
          ...base,
          TAP_BOOKING_PAYMENTS_ENABLED: 'true',
          TAP_PLATFORM_ID: 'commerce_platform_x',
        });
        expect(v.TAP_BOOKING_PAYMENTS_ENABLED).toBe(true);
      });

      it('the segment key follows the ACTIVE environment — a live key in a sandbox deployment must not boot, and the value is never echoed', () => {
        try {
          validate({ ...base, TAP_ENV: 'sandbox', TAP_SEGMENT_SECRET_KEY: 'sk_live_WrongEnvironment0' });
          fail('expected validation to throw');
        } catch (err) {
          const m = (err as Error).message;
          expect(m).toContain('TAP_SEGMENT_SECRET_KEY');
          expect(m).toMatch(/must start with "sk_test_"/);
          expect(m).not.toContain('sk_live_WrongEnvironment0');
        }
        expect(() =>
          validate({ ...base, TAP_ENV: 'live', TAP_SEGMENT_SECRET_KEY: 'sk_test_WrongEnvironment0' }),
        ).toThrow(/must start with "sk_live_"/);
      });

      it('accepts a matching segment key (or none)', () => {
        expect(() => validate({ ...base, TAP_ENV: 'sandbox', TAP_SEGMENT_SECRET_KEY: 'sk_test_ok' })).not.toThrow();
        expect(() => validate({ ...base, TAP_ENV: 'live', TAP_SEGMENT_SECRET_KEY: 'sk_live_ok' })).not.toThrow();
        expect(() => validate({ ...base, TAP_SEGMENT_SECRET_KEY: '' })).not.toThrow();
      });
    });

    it('boots in production with payments explicitly disabled (PAYMENT_PROVIDER=noop)', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.PAYMENT_PROVIDER).toBe('noop');
    });

    it('boots keyless outside production (Noop dev flow)', () => {
      const value = validate({ ...base });
      expect(value.PAYMENT_PROVIDER).toBe('tap');
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
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.META_APP_ID).toBeUndefined();
    });

    it('FAILS the boot in production when only META_APP_ID is set (partial config)', () => {
      expect(() =>
        validate({
          ...prodBase,
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
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
          CREDENTIALS_ENCRYPTION_KEY: '',
        }),
      ).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('FAILS the boot in production when the key does not decode to 32 bytes', () => {
      expect(() =>
        validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
        CREDENTIALS_ENCRYPTION_KEY: key,
      });
      expect(value.CREDENTIALS_ENCRYPTION_KEY).toBe(key);
    });

    it('boots in production once a valid 32-byte hex key is set', () => {
      const key = Buffer.alloc(32, 7).toString('hex');
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
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

  // 009-auth-abuse-resistance (ZT-002, ZT-006): ten configuration values for
  // the recovery/registration bounds and the shared bounded degraded-mode
  // fallback, plus AUTH_REGISTER_OWNER_ENDPOINT_CEILING's production-required
  // fail-fast — eleven variables total, each exercised for a valid value,
  // below-minimum, above-maximum (where applicable), non-integer, and
  // development/test vs. production behaviour.
  describe('authentication abuse-resistance configuration (009)', () => {
    it('applies the documented defaults for all ten optional variables', () => {
      const value = validate({ ...base });
      expect(value.AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW).toBe(5);
      expect(value.AUTH_FORGOT_PASSWORD_WINDOW_SECONDS).toBe(900);
      expect(value.AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT).toBe(10);
      expect(value.AUTH_RESET_PASSWORD_INVALID_CEILING).toBe(100);
      expect(value.AUTH_RESET_PASSWORD_WINDOW_SECONDS).toBe(900);
      expect(value.AUTH_REGISTER_OWNER_MAX_PER_IDENTITY).toBe(3);
      expect(value.AUTH_REGISTER_OWNER_WINDOW_SECONDS).toBe(3600);
      expect(value.AUTH_ABUSE_DEGRADED_FACTOR).toBe(0.5);
      expect(value.AUTH_ABUSE_FALLBACK_WIDTH).toBe(4096);
    });

    it.each([
      ['AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW', 0],
      ['AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT', 0],
      ['AUTH_RESET_PASSWORD_INVALID_CEILING', 0],
      ['AUTH_REGISTER_OWNER_MAX_PER_IDENTITY', 0],
    ])('rejects a zero/below-minimum %s', (key, invalid) => {
      expect(() => validate({ ...base, [key]: invalid })).toThrow(/Env validation error/);
    });

    it.each([
      ['AUTH_FORGOT_PASSWORD_WINDOW_SECONDS', 59], // below the 60s floor
      ['AUTH_RESET_PASSWORD_WINDOW_SECONDS', 59],
      ['AUTH_REGISTER_OWNER_WINDOW_SECONDS', 59],
    ])('rejects a below-minimum %s (boundary: 60)', (key, invalid) => {
      expect(() => validate({ ...base, [key]: invalid })).toThrow(/Env validation error/);
    });

    it.each([
      ['AUTH_FORGOT_PASSWORD_WINDOW_SECONDS', 86401], // above the 86400s ceiling
      ['AUTH_RESET_PASSWORD_WINDOW_SECONDS', 86401],
      ['AUTH_REGISTER_OWNER_WINDOW_SECONDS', 86401],
    ])('rejects an above-maximum %s (boundary: 86400)', (key, invalid) => {
      expect(() => validate({ ...base, [key]: invalid })).toThrow(/Env validation error/);
    });

    it.each([
      ['AUTH_FORGOT_PASSWORD_WINDOW_SECONDS', 60],
      ['AUTH_FORGOT_PASSWORD_WINDOW_SECONDS', 86400],
      ['AUTH_RESET_PASSWORD_WINDOW_SECONDS', 60],
      ['AUTH_RESET_PASSWORD_WINDOW_SECONDS', 86400],
      ['AUTH_REGISTER_OWNER_WINDOW_SECONDS', 60],
      ['AUTH_REGISTER_OWNER_WINDOW_SECONDS', 86400],
    ])('accepts the boundary values for %s = %d', (key, boundary) => {
      const value = validate({ ...base, [key]: boundary });
      expect(value[key]).toBe(boundary);
    });

    it.each([
      'AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW',
      'AUTH_FORGOT_PASSWORD_WINDOW_SECONDS',
      'AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT',
      'AUTH_RESET_PASSWORD_INVALID_CEILING',
      'AUTH_RESET_PASSWORD_WINDOW_SECONDS',
      'AUTH_REGISTER_OWNER_MAX_PER_IDENTITY',
      'AUTH_REGISTER_OWNER_WINDOW_SECONDS',
      'AUTH_ABUSE_FALLBACK_WIDTH',
    ])('rejects a non-integer value for %s', (key) => {
      expect(() => validate({ ...base, [key]: 1.5 })).toThrow(/Env validation error/);
    });

    it('accepts a configured override for every one of the ten optional variables', () => {
      const value = validate({
        ...base,
        AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW: 8,
        AUTH_FORGOT_PASSWORD_WINDOW_SECONDS: 600,
        AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT: 20,
        AUTH_RESET_PASSWORD_INVALID_CEILING: 250,
        AUTH_RESET_PASSWORD_WINDOW_SECONDS: 1200,
        AUTH_REGISTER_OWNER_MAX_PER_IDENTITY: 7,
        AUTH_REGISTER_OWNER_WINDOW_SECONDS: 7200,
        AUTH_ABUSE_DEGRADED_FACTOR: 0.75,
        AUTH_ABUSE_FALLBACK_WIDTH: 8192,
        AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 500,
      });
      expect(value.AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW).toBe(8);
      expect(value.AUTH_FORGOT_PASSWORD_WINDOW_SECONDS).toBe(600);
      expect(value.AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT).toBe(20);
      expect(value.AUTH_RESET_PASSWORD_INVALID_CEILING).toBe(250);
      expect(value.AUTH_RESET_PASSWORD_WINDOW_SECONDS).toBe(1200);
      expect(value.AUTH_REGISTER_OWNER_MAX_PER_IDENTITY).toBe(7);
      expect(value.AUTH_REGISTER_OWNER_WINDOW_SECONDS).toBe(7200);
      expect(value.AUTH_ABUSE_DEGRADED_FACTOR).toBe(0.75);
      expect(value.AUTH_ABUSE_FALLBACK_WIDTH).toBe(8192);
      expect(value.AUTH_REGISTER_OWNER_ENDPOINT_CEILING).toBe(500);
    });

    describe('AUTH_ABUSE_DEGRADED_FACTOR', () => {
      it('rejects zero (must be greater than 0)', () => {
        expect(() => validate({ ...base, AUTH_ABUSE_DEGRADED_FACTOR: 0 })).toThrow(
          /Env validation error/,
        );
      });

      it('rejects a value above 1 (degraded mode must never be more permissive than healthy mode)', () => {
        expect(() => validate({ ...base, AUTH_ABUSE_DEGRADED_FACTOR: 1.5 })).toThrow(
          /Env validation error/,
        );
      });

      it('accepts exactly 1 (degraded == healthy is the permitted upper boundary)', () => {
        const value = validate({ ...base, AUTH_ABUSE_DEGRADED_FACTOR: 1 });
        expect(value.AUTH_ABUSE_DEGRADED_FACTOR).toBe(1);
      });
    });

    describe('AUTH_ABUSE_FALLBACK_WIDTH', () => {
      it('rejects below the 256 floor', () => {
        expect(() => validate({ ...base, AUTH_ABUSE_FALLBACK_WIDTH: 255 })).toThrow(
          /Env validation error/,
        );
      });

      it('rejects above the 65536 ceiling', () => {
        expect(() => validate({ ...base, AUTH_ABUSE_FALLBACK_WIDTH: 65537 })).toThrow(
          /Env validation error/,
        );
      });

      it('accepts both boundary values', () => {
        expect(validate({ ...base, AUTH_ABUSE_FALLBACK_WIDTH: 256 }).AUTH_ABUSE_FALLBACK_WIDTH).toBe(256);
        expect(validate({ ...base, AUTH_ABUSE_FALLBACK_WIDTH: 65536 }).AUTH_ABUSE_FALLBACK_WIDTH).toBe(65536);
      });
    });

    // AUTH_REGISTER_OWNER_ENDPOINT_CEILING is the one production-required
    // value — no static default exists because no registration-rate
    // telemetry exists in either repository (plan.md C7). Mirrors the
    // FRONTEND_ORIGIN fail-fast pattern exactly.
    describe('AUTH_REGISTER_OWNER_ENDPOINT_CEILING (production-required)', () => {
      // prodBase carries a representative value (see its own definition
      // above) so every OTHER production-mode test in this file boots
      // cleanly past this check. These two tests are specifically about the
      // missing-value case, so they build a prodBase-derived object with the
      // field explicitly stripped back out.
      const prodBaseNoCeiling = (() => {
        const { AUTH_REGISTER_OWNER_ENDPOINT_CEILING: _omit, ...rest } = prodBase;
        return rest;
      })();

      it('defaults to 1000 outside production when unset', () => {
        const value = validate({ ...base });
        expect(value.AUTH_REGISTER_OWNER_ENDPOINT_CEILING).toBe(1000);
      });

      it('boots in development/test with no value set at all — never blocked', () => {
        expect(() => validate({ ...base, NODE_ENV: 'development' })).not.toThrow();
        expect(() => validate({ ...base, NODE_ENV: 'test' })).not.toThrow();
      });

      it('FAILS the boot in production when unset', () => {
        expect(() =>
          validate({
            ...prodBaseNoCeiling,
            PAYMENT_PROVIDER: 'noop',
            ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
            CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          }),
        ).toThrow(/AUTH_REGISTER_OWNER_ENDPOINT_CEILING/);
      });

      it('does NOT silently guess a production default — the error names the variable and gives no numeric fallback', () => {
        try {
          validate({
            ...prodBaseNoCeiling,
            PAYMENT_PROVIDER: 'noop',
            ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
            CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          });
          fail('expected validation to throw');
        } catch (err) {
          expect((err as Error).message).toContain('AUTH_REGISTER_OWNER_ENDPOINT_CEILING');
          expect((err as Error).message).toMatch(/do not guess/i);
        }
      });

      it('boots in production once an explicit value is set', () => {
        const value = validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 250,
        });
        expect(value.AUTH_REGISTER_OWNER_ENDPOINT_CEILING).toBe(250);
      });

      it('rejects a zero/below-minimum value even outside production', () => {
        expect(() =>
          validate({ ...base, AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 0 }),
        ).toThrow(/Env validation error/);
      });

      it('rejects a non-integer value', () => {
        expect(() =>
          validate({ ...base, AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 1.5 }),
        ).toThrow(/Env validation error/);
      });
    });
  });

  // AI-011 (FR-056-FR-058): query-logging production fail-fast. Mirrors the
  // AUTH_EXPOSE_RESET_TOKEN describe block above (same reference pattern).
  describe('query-logging fail-fast (production, AI-011)', () => {
    it('FAILS the boot in production when TYPEORM_LOGGING=true', () => {
      expect(() =>
        validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          TYPEORM_LOGGING: 'true',
        }),
      ).toThrow(/TYPEORM_LOGGING/);
    });

    it('names ONLY the variable, never a value', () => {
      try {
        validate({
          ...prodBase,
          PAYMENT_PROVIDER: 'noop',
          ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
          CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
          TYPEORM_LOGGING: 'true',
        });
        fail('expected validation to throw');
      } catch (err) {
        expect((err as Error).message).toContain('TYPEORM_LOGGING');
      }
    });

    it('boots in production when TYPEORM_LOGGING is false (default)', () => {
      const value = validate({
        ...prodBase,
        PAYMENT_PROVIDER: 'noop',
        ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
        CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      });
      expect(value.TYPEORM_LOGGING).toBe('false');
    });

    it('boots outside production even when TYPEORM_LOGGING=true — including this repository\'s own current development value', () => {
      const value = validate({ ...base, TYPEORM_LOGGING: 'true' });
      expect(value.TYPEORM_LOGGING).toBe('true');
    });

    it('rejects a non-boolean-string value for TYPEORM_LOGGING', () => {
      expect(() =>
        validate({ ...base, TYPEORM_LOGGING: 'verbose' }),
      ).toThrow(/Env validation error/);
    });
  });

  // T125a — schema coverage for the six configuration keys this feature
  // added with no prior test coverage at all: default applies when unset, an
  // out-of-range value is rejected, and (Principle XXIX) the error names the
  // variable and never echoes its value. Additive only; no existing block
  // above changes.
  describe('AI configuration keys added by this feature (T125a)', () => {
    describe('AI_TOOL_CALL_RETENTION_DAYS (FR-029b)', () => {
      it('defaults to 90 when unset', () => {
        expect(validate({ ...base }).AI_TOOL_CALL_RETENTION_DAYS).toBe(90);
      });
      it('rejects a value below 1', () => {
        expect(() => validate({ ...base, AI_TOOL_CALL_RETENTION_DAYS: 0 })).toThrow(
          /Env validation error/,
        );
      });
      it('names only the variable on rejection', () => {
        try {
          validate({ ...base, AI_TOOL_CALL_RETENTION_DAYS: -5 });
          fail('expected validation to throw');
        } catch (err) {
          expect((err as Error).message).toContain('AI_TOOL_CALL_RETENTION_DAYS');
          expect((err as Error).message).not.toContain('-5');
        }
      });
    });

    describe('AI_MAX_TOOL_CALLS_PER_ITERATION (FR-048)', () => {
      it('defaults to 10 when unset', () => {
        expect(validate({ ...base }).AI_MAX_TOOL_CALLS_PER_ITERATION).toBe(10);
      });
      it('rejects a value below 1', () => {
        expect(() =>
          validate({ ...base, AI_MAX_TOOL_CALLS_PER_ITERATION: 0 }),
        ).toThrow(/Env validation error/);
      });
    });

    describe('AI_WS_RATE_LIMIT_* (FR-053, FR-055 — mechanism only; values PD-4/PD-5-provisional)', () => {
      it('defaults: authenticated 30/60s, guest 15/60s', () => {
        const value = validate({ ...base });
        expect(value.AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS).toBe(30);
        expect(value.AI_WS_RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS).toBe(60);
        expect(value.AI_WS_RATE_LIMIT_GUEST_MAX_TURNS).toBe(15);
        expect(value.AI_WS_RATE_LIMIT_GUEST_WINDOW_SECONDS).toBe(60);
      });
      it('rejects a below-minimum value for each key', () => {
        expect(() =>
          validate({ ...base, AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS: 0 }),
        ).toThrow(/Env validation error/);
        expect(() =>
          validate({ ...base, AI_WS_RATE_LIMIT_GUEST_MAX_TURNS: 0 }),
        ).toThrow(/Env validation error/);
      });
    });

    describe('AI_PROMPT_SIMILARITY_THRESHOLD / AI_PROMPT_SIMILARITY_SHINGLE_SPAN (FR-044)', () => {
      it('defaults to threshold 0.6, shingle span 8', () => {
        const value = validate({ ...base });
        expect(value.AI_PROMPT_SIMILARITY_THRESHOLD).toBe(0.6);
        expect(value.AI_PROMPT_SIMILARITY_SHINGLE_SPAN).toBe(8);
      });
      it('rejects a threshold outside [0,1]', () => {
        expect(() =>
          validate({ ...base, AI_PROMPT_SIMILARITY_THRESHOLD: 1.5 }),
        ).toThrow(/Env validation error/);
        expect(() =>
          validate({ ...base, AI_PROMPT_SIMILARITY_THRESHOLD: -0.1 }),
        ).toThrow(/Env validation error/);
      });
      it('rejects a shingle span below 3 — SD-1\'s hold-back window derives from it, so it cannot be degenerately small', () => {
        expect(() =>
          validate({ ...base, AI_PROMPT_SIMILARITY_SHINGLE_SPAN: 2 }),
        ).toThrow(/Env validation error/);
      });
    });

    describe('AI_QUEUE_ENQUEUE_TIMEOUT_MS (FR-059)', () => {
      it('defaults to 8000ms when unset', () => {
        expect(validate({ ...base }).AI_QUEUE_ENQUEUE_TIMEOUT_MS).toBe(8000);
      });
      it('rejects a value below 100ms — too small to ever buffer a brief blip (FR-061)', () => {
        expect(() =>
          validate({ ...base, AI_QUEUE_ENQUEUE_TIMEOUT_MS: 50 }),
        ).toThrow(/Env validation error/);
      });
    });
  });

  describe('TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB (P0.6 / SCHEMA-011)', () => {
    it('defaults to "false" when unset', () => {
      expect(validate({ ...base }).TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB).toBe(
        'false',
      );
    });

    it('REJECTS a bare "true" — the old, unscoped contract is no longer accepted', () => {
      expect(() =>
        validate({
          ...base,
          TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB: 'true',
        }),
      ).toThrow(/no longer accepted/);
    });

    it('accepts an arbitrary database name — the new contract, scoped by typeorm.config.ts', () => {
      const value = validate({
        ...base,
        TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB: 'ziyarati',
      });
      expect(value.TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB).toBe('ziyarati');
    });

    it('accepts an empty string (no waiver)', () => {
      const value = validate({
        ...base,
        TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB: '',
      });
      expect(value.TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB).toBe('');
    });

    it('rejects "true" even in production, even though the waiver can never reach a production boot — the value itself is simply invalid', () => {
      expect(() =>
        validate({
          ...prodBase,
          TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB: 'true',
        }),
      ).toThrow(/no longer accepted/);
    });
  });

  // Production incident (2026-09): the worker ran with EMAIL_FROM="" while the
  // API held a valid value — the provider rejected every email. Each
  // process root validates its own environment, so this is where it stops.
  describe('transactional email sender fail-fast (production)', () => {
    const prodEmail = (overrides: Record<string, unknown>) => ({
      ...prodBase,
      PAYMENT_PROVIDER: 'noop',
      ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
      CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
      ...overrides,
    });

    it('refuses to boot with EMAIL_FROM="" — the exact production worker state', () => {
      expect(() => validate(prodEmail({ EMAIL_FROM: '' }))).toThrow(
        /EMAIL_FROM/,
      );
    });

    it('refuses to boot with EMAIL_FROM unset', () => {
      expect(() => validate(prodEmail({ EMAIL_FROM: undefined }))).toThrow(
        /EMAIL_FROM/,
      );
    });

    it('refuses to boot with a malformed EMAIL_FROM', () => {
      expect(() => validate(prodEmail({ EMAIL_FROM: 'no-reply' }))).toThrow(
        /EMAIL_FROM/,
      );
    });

    it('refuses to boot without an SES region (no other provider to fall back to)', () => {
      expect(() =>
        validate(prodEmail({ AWS_REGION: undefined, SES_REGION: undefined })),
      ).toThrow(/SES_REGION or AWS_REGION/);
    });

    it('accepts SES_REGION in place of AWS_REGION', () => {
      expect(() =>
        validate(prodEmail({ AWS_REGION: undefined, SES_REGION: 'eu-central-1' })),
      ).not.toThrow();
    });

    it('refuses retired Resend settings in production, naming them but not their values', () => {
      const secret = 're_SECRET_VALUE_123';
      expect(() => validate(prodEmail({ RESEND_API_KEY: secret }))).toThrow(
        /RESEND_API_KEY.*retired email provider/s,
      );
      expect(() =>
        validate(prodEmail({ RESEND_WEBHOOK_SECRET: secret })),
      ).toThrow(/RESEND_WEBHOOK_SECRET/);
      expect(() => validate(prodEmail({ EMAIL_PROVIDER: 'resend' }))).toThrow(
        /EMAIL_PROVIDER=resend/,
      );
      try {
        validate(prodEmail({ RESEND_API_KEY: secret }));
        throw new Error('expected validate to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain(secret);
      }
    });

    it('names variables only, never values', () => {
      const secret = 'SECRET_VALUE_123';
      try {
        validate(prodEmail({ EMAIL_REPLY_TO: secret, EMAIL_FROM: 'bad' }));
        throw new Error('expected validate to throw');
      } catch (err) {
        expect((err as Error).message).not.toContain(secret);
      }
    });

    it('boots with a plain address or an already-formatted "Name <addr>"', () => {
      expect(() => validate(prodEmail({ EMAIL_FROM: 'a@b.co' }))).not.toThrow();
      expect(() =>
        validate(prodEmail({ EMAIL_FROM: 'ZiyaraTech <a@b.co>' })),
      ).not.toThrow();
    });

    it('boots without a sender when email is explicitly disabled', () => {
      expect(() =>
        validate(
          prodEmail({
            EMAIL_ENABLED: 'false',
            EMAIL_FROM: '',
            AWS_REGION: undefined,
          }),
        ),
      ).not.toThrow();
    });

    it('no longer accepts the noop provider in production — email off is EMAIL_ENABLED=false', () => {
      expect(() => validate(prodEmail({ EMAIL_PROVIDER: 'noop' }))).toThrow(
        /EMAIL_PROVIDER=noop/,
      );
    });

    it('is not enforced outside production', () => {
      expect(() => validate({ ...base, EMAIL_FROM: '' })).not.toThrow();
    });

    it('caps SES_HTTP_TIMEOUT_MS below the 30s BullMQ job lock', () => {
      expect(() => validate({ ...base, SES_HTTP_TIMEOUT_MS: 30000 })).toThrow(
        /SES_HTTP_TIMEOUT_MS/,
      );
      expect(
        validate({ ...base, SES_HTTP_TIMEOUT_MS: 10000 }).SES_HTTP_TIMEOUT_MS,
      ).toBe(10000);
    });
  });
});

describe('client-address trust (SEC-02)', () => {
  const TOKEN = 'e'.repeat(40);

  it('defaults to 0 hops (legacy behaviour) with no edge token', () => {
    const value = validate({ ...base });
    expect(value.TRUST_PROXY_HOPS).toBe(0);
    expect(value.EDGE_PROXY_TOKEN).toBeUndefined();
  });

  it('accepts 1 hop (the ALB)', () => {
    expect(validate({ ...base, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
  });

  it.each([2, 3, -1, 1.5, 'true'])('rejects TRUST_PROXY_HOPS=%s (would trust a caller-controlled entry)', (v) => {
    expect(() => validate({ ...base, TRUST_PROXY_HOPS: v })).toThrow(/Env validation error/);
  });

  it('accepts an edge token only together with 1 hop', () => {
    expect(validate({ ...base, TRUST_PROXY_HOPS: 1, EDGE_PROXY_TOKEN: TOKEN }).EDGE_PROXY_TOKEN).toBe(TOKEN);
    expect(() => validate({ ...base, EDGE_PROXY_TOKEN: TOKEN })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => validate({ ...base, TRUST_PROXY_HOPS: 0, EDGE_PROXY_TOKEN: TOKEN })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('rejects a short edge token', () => {
    expect(() => validate({ ...base, TRUST_PROXY_HOPS: 1, EDGE_PROXY_TOKEN: 'short' })).toThrow(/Env validation error/);
  });
});

describe('AI data minimisation and residency settings (residency plan P2-P4)', () => {
  const prodOk = {
    ...prodBase,
    CREDENTIALS_ENCRYPTION_KEY: PROD_ENCRYPTION_KEY,
  };

  it('minimiser defaults ON and vision defaults OFF', () => {
    const value = validate({ ...base });
    expect(value.AI_MINIMIZER_ENABLED).toBe('true');
    expect(value.AI_VISION_ENABLED).toBe('false');
  });

  it('rejects a non-boolean value for either switch', () => {
    expect(() => validate({ ...base, AI_VISION_ENABLED: 'yes' })).toThrow(/Env validation error/);
    expect(() => validate({ ...base, AI_MINIMIZER_ENABLED: '1' })).toThrow(/Env validation error/);
  });

  it('refuses to boot in production when required-residency features are listed but the master switch is off', () => {
    expect(() =>
      validate({ ...prodOk, AI_RESIDENCY_REQUIRED_FEATURES: 'chat' }),
    ).toThrow(/AI_RESIDENCY_REQUIRED_FEATURES is set but AI_DATA_RESIDENCY_ENABLED/);
  });

  it('boots in production when the list is empty, or the switch is on', () => {
    expect(() => validate({ ...prodOk })).not.toThrow();
    expect(() =>
      validate({
        ...prodOk,
        AI_RESIDENCY_REQUIRED_FEATURES: 'chat',
        AI_DATA_RESIDENCY_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('does not apply the fail-fast outside production', () => {
    expect(() =>
      validate({ ...base, AI_RESIDENCY_REQUIRED_FEATURES: 'chat' }),
    ).not.toThrow();
  });
});

describe('WhatsApp and email content settings (residency plan P5, P8)', () => {
  it('defaults: policy enforced, marketing consent required, email minimal', () => {
    const value = validate({ ...base });
    expect(value.WHATSAPP_CONTENT_POLICY).toBe('enforce');
    expect(value.WHATSAPP_ENFORCE_MARKETING_OPT_IN).toBe('true');
    expect(value.EMAIL_INCLUDE_HEALTH_DETAIL).toBe('false');
  });

  it('accepts monitor and off, rejects anything else', () => {
    expect(validate({ ...base, WHATSAPP_CONTENT_POLICY: 'monitor' }).WHATSAPP_CONTENT_POLICY).toBe('monitor');
    expect(validate({ ...base, WHATSAPP_CONTENT_POLICY: 'off' }).WHATSAPP_CONTENT_POLICY).toBe('off');
    expect(() => validate({ ...base, WHATSAPP_CONTENT_POLICY: 'warn' })).toThrow(/Env validation error/);
    expect(() => validate({ ...base, EMAIL_INCLUDE_HEALTH_DETAIL: 'yes' })).toThrow(/Env validation error/);
  });
});
