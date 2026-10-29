import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';

import { AppError, ErrorCode } from '../../common/errors';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * What a handshake proved: who the socket is, and until when the credential
 * that proved it is good. `expiresAt` is epoch milliseconds, or `null` for a
 * token minted without an `exp` claim (none is, in production).
 *
 * The expiry is reported separately from the principal because it belongs to
 * the CREDENTIAL, not the user — `AuthenticatedUser` is built by REST too, where
 * every request re-verifies the token, and must not grow a socket-only field.
 */
export interface WsSession {
  user: AuthenticatedUser;
  expiresAt: number | null;
}

/**
 * Authenticates a Socket.IO handshake by verifying the SAME access JWT the REST
 * API uses (`JWT_ACCESS_SECRET`) — no parallel auth. The token may arrive via
 * `handshake.auth.token`, an `Authorization: Bearer` header, or the browser's
 * own `access_token` / `guest_token` cookie. AI chat is tenant-scoped, so a
 * token without a tenant is rejected.
 *
 * There is deliberately no `?token=` query parameter: a URL is written to
 * proxy, load-balancer and access logs, and a bearer credential has no business
 * there. No first-party or test client used it; `handshake.auth.token` carries
 * the same explicit credential in the CONNECT packet instead.
 *
 * Returns the FULL `AuthenticatedUser` (roles + permissions), not just raw ids,
 * so the gateway can restore a real TenantContextService principal for the turn.
 * Previously every WS-driven AI turn ran with `ctx.getUser() === null`, which
 * silently broke booking tools (they require `actorUserId`) and would let the
 * Dashboard Assistant's admin tools run with nothing to permission-check.
 */
