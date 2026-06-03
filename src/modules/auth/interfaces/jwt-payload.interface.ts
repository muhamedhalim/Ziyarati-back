/**
 * Shape of the data we encode inside the access token.
 * `tenantId` is null for platform super-admins (see users.tenant_id NULL convention).
 */
export interface JwtPayload {
  sub: string; // user id
  tenantId: string | null;
  email?: string | null;
  type: 'access';
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
