import { randomBytes } from 'node:crypto';

import {
  OAuthClientAdapter,
  OAuthInvalidGrantError,
  OAuthProviderConfig,
  OAuthTokenSet,
} from './oauth.types';

/**
 * OAuth provider registry (Phase 4).
 *
 * NO PRODUCTION PROVIDER IS CONFIGURED. This codebase has no validated clinic
 * PMS/EMR OAuth application, so inventing endpoints, client ids, or token
 * semantics here would be fabrication — the flow would look implemented and
 * fail the moment a real provider was pointed at it.
 *
 * What ships instead is the complete CLIENT-SIDE machinery (authorization-code
 * + PKCE, single-use state, strict redirect allowlist, encrypted token storage,
 * expiry tracking, refresh with rotation, refresh locking, revocation,
 * invalid_grant handling) exercised end-to-end by a DETERMINISTIC IN-PROCESS
 * TEST ADAPTER. The test adapter performs no network I/O whatsoever and is
 * enabled ONLY when `INTEGRATION_OAUTH_TEST_PROVIDER=true` — it is unavailable
 * in production regardless of any other configuration.
 *
 * Adding a real provider is then a matter of adding one compiled entry plus its
 * env-supplied client credentials; no pipeline code changes.
 */

/** Deterministic, offline adapter that mimics a spec-compliant provider. */
class TestOAuthAdapter implements OAuthClientAdapter {
  /** Refresh tokens this adapter still considers valid (rotation is enforced). */
  private readonly liveRefreshTokens = new Set<string>();

  constructor(public readonly config: OAuthProviderConfig) {}

  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokenSet> {
    // The harness signals a provider-side rejection with a reserved code, so the
    // failure path is testable without a network.
    if (params.code === 'invalid-code') {
      throw new OAuthInvalidGrantError('invalid_grant: authorization code rejected');
    }
    if (!params.codeVerifier) {
      throw new OAuthInvalidGrantError('invalid_grant: missing PKCE verifier');
    }
    const refreshToken = `test-refresh-${randomBytes(8).toString('hex')}`;
    this.liveRefreshTokens.add(refreshToken);
    return {
      accessToken: `test-access-${randomBytes(8).toString('hex')}`,
      refreshToken,
      expiresIn: 3600,
      scope: this.config.scopes.join(' '),
      tokenType: 'Bearer',
    };
  }

  async refresh(params: { refreshToken: string }): Promise<OAuthTokenSet> {
    // ROTATION, enforced: an already-redeemed refresh token is dead. This is
    // what makes "we rotate refresh tokens" a tested property rather than a
    // claim — reusing the old token after a refresh fails here.
    if (!this.liveRefreshTokens.has(params.refreshToken)) {
      throw new OAuthInvalidGrantError('invalid_grant: refresh token expired or already used');
    }
    this.liveRefreshTokens.delete(params.refreshToken);
    const rotated = `test-refresh-${randomBytes(8).toString('hex')}`;
    this.liveRefreshTokens.add(rotated);
    return {
      accessToken: `test-access-${randomBytes(8).toString('hex')}`,
      refreshToken: rotated,
      expiresIn: 3600,
      scope: this.config.scopes.join(' '),
      tokenType: 'Bearer',
    };
  }

  async revoke(params: { token: string }): Promise<void> {
    this.liveRefreshTokens.delete(params.token);
  }
}

/** Redirect allowlist for the test provider, from trusted backend config only. */
function testRedirectUris(): string[] {
  const base = process.env.APP_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3000';
  return [`${base.replace(/\/$/, '')}/api/v1/platform/integrations/oauth/callback`];
}

const TEST_PROVIDER_KEY = 'test_oauth';

let testAdapter: TestOAuthAdapter | null = null;

/** The test provider is available only when explicitly enabled by the backend. */
export function isTestOAuthEnabled(): boolean {
  return process.env.INTEGRATION_OAUTH_TEST_PROVIDER === 'true';
}

function buildTestAdapter(): TestOAuthAdapter {
  return new TestOAuthAdapter({
    key: TEST_PROVIDER_KEY,
    label: 'Test OAuth provider (non-production)',
    // Loopback sentinels — this adapter performs no network I/O at all.
    authorizationUrl: 'http://127.0.0.1/oauth/authorize',
    tokenUrl: 'http://127.0.0.1/oauth/token',
    revocationUrl: 'http://127.0.0.1/oauth/revoke',
    scopes: ['integration.read', 'integration.write'],
    supportsRefresh: true,
    supportsRevocation: true,
    redirectUris: testRedirectUris(),
    isTestProvider: true,
  });
}

/** Resolve a compiled OAuth adapter, or undefined when none is registered. */
export function resolveOAuthAdapter(providerKey: string): OAuthClientAdapter | undefined {
  if (providerKey === TEST_PROVIDER_KEY && isTestOAuthEnabled()) {
    testAdapter = testAdapter ?? buildTestAdapter();
    return testAdapter;
  }
  return undefined;
}

/** Provider keys currently offering OAuth. Empty in production today. */
export function oauthProviderKeys(): string[] {
  return isTestOAuthEnabled() ? [TEST_PROVIDER_KEY] : [];
}

/** Reset the in-memory test adapter (tests only). */
export function __resetTestOAuthAdapter(): void {
  testAdapter = null;
}

export { TEST_PROVIDER_KEY };
