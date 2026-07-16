import { ConfigService } from '@nestjs/config';

import { MetaConfig } from './meta.config';
import { AppError, ErrorCode } from '../../../common/errors';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

/** Every secret that must NEVER cross the network boundary to a browser. */
const SECRETS = {
  META_APP_SECRET: 'super-secret-app-secret',
  META_WEBHOOK_VERIFY_TOKEN: 'super-secret-verify-token',
  CREDENTIALS_ENCRYPTION_KEY: 'super-secret-encryption-key',
  REDIS_URL: 'redis://user:super-secret-redis-password@localhost:6379',
  DATABASE_URL: 'postgres://user:super-secret-db-password@localhost:5432/db',
  JWT_SECRET: 'super-secret-jwt',
};

const PUBLIC = {
  META_APP_ID: '1234567890',
  META_EMBEDDED_SIGNUP_CONFIG_ID: '9876543210',
  META_GRAPH_API_VERSION: 'v21.0',
};

const build = (overrides: Record<string, unknown> = {}) =>
  new MetaConfig(
    createMockConfigService({ ...SECRETS, ...PUBLIC, ...overrides }) as unknown as ConfigService,
  );

describe('MetaConfig', () => {
  describe('requirePublicConfig — the browser boundary', () => {
    it('returns exactly the three public identifiers, and nothing else', () => {
      const config = build().requirePublicConfig();

      // An exact-shape assertion (not `toMatchObject`) is the point: a new
      // field added to this response would fail here rather than ship to every
      // browser that loads the connect page.
      expect(config).toEqual({
        appId: PUBLIC.META_APP_ID,
        configId: PUBLIC.META_EMBEDDED_SIGNUP_CONFIG_ID,
        graphVersion: PUBLIC.META_GRAPH_API_VERSION,
      });
      expect(Object.keys(config).sort()).toEqual(['appId', 'configId', 'graphVersion']);
    });

    it.each(Object.entries(SECRETS))(
      'never leaks %s in the serialized response',
      (_name, secretValue) => {
        const serialized = JSON.stringify(build().requirePublicConfig());

        // Serialize-and-scan: catches a secret smuggled in at ANY depth, which
        // a key-by-key assertion would miss.
        expect(serialized).not.toContain(secretValue);
      },
    );

    it('leaks no secret VALUE even when every secret is configured', () => {
      const serialized = JSON.stringify(build().requirePublicConfig());

      for (const value of Object.values(SECRETS)) {
        expect(serialized).not.toContain(value);
      }
      // Nor any obvious secret-ish key name.
      expect(serialized.toLowerCase()).not.toMatch(/secret|token|password|key(?!.*graph)/);
    });

    it('does not expose the app secret through any public getter', () => {
      const config = build();

      // `appSecret` exists for server-side use; it must not be reachable from
      // the shape handed to the client.
      expect(config.appSecret).toBe(SECRETS.META_APP_SECRET);
      expect(JSON.stringify(config.requirePublicConfig())).not.toContain(config.appSecret!);
    });

    it('fails with a clean 422 (not a crash) when the app is unconfigured', () => {
      expect(() => build({ META_APP_ID: '', META_EMBEDDED_SIGNUP_CONFIG_ID: '' }).requirePublicConfig())
        .toThrow(AppError);
    });

    it('does not reveal WHICH value is missing when unconfigured', () => {
      // "META_APP_SECRET is not set" would tell an attacker about our config.
      try {
        build({ META_APP_ID: '' }).requirePublicConfig();
      } catch (err) {
        expect((err as AppError).code).toBe(ErrorCode.UNPROCESSABLE_ENTITY);
        expect((err as AppError).message).not.toMatch(/META_|env|secret/i);
      }
    });
  });

  describe('secret resolution (server-side only)', () => {
    it('prefers the canonical META_* names', () => {
      const config = build({ WHATSAPP_APP_SECRET: 'legacy', WHATSAPP_VERIFY_TOKEN: 'legacy-vt' });

      expect(config.appSecret).toBe(SECRETS.META_APP_SECRET);
      expect(config.webhookVerifyToken).toBe(SECRETS.META_WEBHOOK_VERIFY_TOKEN);
    });

    it('falls back to the legacy WHATSAPP_* names during migration', () => {
      const config = build({
        META_APP_SECRET: '',
        META_WEBHOOK_VERIFY_TOKEN: '',
        WHATSAPP_APP_SECRET: 'legacy-secret',
        WHATSAPP_VERIFY_TOKEN: 'legacy-vt',
      });

      // A deploy that has not renamed its env must keep verifying webhooks.
      expect(config.appSecret).toBe('legacy-secret');
      expect(config.webhookVerifyToken).toBe('legacy-vt');
    });

    it('treats an empty string as unset rather than as a valid secret', () => {
      const config = build({ META_APP_SECRET: '   ', WHATSAPP_APP_SECRET: '' });

      // Otherwise the verifier would HMAC with '' instead of failing closed.
      expect(config.appSecret).toBeUndefined();
    });
  });

  describe('embeddedSignupConfigured', () => {
    it('is true only when app id + config id + secret are all present', () => {
      expect(build().embeddedSignupConfigured).toBe(true);
      expect(build({ META_APP_ID: '' }).embeddedSignupConfigured).toBe(false);
      expect(build({ META_EMBEDDED_SIGNUP_CONFIG_ID: '' }).embeddedSignupConfigured).toBe(false);
      expect(
        build({ META_APP_SECRET: '', WHATSAPP_APP_SECRET: '' }).embeddedSignupConfigured,
      ).toBe(false);
    });
  });

  describe('graph version', () => {
    it('defaults to a known version when unset', () => {
      expect(build({ META_GRAPH_API_VERSION: '' }).graphVersion).toBe('v21.0');
    });

    it('builds graph URLs without double slashes', () => {
      expect(build().graphUrl('/me/messages')).toBe(
        'https://graph.facebook.com/v21.0/me/messages',
      );
      expect(build().graphUrl('me/messages')).toBe(
        'https://graph.facebook.com/v21.0/me/messages',
      );
    });
  });
});
