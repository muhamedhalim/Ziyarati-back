import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';

import { AuthService } from './auth.service';
import { User } from '../../entities/Auth&RBAC/User';
import { RefreshToken } from '../../entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { UsageService } from '../subscription-billing/usage.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { EmailService } from '../email/email.service';
import { AppError } from '../../common/errors';
import { ErrorCode } from '../../common/errors';
import { ROLE } from '../../rbac/rbac.constants';

import {
  createMockRepository,
  createMockDataSource,
  createMockConfigService,
  createMockJwtService,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

// bcrypt is mocked module-wide: unit tests must never run real 12-round hashing.
jest.mock('bcryptjs');

/** A live-principal user row as loaded by buildAuthenticatedUser (with relations). */
const principalRow = () => ({
  id: 'user-1',
  email: 'owner@clinic.com',
  is_active: true,
  tenant: { id: 'tenant-1' },
  userRoles: [
    {
      role: {
        slug: 'owner',
        rolePermissions: [
          { permission: { slug: 'appointments.read' } },
          { permission: { slug: 'appointments.create' } },
          // duplicate slug across roles must be de-duplicated
          { permission: { slug: 'appointments.read' } },
        ],
      },
    },
  ],
});

const expectedPrincipal = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'owner@clinic.com',
  roles: ['owner'],
  permissions: ['appointments.read', 'appointments.create'],
};

