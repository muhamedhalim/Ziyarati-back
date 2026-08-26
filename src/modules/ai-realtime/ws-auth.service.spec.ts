import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import type { Socket } from 'socket.io';

import { WsAuthService } from './ws-auth.service';
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
});
