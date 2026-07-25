import {
  OAuthInvalidGrantError,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
} from './oauth.types';
import {
  __resetTestOAuthAdapter,
  isTestOAuthEnabled,
  oauthProviderKeys,
  resolveOAuthAdapter,
  TEST_PROVIDER_KEY,
} from './oauth.registry';

describe('PKCE primitives (RFC 7636)', () => {
  it('generates a verifier in the legal length range', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it('uses only the unreserved base64url alphabet (no padding)', () => {
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(generateState()).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('produces high-entropy, non-repeating values', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()));
    expect(values.size).toBe(200);
    const states = new Set(Array.from({ length: 200 }, () => generateState()));
    expect(states.size).toBe(200);
  });

  it('S256 challenge is deterministic and never reveals the verifier', () => {
    const v = generateCodeVerifier();
    expect(codeChallengeS256(v)).toBe(codeChallengeS256(v));
    expect(codeChallengeS256(v)).not.toBe(v);
    expect(codeChallengeS256(v)).not.toContain(v.slice(0, 16));
  });

  it('a different verifier yields a different challenge', () => {
    expect(codeChallengeS256('a'.repeat(64))).not.toBe(codeChallengeS256('b'.repeat(64)));
  });
});

describe('OAuth provider registry — disabled unless explicitly enabled', () => {
  const original = process.env.INTEGRATION_OAUTH_TEST_PROVIDER;
  afterEach(() => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = original;
    __resetTestOAuthAdapter();
  });

  it('exposes NO providers by default — the feature stays off in production', () => {
    delete process.env.INTEGRATION_OAUTH_TEST_PROVIDER;
    expect(isTestOAuthEnabled()).toBe(false);
    expect(oauthProviderKeys()).toEqual([]);
    expect(resolveOAuthAdapter(TEST_PROVIDER_KEY)).toBeUndefined();
  });

  it('never resolves an unknown provider key, even when enabled', () => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = 'true';
    expect(resolveOAuthAdapter('some_tenant_supplied_provider')).toBeUndefined();
  });

  it('exposes the test provider only when the backend enables it', () => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = 'true';
    expect(oauthProviderKeys()).toEqual([TEST_PROVIDER_KEY]);
    expect(resolveOAuthAdapter(TEST_PROVIDER_KEY)).toBeDefined();
  });

  it('endpoints come from the compiled config, never from tenant input', () => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = 'true';
    const cfg = resolveOAuthAdapter(TEST_PROVIDER_KEY)!.config;
    expect(cfg.authorizationUrl).toMatch(/^https?:\/\//);
    expect(cfg.redirectUris.length).toBeGreaterThan(0);
    expect(cfg.isTestProvider).toBe(true);
  });
});

describe('test OAuth adapter — token exchange, rotation, revocation', () => {
  const original = process.env.INTEGRATION_OAUTH_TEST_PROVIDER;
  beforeEach(() => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = 'true';
    __resetTestOAuthAdapter();
  });
  afterEach(() => {
    process.env.INTEGRATION_OAUTH_TEST_PROVIDER = original;
    __resetTestOAuthAdapter();
  });

  const adapter = () => resolveOAuthAdapter(TEST_PROVIDER_KEY)!;

  it('exchanges a code for an access + refresh token', async () => {
    const tokens = await adapter().exchangeCode({
      code: 'good-code',
      codeVerifier: generateCodeVerifier(),
      redirectUri: 'http://localhost:3000/cb',
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresIn).toBe(3600);
  });

  it('rejects an exchange with no PKCE verifier', async () => {
    await expect(
      adapter().exchangeCode({ code: 'good-code', codeVerifier: '', redirectUri: 'http://localhost:3000/cb' }),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it('surfaces a provider rejection as invalid_grant', async () => {
    await expect(
      adapter().exchangeCode({
        code: 'invalid-code',
        codeVerifier: generateCodeVerifier(),
        redirectUri: 'http://localhost:3000/cb',
      }),
    ).rejects.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it('ROTATES the refresh token — the old one is dead afterwards', async () => {
    const a = adapter();
    const first = await a.exchangeCode({
      code: 'good-code',
      codeVerifier: generateCodeVerifier(),
      redirectUri: 'http://localhost:3000/cb',
    });
    const refreshed = await a.refresh({ refreshToken: first.refreshToken as string });

    expect(refreshed.refreshToken).toBeTruthy();
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    // Reusing the consumed token is exactly what a double-refresh race would do.
    await expect(a.refresh({ refreshToken: first.refreshToken as string })).rejects.toBeInstanceOf(
      OAuthInvalidGrantError,
    );
  });

  it('treats an unknown refresh token as invalid_grant', async () => {
    await expect(adapter().refresh({ refreshToken: 'never-issued' })).rejects.toBeInstanceOf(
      OAuthInvalidGrantError,
    );
  });

  it('revocation kills the refresh token', async () => {
    const a = adapter();
    const tokens = await a.exchangeCode({
      code: 'good-code',
      codeVerifier: generateCodeVerifier(),
      redirectUri: 'http://localhost:3000/cb',
    });
    await a.revoke!({ token: tokens.refreshToken as string });
    await expect(a.refresh({ refreshToken: tokens.refreshToken as string })).rejects.toBeInstanceOf(
      OAuthInvalidGrantError,
    );
  });
});
