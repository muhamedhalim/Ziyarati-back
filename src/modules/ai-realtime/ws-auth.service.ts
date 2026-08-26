import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';

import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Authenticates a Socket.IO handshake by verifying the SAME access JWT the REST
 * API uses (`JWT_ACCESS_SECRET`) — no parallel auth. The token may arrive via
 * `handshake.auth.token`, an `Authorization: Bearer` header, or `?token=`.
 * AI chat is tenant-scoped, so a token without a tenant is rejected.
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

  async authenticate(client: Socket): Promise<AuthenticatedUser> {
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
  ): Promise<AuthenticatedUser> {
    let payload: { sub?: string; tenantId?: string | null; guest?: boolean };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: accessSecret });
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (!payload.sub || !payload.tenantId) {
      throw new UnauthorizedException('Token is not tenant-scoped');
    }

    // Guests are not real `users` rows (see GuestSessionService) — no roles or
    // permissions, scoped to the data-less discovery tenant.
    if (payload.guest) {
      return {
        id: payload.sub,
        tenantId: payload.tenantId,
        email: null,
        roles: [],
        permissions: [],
        guest: true,
      };
    }

    // Real principal: reuse the EXACT same lookup JwtStrategy uses for REST, so
    // WS and HTTP see identical roles/permissions (live, not stale token claims).
    try {
      return await this.auth.buildAuthenticatedUser(payload.sub);
    } catch {
      throw new UnauthorizedException('User is inactive or no longer exists');
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
    const q = client.handshake.query?.token;
    if (typeof q === 'string') push(q);

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