describe('AuthService', () => {
  let service: AuthService;
  let users: MockRepository;
  let refreshTokens: MockRepository;
  let passwordResets: MockRepository;
  let tenants: MockRepository;
  let dataSource: MockDataSource;
  let jwt: ReturnType<typeof createMockJwtService>;
  let usage: { assertCountWithinLimit: jest.Mock };
  let platformSettings: { getTyped: jest.Mock };
  let email: { sendWelcome: jest.Mock; sendPasswordReset: jest.Mock };
  const bcryptHash = bcrypt.hash as unknown as jest.Mock;
  const bcryptCompare = bcrypt.compare as unknown as jest.Mock;

  beforeEach(async () => {
    users = createMockRepository();
    refreshTokens = createMockRepository();
    passwordResets = createMockRepository();
    tenants = createMockRepository();
    dataSource = createMockDataSource();
    jwt = createMockJwtService();
    usage = { assertCountWithinLimit: jest.fn().mockResolvedValue(undefined) };
    platformSettings = { getTyped: jest.fn().mockResolvedValue(true) };
    email = {
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    };

    bcryptHash.mockResolvedValue('hashed-password');
    bcryptCompare.mockResolvedValue(true);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        { provide: getRepositoryToken(PasswordReset), useValue: passwordResets },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: createMockConfigService() },
        { provide: DataSource, useValue: dataSource },
        { provide: UsageService, useValue: usage },
        { provide: SystemSettingService, useValue: platformSettings },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // ───────────────────────────── registerOwner ──────────────────────────────
  describe('registerOwner', () => {
    const dto = {
      clinicName: 'Al Noor Clinic',
      slug: 'al-noor',
      email: 'owner@clinic.com',
      phone: '+966500000000',
      fullName: 'Owner One',
      password: 'StrongPass123!',
      commercialRegistrationNumber: 'CR-1',
    } as any;

    it('creates tenant + owner atomically and returns tokens + principal (success path)', async () => {
      tenants.findOne.mockResolvedValueOnce(null); // slug free
      dataSource.manager.findOne.mockResolvedValueOnce({ id: 'role-owner', slug: 'owner' }); // owner role seeded
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser

      const result = await service.registerOwner(dto);

      expect(tenants.findOne).toHaveBeenCalledWith({ where: { slug: 'al-noor' } });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(bcryptHash).toHaveBeenCalledWith('StrongPass123!', 12);
      expect(result.user).toEqual(expectedPrincipal);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toBe('signed.jwt.token');
      expect(refreshTokens.save).toHaveBeenCalledTimes(1); // refresh token persisted
    });

    it('rejects a taken slug with CONFLICT', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(service.registerOwner(dto)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rolls back (throws ROLE_NOT_FOUND) when the owner role is not seeded', async () => {
      tenants.findOne.mockResolvedValueOnce(null);
      dataSource.manager.findOne.mockResolvedValueOnce(null); // owner role missing

      await expect(service.registerOwner(dto)).rejects.toMatchObject({
        code: ErrorCode.ROLE_NOT_FOUND,
      });
    });
  });

  // ──────────────────────────── createTenantUser ────────────────────────────
  describe('createTenantUser', () => {
    const dto = {
      email: 'reception@clinic.com',
      phone: '+966511111111',
      fullName: 'Receptionist',
      password: 'StaffPass123!',
    } as any;

    it('creates a receptionist by default within the actor tenant (success path)', async () => {
      users.findOne.mockResolvedValueOnce(null); // no existing email
      users.count.mockResolvedValueOnce(3);
      dataSource.manager.findOne.mockResolvedValueOnce({ id: 'role-rec', slug: ROLE.RECEPTIONIST });
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser

      const result = await service.createTenantUser(dto, 'tenant-1');

      expect(usage.assertCountWithinLimit).toHaveBeenCalledWith('tenant-1', 'max_users', 3);
      expect(result).toEqual(expectedPrincipal);
    });

    it('accepts an explicit assignable role (manager)', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      dataSource.manager.findOne.mockResolvedValueOnce({ id: 'role-mgr', slug: ROLE.MANAGER });
      users.findOne.mockResolvedValueOnce(principalRow());

      await expect(
        service.createTenantUser({ ...dto, roleSlug: ROLE.MANAGER }, 'tenant-1'),
      ).resolves.toEqual(expectedPrincipal);
    });

    it('forbids staff creation without a tenant scope (super-admin actor)', async () => {
      await expect(service.createTenantUser(dto, null)).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    });

    it('blocks assigning a privileged role through the staff flow', async () => {
      await expect(
        service.createTenantUser({ ...dto, roleSlug: ROLE.OWNER }, 'tenant-1'),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('rejects a duplicate email within the tenant', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(service.createTenantUser(dto, 'tenant-1')).rejects.toMatchObject({
        code: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
    });

    it('propagates the plan user-limit failure from UsageService', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(10);
      usage.assertCountWithinLimit.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'user limit reached' }),
      );

      await expect(service.createTenantUser(dto, 'tenant-1')).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────── login ─────────────────────────────────
  describe('login', () => {
    it('verifies credentials, stamps last_login_at and returns tokens', async () => {
      const credUser = {
        id: 'user-1',
        password_hash: 'hashed-password',
        is_active: true,
        tenant: { id: 'tenant-1' },
      };
      users.find.mockResolvedValueOnce([credUser]); // validateCredentials
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser
      bcryptCompare.mockResolvedValueOnce(true);

      const result = await service.login({ email: 'owner@clinic.com', password: 'pw' } as any);

      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({ last_login_at: expect.any(Date) }),
      );
      expect(result.user).toEqual(expectedPrincipal);
    });
  });

  // ────────────────────────── validateCredentials ───────────────────────────
  describe('validateCredentials', () => {
    const activeUser = {
      id: 'user-1',
      password_hash: 'hashed-password',
      is_active: true,
      tenant: null,
    };

    it('returns the user on a correct super-admin (no tenant) login', async () => {
      users.find.mockResolvedValueOnce([activeUser]);
      bcryptCompare.mockResolvedValueOnce(true);

      await expect(service.validateCredentials('a@b.com', 'pw')).resolves.toBe(activeUser);
    });

    it('resolves a tenant owner by email WITHOUT a tenantSlug (unified login form)', async () => {
      // Regression: the web login form sends only email + password. A
      // tenant-scoped owner must resolve without a slug — previously this
      // matched `tenant IS NULL` and always failed.
      const owner = { ...activeUser, tenant: { id: 'tenant-1' } };
      users.find.mockResolvedValueOnce([owner]);
      bcryptCompare.mockResolvedValueOnce(true);

      await expect(service.validateCredentials('OWNER@Clinic.com ', 'pw')).resolves.toBe(owner);
      // Email is normalised (lower-cased + trimmed) before the lookup.
      expect(users.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'owner@clinic.com' } }),
      );
    });

    it('resolves the tenant when a tenantSlug is supplied', async () => {
      tenants.findOne.mockResolvedValueOnce({ id: 'tenant-9' });
      users.find.mockResolvedValueOnce([activeUser]);
      bcryptCompare.mockResolvedValueOnce(true);

      await service.validateCredentials('a@b.com', 'pw', 'clinic-slug');

      expect(tenants.findOne).toHaveBeenCalledWith({ where: { slug: 'clinic-slug' } });
      expect(users.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'a@b.com', tenant: { id: 'tenant-9' } },
        }),
      );
    });

    it('throws INVALID_CREDENTIALS for an unknown tenant slug (no enumeration leak)', async () => {
      tenants.findOne.mockResolvedValueOnce(null);

      await expect(service.validateCredentials('a@b.com', 'pw', 'nope')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS when the user does not exist', async () => {
      users.find.mockResolvedValueOnce([]);
      await expect(service.validateCredentials('a@b.com', 'pw')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS when the user has no password hash', async () => {
      users.find.mockResolvedValueOnce([{ ...activeUser, password_hash: null }]);
      await expect(service.validateCredentials('a@b.com', 'pw')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS for an inactive user', async () => {
      users.find.mockResolvedValueOnce([{ ...activeUser, is_active: false }]);
      await expect(service.validateCredentials('a@b.com', 'pw')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS on a wrong password', async () => {
      users.find.mockResolvedValueOnce([activeUser]);
      bcryptCompare.mockResolvedValueOnce(false);
      await expect(service.validateCredentials('a@b.com', 'pw')).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });
  });

  // ────────────────────────────────── refresh ───────────────────────────────
  describe('refresh', () => {
    const validPayload = { sub: 'user-1', tenantId: 'tenant-1', jti: 'jti-1', type: 'refresh' };

    /** The persisted row must hash-match the presented token. */
    const storedFor = (rawToken: string, overrides: Record<string, unknown> = {}) => {
      const { createHash } = require('crypto');
      const token_hash = createHash('sha256').update(rawToken).digest('hex');
      return {
        id: 'jti-1',
        token_hash,
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000),
        user: { id: 'user-1' },
        ...overrides,
      };
    };

    it('rotates the token: revokes the old row and issues a new pair', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      refreshTokens.findOne.mockResolvedValueOnce(storedFor('rt'));
      users.findOne.mockResolvedValueOnce(principalRow());

      const result = await service.refresh('rt');

      expect(refreshTokens.save).toHaveBeenCalledWith(
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
      expect(result.user).toEqual(expectedPrincipal);
    });

    it('throws INVALID_REFRESH_TOKEN when verification fails', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new Error('bad sig'));
      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
    });

    it('rejects a non-refresh token type', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ ...validPayload, type: 'access' });
      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
    });

    it('rejects an unknown jti without revoking anything', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      refreshTokens.findOne.mockResolvedValueOnce(null);

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('REVOKES THE WHOLE FAMILY when a revoked token is replayed (theft response)', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      refreshTokens.findOne.mockResolvedValueOnce(
        storedFor('rt', { revoked_at: new Date() }),
      );

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      // revokeAllForUser → refreshTokens.update for the whole user family
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ user: { id: 'user-1' } }),
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
    });

    it('revokes the family on a token-hash mismatch (forged token)', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      refreshTokens.findOne.mockResolvedValueOnce(
        storedFor('rt', { token_hash: 'different-hash' }),
      );

      await expect(service.refresh('rt')).rejects.toBeInstanceOf(AppError);
      expect(refreshTokens.update).toHaveBeenCalled();
    });

    it('rejects an expired refresh token', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      refreshTokens.findOne.mockResolvedValueOnce(
        storedFor('rt', { expires_at: new Date(Date.now() - 1000) }),
      );

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      expect(refreshTokens.update).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────── logout ────────────────────────────────
  describe('logout', () => {
    it('revokes the presented refresh token', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ jti: 'jti-1', type: 'refresh' });
      await service.logout('rt');
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'jti-1' }),
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
    });

    it('is a no-op for an invalid token (never throws)', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new Error('bad'));
      await expect(service.logout('rt')).resolves.toBeUndefined();
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllForUser', () => {
    it('revokes every active token for the user', async () => {
      await service.revokeAllForUser('user-7');
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ user: { id: 'user-7' } }),
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
    });
  });

  // ──────────────────────────────── forgotPassword ──────────────────────────
  describe('forgotPassword', () => {
    it('issues a reset token when the email exists', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });
      const result = await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(result.resetToken).toEqual(expect.any(String));
      expect(passwordResets.save).toHaveBeenCalledTimes(1);
    });

    it('returns the SAME shape (no token, no save) for an unknown email — anti-enumeration', async () => {
      users.findOne.mockResolvedValueOnce(null);
      const result = await service.forgotPassword({ email: 'ghost@b.com' } as any);
      expect(result).toEqual({});
      expect(passwordResets.save).not.toHaveBeenCalled();
    });

    it('tolerates a tenant-slug resolution failure and still does not leak', async () => {
      tenants.findOne.mockRejectedValueOnce(new Error('boom'));
      users.findOne.mockResolvedValueOnce(null);
      await expect(
        service.forgotPassword({ email: 'a@b.com', tenantSlug: 'x' } as any),
      ).resolves.toEqual({});
    });
  });

  // ──────────────────────────────── resetPassword ───────────────────────────
  describe('resetPassword', () => {
    const reset = () => ({
      id: 'reset-1',
      expires_at: new Date(Date.now() + 60_000),
      user: { id: 'user-1' },
    });

    it('sets the new password and revokes all sessions', async () => {
      passwordResets.findOne.mockResolvedValueOnce(reset());

      await service.resetPassword({ token: 'tok', newPassword: 'NewPass123!' } as any);

      expect(bcryptHash).toHaveBeenCalledWith('NewPass123!', 12);
      expect(dataSource.manager.update).toHaveBeenCalledTimes(2); // user + reset row
      expect(refreshTokens.update).toHaveBeenCalled(); // revoke all
    });

    it('rejects an unknown/used token', async () => {
      passwordResets.findOne.mockResolvedValueOnce(null);
      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_RESET_TOKEN });
    });

    it('rejects an expired token', async () => {
      passwordResets.findOne.mockResolvedValueOnce({
        ...reset(),
        expires_at: new Date(Date.now() - 1000),
      });
      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_RESET_TOKEN });
    });

    it('rejects a reset row with no linked user', async () => {
      passwordResets.findOne.mockResolvedValueOnce({ ...reset(), user: null });
      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_RESET_TOKEN });
    });
  });

  // ──────────────────────────────── changePassword ──────────────────────────
  describe('changePassword', () => {
    it('re-verifies, updates the hash and revokes all sessions', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1', password_hash: 'old' });
      bcryptCompare.mockResolvedValueOnce(true);

      await service.changePassword('user-1', {
        currentPassword: 'old',
        newPassword: 'NewPass123!',
      } as any);

      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({ password_hash: 'hashed-password' }),
      );
      expect(refreshTokens.update).toHaveBeenCalled();
    });

    it('rejects when the user is missing', async () => {
      users.findOne.mockResolvedValueOnce(null);
      await expect(
        service.changePassword('user-1', { currentPassword: 'x', newPassword: 'y' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
    });

    it('rejects when the current password is wrong', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1', password_hash: 'old' });
      bcryptCompare.mockResolvedValueOnce(false);
      await expect(
        service.changePassword('user-1', { currentPassword: 'bad', newPassword: 'y' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
      expect(users.save).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────── buildAuthenticatedUser ──────────────────────
  describe('buildAuthenticatedUser', () => {
    it('flattens roles + permissions and de-duplicates', async () => {
      users.findOne.mockResolvedValueOnce(principalRow());
      await expect(service.buildAuthenticatedUser('user-1')).resolves.toEqual(expectedPrincipal);
    });

    it('maps a null tenant (super-admin) correctly', async () => {
      users.findOne.mockResolvedValueOnce({
        id: 'sa-1',
        email: 'root@platform',
        is_active: true,
        tenant: null,
        userRoles: [{ role: { slug: 'super_admin', rolePermissions: [] } }],
      });
      const principal = await service.buildAuthenticatedUser('sa-1');
      expect(principal.tenantId).toBeNull();
      expect(principal.roles).toEqual(['super_admin']);
    });

    it('throws USER_INACTIVE when the user is missing', async () => {
      users.findOne.mockResolvedValueOnce(null);
      await expect(service.buildAuthenticatedUser('nope')).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
    });

    it('throws USER_INACTIVE when the user is deactivated', async () => {
      users.findOne.mockResolvedValueOnce({ ...principalRow(), is_active: false });
      await expect(service.buildAuthenticatedUser('user-1')).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
    });

    it('tolerates missing userRoles / null role / null permission rows', async () => {
      users.findOne.mockResolvedValueOnce({
        id: 'user-2',
        email: 'staff@clinic.com',
        is_active: true,
        tenant: { id: 'tenant-1' },
        userRoles: [
          { role: null }, // skipped (no role)
          {
            role: {
              slug: 'receptionist',
              rolePermissions: [
                { permission: null }, // skipped (no permission)
                { permission: { slug: 'customers.read' } },
              ],
            },
          },
        ],
      });

      const principal = await service.buildAuthenticatedUser('user-2');
      expect(principal.roles).toEqual(['receptionist']);
      expect(principal.permissions).toEqual(['customers.read']);
    });

    it('handles a user with an undefined userRoles relation', async () => {
      users.findOne.mockResolvedValueOnce({
        id: 'user-3',
        email: null,
        is_active: true,
        tenant: { id: 'tenant-1' },
        userRoles: undefined,
      });
      const principal = await service.buildAuthenticatedUser('user-3');
      expect(principal.roles).toEqual([]);
      expect(principal.permissions).toEqual([]);
    });
  });

  // ───────────────────────────── token TTL parsing ──────────────────────────
  // Exercises the private ttlToMs branches (unit default + no-match) via login,
  // which signs tokens through issueTokens using the configured TTL strings.
  describe('issueTokens TTL parsing', () => {
    const buildWithConfig = (overrides: Record<string, unknown>) =>
      new AuthService(
        users as any,
        refreshTokens as any,
        passwordResets as any,
        tenants as any,
        jwt as any,
        createMockConfigService(overrides) as any,
        dataSource as any,
        usage as any,
        platformSettings as any,
        email as any,
      );

    const primeLogin = () => {
      users.find.mockResolvedValueOnce([
        {
          id: 'user-1',
          password_hash: 'hashed-password',
          is_active: true,
          tenant: { id: 'tenant-1' },
        },
      ]); // validateCredentials
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser
      bcryptCompare.mockResolvedValueOnce(true);
    };

    it('parses a unit-less TTL ("900") as seconds', async () => {
      primeLogin();
      const svc = buildWithConfig({ JWT_ACCESS_TTL: '900', JWT_REFRESH_TTL: '7d' });
      const result = await svc.login({ email: 'a@b.com', password: 'pw' } as any);
      expect(result.expiresIn).toBe(900); // 900s → 900_000ms → /1000
    });

    it('treats an unparseable TTL as 0 (defensive no-match branch)', async () => {
      primeLogin();
      const svc = buildWithConfig({ JWT_ACCESS_TTL: 'not-a-duration', JWT_REFRESH_TTL: '7d' });
      const result = await svc.login({ email: 'a@b.com', password: 'pw' } as any);
      expect(result.expiresIn).toBe(0);
    });
  });
});
