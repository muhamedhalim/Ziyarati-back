/**
 * Shape of the data we encode inside the access token.
 * `tenantId` is null for platform super-admins (see users.tenant_id NULL convention).
 */
export interface JwtPayload {
  sub: string; // user id
  tenantId: string | null;
  email?: string | null;
  type: 'access';
  /**
   * The session (refresh-token family) this access token was issued for. Lets
   * the API refuse an access token whose session was logged out, instead of
   * honouring it until its natural expiry (SEC-02). Absent only on tokens
   * minted before this claim existed — those simply expire on schedule.
   */
  sid?: string;
}

/**
 * Payload encoded inside a refresh token. Kept intentionally small; the token
 * itself is also persisted (hashed) in the refresh_tokens table for revocation.
 */
export interface RefreshTokenPayload {
  sub: string; // user id
  tenantId: string | null;
  jti: string; // refresh_tokens.id
  type: 'refresh';
}
