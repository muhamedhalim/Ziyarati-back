import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { Socket } from 'socket.io';

import { WsAuthService } from './ws-auth.service';
import { AppError, ErrorCode } from '../../common/errors';
import { createMockConfigService } from '../../../test/utils/mock-factories';

/**
 * WsAuthService authenticates every `/ai` namespace handshake — the socket
 * exercised by ZT-004a's realtime-parser fix and the sole consumer this
 * finding's threat model describes (an anonymous guest's socket). No
 * existing unit spec covered it before this feature (research.md D4).
 */
describe('WsAuthService', () => {
  let jwt: JwtService;
  let auth: { buildAuthenticatedUser: jest.Mock };

  const socketWith = (
    auth: Record<string, unknown>,
    headers: Record<string, unknown> = {},
  ): Socket =>
    ({
      handshake: { auth, headers, query: {} },
    }) as unknown as Socket;

  beforeEach(() => {
    jwt = new JwtService({});
    auth = { buildAuthenticatedUser: jest.fn() };
  });

  describe('authenticate', () => {
    it('rejects a handshake with no token at all', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      await expect(service.authenticate(socketWith({}))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('accepts a valid guest token (auth.token) and returns the guest principal, unresolved against AuthService', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      const result = await service.authenticate(socketWith({ token }));
      expect(result).toMatchObject({
        id: 'guest-1',
        tenantId: 'tenant-1',
        guest: true,
        roles: [],
        permissions: [],
      });
      expect(auth.buildAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('accepts a valid non-guest token and resolves the live principal via AuthService', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      auth.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'user-1',
        tenantId: 'tenant-1',
        roles: ['owner'],
        permissions: [],
      });
      const token = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1' },
        { secret: 'test-secret' },
      );
      const result = await service.authenticate(socketWith({ token }));
      expect(auth.buildAuthenticatedUser).toHaveBeenCalledWith('user-1');
      expect(result).toMatchObject({ id: 'user-1', tenantId: 'tenant-1' });
    });

    it('rejects a token with no tenant (tenant-scoping required)', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const token = await jwt.signAsync(
        { sub: 'user-1' },
        { secret: 'test-secret' },
      );
      await expect(service.authenticate(socketWith({ token }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token signed with the wrong secret', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'attacker-secret' },
      );
      await expect(service.authenticate(socketWith({ token }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('falls back to the access_token or guest_token cookie when no auth.token/header is present', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      const result = await service.authenticate(
        socketWith({}, { cookie: `guest_token=${token}` }),
      );
      expect(result).toMatchObject({ id: 'guest-1', guest: true });
    });
  });

  /**
   * A browser sends EVERY cookie scoped to the handshake path, so a visitor who
   * is signed in and also has an anonymous guest session carries both. Trying
   * only `access_token` made the public assistant permanently unreachable for
   * that browser — reproduced live with a `super_admin` session, whose token
   * can never authenticate this tenant-scoped namespace.
   */
  describe('cookie candidate order (both access_token and guest_token present)', () => {
    const guestClaims = {
      sub: 'guest-1',
      tenantId: 'guest-tenant',
      guest: true,
    };

    it('falls back to guest_token when access_token is not tenant-scoped (super_admin session)', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const superAdmin = await jwt.signAsync(
        { sub: 'admin-1', tenantId: null },
        { secret: 'test-secret' },
      );
      const guest = await jwt.signAsync(guestClaims, { secret: 'test-secret' });

      const result = await service.authenticate(
        socketWith(
          {},
          { cookie: `access_token=${superAdmin}; guest_token=${guest}` },
        ),
      );

      expect(result).toMatchObject({
        id: 'guest-1',
        tenantId: 'guest-tenant',
        guest: true,
      });
      expect(auth.buildAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('falls back to guest_token when access_token is expired/invalid', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const stale = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1' },
        { secret: 'a-rotated-secret' },
      );
      const guest = await jwt.signAsync(guestClaims, { secret: 'test-secret' });

      const result = await service.authenticate(
        socketWith(
          {},
          { cookie: `access_token=${stale}; guest_token=${guest}` },
        ),
      );

      expect(result).toMatchObject({ id: 'guest-1', guest: true });
    });

    it('falls back to guest_token when the access_token user no longer resolves', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      auth.buildAuthenticatedUser.mockRejectedValueOnce(new Error('gone'));
      const deactivated = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1' },
        { secret: 'test-secret' },
      );
      const guest = await jwt.signAsync(guestClaims, { secret: 'test-secret' });

      const result = await service.authenticate(
        socketWith(
          {},
          { cookie: `access_token=${deactivated}; guest_token=${guest}` },
        ),
      );

      expect(result).toMatchObject({ id: 'guest-1', guest: true });
    });

    it('NEVER downgrades a usable access_token to the guest identity', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      auth.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'user-1',
        tenantId: 'tenant-1',
        roles: ['owner'],
        permissions: [],
      });
      const access = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1' },
        { secret: 'test-secret' },
      );
      const guest = await jwt.signAsync(guestClaims, { secret: 'test-secret' });

      const result = await service.authenticate(
        socketWith(
          {},
          { cookie: `access_token=${access}; guest_token=${guest}` },
        ),
      );

      expect(result).toMatchObject({
        id: 'user-1',
        tenantId: 'tenant-1',
        roles: ['owner'],
      });
    });

    it('still rejects when EVERY candidate is unusable', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
      const superAdmin = await jwt.signAsync(
        { sub: 'admin-1', tenantId: null },
        { secret: 'test-secret' },
      );
      const forged = await jwt.signAsync(
        { sub: 'guest-x', tenantId: 'guest-tenant', guest: true },
        { secret: 'attacker-secret' },
      );

      await expect(
        service.authenticate(
          socketWith(
            {},
            { cookie: `access_token=${superAdmin}; guest_token=${forged}` },
          ),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ZT-007: the verification path must fail loudly when its key is absent
  // from configuration, distinguishably from a merely-invalid token — not
  // collapse both into the same generic "Invalid access token".
  describe('fails loudly when JWT_ACCESS_SECRET is unset (ZT-007)', () => {
    it('raises a configuration error rather than a generic UnauthorizedException', async () => {
      const service = new WsAuthService(
        jwt,
        createMockConfigService({}) as never,
        auth as never,
      );
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'whatever' },
      );
      await expect(service.authenticate(socketWith({ token }))).rejects.toThrow(
        /JWT_ACCESS_SECRET/,
      );
    });
  });

  // F-5: a bearer credential in a URL is written to proxy / load-balancer /
  // access logs. `?token=` was accepted although no client used it.
  describe('the query string is not a credential (F-5)', () => {
    const service = () =>
      new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );

    it('a perfectly valid token in ?token= authenticates nothing', async () => {
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      const client = {
        handshake: { auth: {}, headers: {}, query: { token } },
      } as unknown as Socket;
      await expect(service().authenticate(client)).rejects.toThrow(
        'Missing access token',
      );
      expect(auth.buildAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('does not fall back to it when the real credentials are unusable', async () => {
      const good = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      const bad = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'attacker-secret' },
      );
      const client = {
        handshake: {
          auth: { token: bad },
          headers: {},
          query: { token: good },
        },
      } as unknown as Socket;
      await expect(service().authenticate(client)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('the supported carriers still work: handshake.auth.token, Authorization: Bearer, and the cookies', async () => {
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      const s = service();
      await expect(
        s.authenticate(socketWith({ token })),
      ).resolves.toMatchObject({ id: 'guest-1' });
      await expect(
        s.authenticate(socketWith({}, { authorization: `Bearer ${token}` })),
      ).resolves.toMatchObject({ id: 'guest-1' });
      await expect(
        s.authenticate(socketWith({}, { cookie: `guest_token=${token}` })),
      ).resolves.toMatchObject({ id: 'guest-1' });
    });
  });

  // F-4: the gateway enforces the credential's expiry for the life of the
  // socket, so the handshake has to say when that is.
  describe('authenticateHandshake — reports when the credential lapses (F-4)', () => {
    const service = () =>
      new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );

    it('returns the token exp in epoch MILLISECONDS alongside a guest principal', async () => {
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret', expiresIn: 3600 },
      );
      const { exp } = jwt.decode(token) as { exp: number };
      const session = await service().authenticateHandshake(
        socketWith({ token }),
      );
      expect(session.expiresAt).toBe(exp * 1000);
      expect(session.user).toMatchObject({ id: 'guest-1', guest: true });
    });

    it('returns it for a staff principal too, resolved live from the database', async () => {
      auth.buildAuthenticatedUser.mockResolvedValueOnce({
        id: 'user-1',
        tenantId: 'tenant-1',
        roles: [],
        permissions: ['p'],
      });
      const token = await jwt.signAsync(
        { sub: 'user-1', tenantId: 'tenant-1' },
        { secret: 'test-secret', expiresIn: 900 },
      );
      const { exp } = jwt.decode(token) as { exp: number };
      const session = await service().authenticateHandshake(
        socketWith({ token }),
      );
      expect(session.expiresAt).toBe(exp * 1000);
      expect(session.user.permissions).toEqual(['p']);
    });

    it('reports null for a token minted without an exp claim — nothing to enforce, not "already expired"', async () => {
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      expect(
        (await service().authenticateHandshake(socketWith({ token })))
          .expiresAt,
      ).toBeNull();
    });

    it('refuses a token that has already expired at the handshake', async () => {
      const token = await jwt.signAsync(
        {
          sub: 'guest-1',
          tenantId: 'tenant-1',
          guest: true,
          exp: Math.floor(Date.now() / 1000) - 10,
        },
        { secret: 'test-secret' },
      );
      await expect(
        service().authenticateHandshake(socketWith({ token })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('authenticate() is unchanged for existing callers: the principal alone', async () => {
      const token = await jwt.signAsync(
        { sub: 'guest-1', tenantId: 'tenant-1', guest: true },
        { secret: 'test-secret' },
      );
      await expect(
        service().authenticate(socketWith({ token })),
      ).resolves.toMatchObject({
        id: 'guest-1',
        guest: true,
      });
    });
  });

  describe('revalidate — re-resolving a connected principal (F-4)', () => {
    const service = () =>
      new WsAuthService(
        jwt,
        createMockConfigService({ JWT_ACCESS_SECRET: 'test-secret' }) as never,
        auth as never,
      );
    const staffPrincipal = {
      id: 'user-1',
      tenantId: 'tenant-1',
      roles: ['r'],
      permissions: ['a'],
    };

    it('returns the CURRENT roles and permissions from the database', async () => {
      const fresh = { ...staffPrincipal, permissions: ['a', 'b'] };
      auth.buildAuthenticatedUser.mockResolvedValueOnce(fresh);
      await expect(service().revalidate(staffPrincipal as never)).resolves.toBe(
        fresh,
      );
      expect(auth.buildAuthenticatedUser).toHaveBeenCalledWith('user-1');
    });

    it('returns null — the definitive answer — for an inactive or removed user', async () => {
      auth.buildAuthenticatedUser.mockRejectedValueOnce(
        new AppError(ErrorCode.USER_INACTIVE),
      );
      await expect(
        service().revalidate(staffPrincipal as never),
      ).resolves.toBeNull();
    });

    it('RETHROWS anything else — a database error is not "the user is gone"', async () => {
      const boom = new Error('connection terminated');
      auth.buildAuthenticatedUser.mockRejectedValueOnce(boom);
      await expect(service().revalidate(staffPrincipal as never)).rejects.toBe(
        boom,
      );
    });

    it('does not mistake a different AppError for inactivity', async () => {
      const other = new AppError(ErrorCode.FORBIDDEN);
      auth.buildAuthenticatedUser.mockRejectedValueOnce(other);
      await expect(service().revalidate(staffPrincipal as never)).rejects.toBe(
        other,
      );
    });

    it('returns a guest unchanged without a query — it has no user row and no permissions to lose', async () => {
      const guest = {
        id: 'g',
        tenantId: 't',
        roles: [],
        permissions: [],
        guest: true,
      };
      await expect(service().revalidate(guest as never)).resolves.toBe(guest);
      expect(auth.buildAuthenticatedUser).not.toHaveBeenCalled();
    });
  });
});
