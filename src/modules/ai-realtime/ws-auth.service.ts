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
    const token = this.extractToken(client);
    if (!token) throw new UnauthorizedException('Missing access token');
    let payload: { sub?: string; tenantId?: string | null; guest?: boolean };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (!payload.sub || !payload.tenantId) {
      throw new UnauthorizedException('Token is not tenant-scoped');
    }

    // Guests are not real `users` rows (see GuestSessionService) — no roles or
    // permissions, scoped to the data-less discovery tenant.
    if (payload.guest) {
      return { id: payload.sub, tenantId: payload.tenantId, email: null, roles: [], permissions: [] };
    }

    // Real principal: reuse the EXACT same lookup JwtStrategy uses for REST, so
    // WS and HTTP see identical roles/permissions (live, not stale token claims).
    try {
      return await this.auth.buildAuthenticatedUser(payload.sub);
    } catch {
      throw new UnauthorizedException('User is inactive or no longer exists');
    }
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as { token?: string } | undefined;
    if (auth?.token) return auth.token;
    const header = client.handshake.headers?.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    const q = client.handshake.query?.token;
    if (typeof q === 'string' && q) return q;
    // The web app authenticates via the HttpOnly `access_token` cookie; anonymous
    // visitors use a `guest_token` cookie (path `/` so it reaches the handshake).
    // Both are the browser's own cookies, sent when the client uses withCredentials.
    const cookie = client.handshake.headers?.cookie;
    return this.readCookie(cookie, 'access_token') ?? this.readCookie(cookie, 'guest_token');
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