@Injectable()
export class WsAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  /** The principal alone — see {@link authenticateHandshake} for the credential's expiry too. */
  async authenticate(client: Socket): Promise<AuthenticatedUser> {
    return (await this.authenticateHandshake(client)).user;
  }

  async authenticateHandshake(client: Socket): Promise<WsSession> {
    const candidates = this.extractTokens(client);
    if (candidates.length === 0)
      throw new UnauthorizedException('Missing access token');
    // Resolved BEFORE the try/catch (ZT-007) so a missing configuration
    // value fails loudly instead of surfacing as an indistinguishable
    // "Invalid access token".
    const accessSecret = this.config.getOrThrow<string>('JWT_ACCESS_SECRET');

    // Candidates are already in privilege order (see `extractTokens`), so the
    // first one that authenticates wins and a lower-privilege fallback is only
    // ever reached when everything above it is unusable. `?? throw` is not
    // possible here: the LAST failure is the one worth reporting.
    let lastError: unknown;
    for (const token of candidates) {
      try {
        return await this.authenticateToken(token, accessSecret);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError as Error;
  }

  private async authenticateToken(
    token: string,
    accessSecret: string,
  ): Promise<WsSession> {
    let payload: {
      sub?: string;
      tenantId?: string | null;
      guest?: boolean;
      type?: string;
      exp?: number;
      sid?: string;
    };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: accessSecret });
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    // CR-44: REST (`JwtStrategy.validate`) refuses any token whose `type` is not 'access'. The
    // handshake must too, otherwise a REFRESH token authenticates a socket whenever the two
    // secrets happen to be equal. Guest tokens are minted without a `type` claim; they are
    // tenant-scoped and `guest: true`, and may not carry a conflicting type either.
    if (
      payload.guest ? payload.type !== undefined : payload.type !== 'access'
    ) {
      throw new UnauthorizedException('Invalid token type');
    }
    if (!payload.sub || !payload.tenantId) {
      throw new UnauthorizedException('Token is not tenant-scoped');
    }
    // `exp` is seconds since the epoch (RFC 7519); the gateway compares against
    // `Date.now()`.
    const expiresAt =
      typeof payload.exp === 'number' ? payload.exp * 1000 : null;

    // Guests are not real `users` rows (see GuestSessionService) — no roles or
    // permissions, scoped to the data-less discovery tenant.
    if (payload.guest) {
      return {
        user: {
          id: payload.sub,
          tenantId: payload.tenantId,
          email: null,
          roles: [],
          permissions: [],
          guest: true,
        },
        expiresAt,
      };
    }

    // Same session rule as REST (SEC-02): a logged-out session's access token
    // cannot open a socket either.
    if (
      payload.sid !== undefined &&
      !(await this.auth.isSessionLive(payload.sid))
    ) {
      throw new UnauthorizedException('Session has ended');
    }

    // Real principal: reuse the EXACT same lookup JwtStrategy uses for REST, so
    // WS and HTTP see identical roles/permissions (live, not stale token claims).
    try {
      return {
        user: await this.auth.buildAuthenticatedUser(payload.sub),
        expiresAt,
      };
    } catch {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }
  }

  /**
   * Re-resolves a connected staff principal from the database, so a socket that
   * outlives its handshake cannot keep privileges that have since been taken
   * away. REST does this on every request (`JwtStrategy.validate`); a socket
   * resolves once at connect, which is what this closes.
   *
   * Returns the fresh principal, or `null` when the user is now inactive or gone
   * — the one DEFINITIVE answer, on which the socket must end. Anything else (a
   * database or pool error) is rethrown: the caller keeps the principal it has
   * and asks again next time, because a transient blip must never mass-disconnect
   * every agent — and equally must not be mistaken for "still authorized"
   * forever, which is why the caller retries rather than caching the failure.
   *
   * A guest has no `users` row and no permissions to lose, so it is returned
   * unchanged without a query.
   */
  async revalidate(user: AuthenticatedUser): Promise<AuthenticatedUser | null> {
    if (user.guest) return user;
    try {
      return await this.auth.buildAuthenticatedUser(user.id);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.USER_INACTIVE) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Every token this handshake could legitimately authenticate with, most
   * privileged first. `authenticate` walks the list and stops at the first one
   * that actually resolves to a principal.
   *
   * WHY A LIST AND NOT A SINGLE PICK. The browser sends every cookie scoped to
   * the handshake path, so a visitor who is signed in AND has an anonymous
   * guest session carries both `access_token` and `guest_token`. Returning only
   * the first meant one unusable `access_token` made the public assistant
   * permanently unreachable for that browser, even though the widget had just
   * minted a perfectly valid guest session microseconds earlier:
   *
   *  - a `super_admin` session (`tenantId: null`) can NEVER authenticate this
   *    namespace — AI chat is tenant-scoped by design — so every visitor
   *    holding one got `ai:error UNAUTHORIZED` and a widget stuck on
   *    "Connecting…" on the public marketing pages. Reproduced in a browser.
   *  - the same happened for an expired/rotated `access_token` or one whose
   *    user was deactivated, until the cookie happened to be cleared.
   *
   * SAFETY. This can only ever move DOWN in privilege, never up. A guest token
   * resolves to `roles: []`, `permissions: []` and the data-less discovery
   * tenant (see `GuestSessionService`), so falling back to it grants strictly
   * less than the token that failed — and it is the browser's own cookie,
   * verified with the same secret and the same tenant-scoping rule as any
   * other. A VALID tenant-scoped `access_token` still always wins, so a
   * signed-in clinic user keeps their own identity on the dashboard assistant.
   */
  private extractTokens(client: Socket): string[] {
    const tokens: string[] = [];
    const push = (t: string | null | undefined) => {
      if (t && !tokens.includes(t)) tokens.push(t);
    };

    // Explicitly supplied credentials outrank cookies — a caller that named a
    // token means that token (native clients, tests, the RTL harness).
    const auth = client.handshake.auth as { token?: string } | undefined;
    push(auth?.token);
    const header = client.handshake.headers?.authorization;
    if (header?.startsWith('Bearer ')) push(header.slice(7));

    // The web app authenticates via the HttpOnly `access_token` cookie; anonymous
    // visitors use a `guest_token` cookie (path `/` so it reaches the handshake).
    // Both are the browser's own cookies, sent when the client uses withCredentials.
    const cookie = client.handshake.headers?.cookie;
    push(this.readCookie(cookie, 'access_token'));
    push(this.readCookie(cookie, 'guest_token'));

    return tokens;
  }

  private readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
  }
}
