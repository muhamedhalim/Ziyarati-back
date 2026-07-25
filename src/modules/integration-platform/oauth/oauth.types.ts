import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth2 Authorization-Code + PKCE client support (Phase 4).
 *
 * The platform is the CLIENT. It is NOT an authorization server: it never issues
 * authorization codes or access tokens for itself, and nothing here validates a
 * third party's credentials.
 *
 * Every provider's authorization/token/revocation endpoints come from a COMPILED
 * definition plus trusted backend configuration (client id/secret from env).
 * Tenant input can never supply a URL — that would be an SSRF and open-redirect
 * surface — and the redirect URI is allowlisted per provider, not echoed back
 * from the request.
 */

export interface OAuthProviderConfig {
  key: string;
  label: string;
  /** Provider's authorization endpoint. Compiled/config-supplied only. */
  authorizationUrl: string;
  /** Provider's token endpoint. Compiled/config-supplied only. */
  tokenUrl: string;
  /** Optional RFC 7009 revocation endpoint. */
  revocationUrl?: string;
  /** Scopes requested at authorization. */
  scopes: string[];
  /** Whether the provider issues (and rotates) refresh tokens. */
  supportsRefresh: boolean;
  /** Whether the provider supports token revocation on disconnect. */
  supportsRevocation: boolean;
  /**
   * EXACT redirect URIs permitted for this provider. A callback whose redirect
   * is not on this list is refused — the allowlist is the whole point, so it is
   * never derived from the incoming request.
   */
  redirectUris: string[];
  /** True only for the deterministic in-process test adapter. */
  isTestProvider?: boolean;
}

/** Token response, normalized across providers. */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** Seconds until the access token expires. */
  expiresIn?: number | null;
  scope?: string | null;
  tokenType?: string | null;
}

/**
 * The client operations a provider must support. Implemented by compiled
 * adapters only — a tenant can never register one.
 */
export interface OAuthClientAdapter {
  readonly config: OAuthProviderConfig;
  /** Exchange an authorization code (+ PKCE verifier) for tokens. */
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthTokenSet>;
  /** Redeem a refresh token. Providers that rotate return a NEW refresh token. */
  refresh(params: { refreshToken: string }): Promise<OAuthTokenSet>;
  /** Best-effort revocation. Never throws — disconnect must always succeed locally. */
  revoke?(params: { token: string }): Promise<void>;
}

/**
 * Raised when a provider rejects a refresh token (`invalid_grant`): the grant is
 * permanently dead, so the caller must clear the stored tokens and ask the user
 * to reconnect rather than retrying forever.
 */
export class OAuthInvalidGrantError extends Error {
  constructor(message = 'The provider rejected the stored refresh token') {
    super(message);
    this.name = 'OAuthInvalidGrantError';
  }
}

// ── PKCE primitives (RFC 7636) ──────────────────────────────────────────────

/** High-entropy code verifier (43–128 chars, unreserved alphabet). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(64));
}

/** S256 challenge — only this is sent to the provider; the verifier stays here. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Single-use CSRF state token. */
export function generateState(): string {
  return base64url(randomBytes(32));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
