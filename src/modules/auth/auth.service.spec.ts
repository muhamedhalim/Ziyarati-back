import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';

import { AuthService } from './auth.service';
import { LoginProtectionService } from './login-protection.service';
import { User } from '../../entities/Auth&RBAC/User';
import { RefreshToken } from '../../entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
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
  fullName: null,
  roles: ['owner'],
  permissions: ['appointments.read', 'appointments.create'],
};

describe('AuthService', () => {
  let service: AuthService;
  let users: MockRepository;
  let refreshTokens: MockRepository;
  let passwordResets: MockRepository;
  let tenants: MockRepository;
  let auditLogs: MockRepository;
  let dataSource: MockDataSource;
  let jwt: ReturnType<typeof createMockJwtService>;
  let usage: {
    assertCountWithinLimit: jest.Mock;
    assertUserSeatWithinLimit: jest.Mock;
  };
  let platformSettings: { getTyped: jest.Mock };
  let email: { sendWelcome: jest.Mock; sendPasswordReset: jest.Mock };
  let config: ReturnType<typeof createMockConfigService>;
  let loginProtection: {
    isLocked: jest.Mock;
    recordFailure: jest.Mock;
    clear: jest.Mock;
  };
  const bcryptHash = bcrypt.hash as unknown as jest.Mock;
  const bcryptCompare = bcrypt.compare as unknown as jest.Mock;

  beforeEach(async () => {
    users = createMockRepository();
    refreshTokens = createMockRepository();
    passwordResets = createMockRepository();
    tenants = createMockRepository();
    auditLogs = createMockRepository();
    dataSource = createMockDataSource();
    jwt = createMockJwtService();
    usage = {
      assertCountWithinLimit: jest.fn().mockResolvedValue(undefined),
      assertUserSeatWithinLimit: jest.fn().mockResolvedValue(undefined),
    };
    platformSettings = { getTyped: jest.fn().mockResolvedValue(true) };
    email = {
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    };

    bcryptHash.mockResolvedValue('hashed-password');
    bcryptCompare.mockResolvedValue(true);

    // JWT_ACCESS_SECRET/JWT_REFRESH_SECRET: required() in the real schema
    // (env.validation.ts), and every signing/verification path now uses
    // getOrThrow (ZT-007, no literal fallback) — every test in this file
    // needs both present by default, exactly as a correctly configured
    // deployment always has them.
    config = createMockConfigService({
      JWT_ACCESS_SECRET: 'test-access-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
    });
    // FND-008 — required so AuthService's widened constructor resolves in
    // every test in this file, not just the new login-protection cases
    // (research §R2h: a missing provider fails DI for the whole file).
    // Defaults to "not locked" / no-op so every pre-existing test is
    // unaffected until login() is actually wired to call these (T025).
    loginProtection = {
      isLocked: jest.fn().mockResolvedValue(false),
      recordFailure: jest.fn().mockResolvedValue(false),
      clear: jest.fn().mockResolvedValue(false),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        {
          provide: getRepositoryToken(PasswordReset),
          useValue: passwordResets,
        },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
        { provide: DataSource, useValue: dataSource },
        { provide: UsageService, useValue: usage },
        { provide: SystemSettingService, useValue: platformSettings },
        { provide: EmailService, useValue: email },
        { provide: LoginProtectionService, useValue: loginProtection },
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
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-owner',
        slug: 'owner',
      }); // owner role seeded
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser

      const result = await service.registerOwner(dto);

      expect(tenants.findOne).toHaveBeenCalledWith({
        where: { slug: 'al-noor' },
      });
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

    // M-08 / CAP-I18N — the locale the owner registered from is the ONLY
    // signal available at creation time (no stored preference exists yet);
    // it must be persisted on the new user AND used for the welcome email.
    it("persists dto.locale as the new user's preferred_locale and passes it to the welcome email", async () => {
      tenants.findOne.mockResolvedValueOnce(null);
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-owner',
        slug: 'owner',
      });
      users.findOne.mockResolvedValueOnce(principalRow());

      await service.registerOwner({ ...dto, locale: 'ar' });

      expect(dataSource.manager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ preferred_locale: 'ar' }),
      );
      expect(email.sendWelcome).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'ar' }),
      );
    });

    it('omits preferred_locale (leaves it NULL) when the request supplies no locale', async () => {
      tenants.findOne.mockResolvedValueOnce(null);
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-owner',
        slug: 'owner',
      });
      users.findOne.mockResolvedValueOnce(principalRow());

      await service.registerOwner(dto);

      expect(dataSource.manager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ preferred_locale: undefined }),
      );
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
      // D7 — the email-clash check now lives INSIDE createUserWithRole
      // (manager.findOne), AFTER role resolution, not as a pre-check on the
      // injected `users` repository.
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-rec',
        slug: ROLE.RECEPTIONIST,
      }); // resolveSystemRole
      dataSource.manager.findOne.mockResolvedValueOnce(null); // createUserWithRole: no email clash
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser

      const result = await service.createTenantUser(dto, 'tenant-1');

      // FND-007: the seat-cap check now runs atomically INSIDE the same
      // transaction as the insert (tenant-row lock — see
      // UsageService.assertUserSeatWithinLimit), not from a pre-fetched count.
      expect(usage.assertUserSeatWithinLimit).toHaveBeenCalledWith(
        'tenant-1',
        dataSource.manager,
      );
      expect(result).toEqual(expectedPrincipal);
    });

    it('accepts an explicit assignable role (manager)', async () => {
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-mgr',
        slug: ROLE.MANAGER,
      });
      dataSource.manager.findOne.mockResolvedValueOnce(null); // no email clash
      users.findOne.mockResolvedValueOnce(principalRow());

      await expect(
        service.createTenantUser(
          { ...dto, roleSlug: ROLE.MANAGER },
          'tenant-1',
        ),
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

    // D7 — the clash check is GLOBAL (any live user, any tenant, platform
    // included), not scoped to the caller's tenant; this is exercised
    // directly (with cross-tenant/cross-scope fixtures) in the
    // "createUserWithRole — D7 global email uniqueness" describe block below.
    // This test just proves createTenantUser surfaces that rejection.
    it('rejects a duplicate email (global chokepoint, surfaced through createTenantUser)', async () => {
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-rec',
        slug: ROLE.RECEPTIONIST,
      }); // resolveSystemRole
      dataSource.manager.findOne.mockResolvedValueOnce({ id: 'existing' }); // createUserWithRole: clash found

      await expect(
        service.createTenantUser(dto, 'tenant-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
    });

    // FND-007: the seat check runs INSIDE the transaction, FIRST — before
    // role resolution or the email-clash check — so a rejection there still
    // means nothing was created, but `dataSource.transaction` itself IS
    // invoked (and its callback fails immediately, before touching the role
    // or the email).
    it('propagates the plan user-limit failure from UsageService', async () => {
      usage.assertUserSeatWithinLimit.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'user limit reached',
        }),
      );

      await expect(
        service.createTenantUser(dto, 'tenant-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(dataSource.manager.findOne).not.toHaveBeenCalled(); // role resolution never reached
    });

    // ────────────────── createUserWithRole — D7 global email uniqueness ───────
  });

  describe('createUserWithRole — D7 global email uniqueness', () => {
    const roleRow = { id: 'role-1', slug: ROLE.RECEPTIONIST } as any;
    const input = {
      email: 'shared@example.com',
      password: 'StrongPass123!',
      fullName: 'Someone',
    };

    it('rejects when the email is already held by a user in a DIFFERENT tenant (D7 #accepted behaviour change)', async () => {
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'existing',
        tenant: { id: 'other-tenant' },
      });

      await expect(
        service.createUserWithRole(
          dataSource.manager as any,
          input,
          roleRow,
          'tenant-1',
        ),
      ).rejects.toMatchObject({ code: ErrorCode.EMAIL_ALREADY_EXISTS });
      expect(dataSource.manager.save).not.toHaveBeenCalled();
    });

    it('rejects when the email is already held by a PLATFORM user (tenantId null) — D7 #2', async () => {
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'existing-platform',
        tenant: null,
      });

      await expect(
        service.createUserWithRole(
          dataSource.manager as any,
          input,
          roleRow,
          'tenant-1',
        ),
      ).rejects.toMatchObject({ code: ErrorCode.EMAIL_ALREADY_EXISTS });
    });

    it('creates a PLATFORM user (tenantId null) with tenant left undefined, when tenantId is null', async () => {
      dataSource.manager.findOne.mockResolvedValueOnce(null); // no clash
      dataSource.manager.create.mockImplementation(
        (_entity: any, data: any) => data,
      );
      dataSource.manager.save.mockImplementation(async (entity: any) => ({
        id: 'new-user',
        ...entity,
      }));

      await service.createUserWithRole(
        dataSource.manager as any,
        input,
        roleRow,
        null,
      );

      const userCreateCall = dataSource.manager.create.mock.calls.find(
        ([, data]: any[]) => data?.email === input.email,
      );
      expect(userCreateCall?.[1].tenant).toBeUndefined();
    });

    it('D7 #3 — translates a raced-past unique violation into EMAIL_ALREADY_EXISTS, not a raw 500', async () => {
      const { QueryFailedError } = require('typeorm');
      dataSource.manager.findOne.mockResolvedValueOnce(null); // pre-check passes...
      dataSource.manager.create.mockImplementation(
        (_entity: any, data: any) => data,
      );
      // ...but the insert itself loses the race to a concurrent identical create.
      const raceError = Object.assign(
        new QueryFailedError('q', [], new Error('dup')),
        {
          code: '23505',
          constraint: 'uq_user_email_global',
        },
      );
      dataSource.manager.save.mockRejectedValueOnce(raceError);

      await expect(
        service.createUserWithRole(
          dataSource.manager as any,
          input,
          roleRow,
          'tenant-1',
        ),
      ).rejects.toMatchObject({ code: ErrorCode.EMAIL_ALREADY_EXISTS });
    });

    it('re-throws a non-unique-violation save failure unchanged', async () => {
      dataSource.manager.findOne.mockResolvedValueOnce(null);
      dataSource.manager.create.mockImplementation(
        (_entity: any, data: any) => data,
      );
      const otherError = new Error('connection reset');
      dataSource.manager.save.mockRejectedValueOnce(otherError);

      await expect(
        service.createUserWithRole(
          dataSource.manager as any,
          input,
          roleRow,
          'tenant-1',
        ),
      ).rejects.toBe(otherError);
    });
  });

  // ────────────────────────────────── login ─────────────────────────────────
  describe('login', () => {
    const credUser = {
      id: 'user-1',
      password_hash: 'hashed-password',
      is_active: true,
      tenant: { id: 'tenant-1' },
    };

    it('verifies credentials, stamps last_login_at and returns tokens', async () => {
      users.find.mockResolvedValueOnce([credUser]); // validateCredentials
      users.findOne.mockResolvedValueOnce(principalRow()); // buildAuthenticatedUser
      bcryptCompare.mockResolvedValueOnce(true);

      const result = await service.login({
        email: 'owner@clinic.com',
        password: 'pw',
      } as any);

      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({ last_login_at: expect.any(Date) }),
      );
      expect(result.user).toEqual(expectedPrincipal);
    });

    // ─────────────────── FND-008: account-aware protection ───────────────────
    // login() must NOT yet be wired to call LoginProtectionService — that is
    // Track B's real implementation (T025). These assertions are the red-phase
    // pin: they fail until login() actually consults isLocked/recordFailure/clear.

    it('checks login protection BEFORE validating credentials', async () => {
      users.find.mockResolvedValueOnce([credUser]);
      users.findOne.mockResolvedValueOnce(principalRow());
      bcryptCompare.mockResolvedValueOnce(true);

      await service.login({
        email: 'OWNER@Clinic.com ',
        password: 'pw',
      } as any);

      // The identity passed to the protection layer must be normalised
      // (trim + lower-case) the SAME way validateCredentials normalises it.
      expect(loginProtection.isLocked).toHaveBeenCalledWith('owner@clinic.com');
      const isLockedOrder =
        loginProtection.isLocked.mock.invocationCallOrder[0];
      const findOrder = users.find.mock.invocationCallOrder[0];
      expect(isLockedOrder).toBeLessThan(findOrder);
    });

    it('refuses with RATE_LIMITED when protection is engaged, WITHOUT reaching credential validation', async () => {
      loginProtection.isLocked.mockResolvedValueOnce(true);

      await expect(
        service.login({ email: 'attacker@clinic.com', password: 'pw' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
      expect(users.find).not.toHaveBeenCalled();
    });

    it('the RATE_LIMITED refusal is identical for an unknown and a known account — no enumeration oracle', async () => {
      loginProtection.isLocked.mockResolvedValueOnce(true);
      const unknownErr = await service
        .login({ email: 'ghost-account@clinic.com', password: 'pw' } as any)
        .catch((e) => e);

      loginProtection.isLocked.mockResolvedValueOnce(true);
      const knownErr = await service
        .login({ email: 'owner@clinic.com', password: 'pw' } as any)
        .catch((e) => e);

      expect(unknownErr.code).toEqual(knownErr.code);
      expect(unknownErr.message).toEqual(knownErr.message);
    });

    it('records a failure when credentials are invalid', async () => {
      users.find.mockResolvedValueOnce([]); // no such user -> INVALID_CREDENTIALS

      await expect(
        service.login({ email: 'nope@clinic.com', password: 'pw' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
      expect(loginProtection.recordFailure).toHaveBeenCalledWith(
        'nope@clinic.com',
      );
    });

    it('records a failure on a wrong password too', async () => {
      users.find.mockResolvedValueOnce([credUser]);
      bcryptCompare.mockResolvedValueOnce(false);

      await expect(
        service.login({ email: 'owner@clinic.com', password: 'wrong' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
      expect(loginProtection.recordFailure).toHaveBeenCalledWith(
        'owner@clinic.com',
      );
    });

    it('clears protection state on a successful login', async () => {
      users.find.mockResolvedValueOnce([credUser]);
      users.findOne.mockResolvedValueOnce(principalRow());
      bcryptCompare.mockResolvedValueOnce(true);

      await service.login({ email: 'owner@clinic.com', password: 'pw' } as any);

      expect(loginProtection.clear).toHaveBeenCalledWith('owner@clinic.com');
    });

    // ─────────────────────── FND-008: safe audit records ──────────────────────
    it('writes a safe audit record ONLY when this failure actually engages protection', async () => {
      loginProtection.recordFailure.mockResolvedValueOnce(true); // the threshold-crossing call
      users.find.mockResolvedValueOnce([]); // unknown user -> INVALID_CREDENTIALS

      await service
        .login({ email: 'attacker@clinic.com', password: 'pw' } as any)
        .catch(() => undefined);

      expect(auditLogs.save).toHaveBeenCalledTimes(1);
      const saved = JSON.stringify(auditLogs.save.mock.calls[0][0]);
      expect(saved).toContain('auth.login.protection_engaged');
      expect(saved).not.toContain('attacker@clinic.com'); // raw email never in the row
      expect(saved).not.toMatch(/password|pw"/i);
    });

    it('does NOT write an audit record on an ordinary failed attempt below the threshold', async () => {
      loginProtection.recordFailure.mockResolvedValueOnce(false); // not yet engaged
      users.find.mockResolvedValueOnce([]);

      await service
        .login({ email: 'someone@clinic.com', password: 'pw' } as any)
        .catch(() => undefined);

      expect(auditLogs.save).not.toHaveBeenCalled();
    });

    it('writes a safe audit record when a successful login clears an ACTIVE protection state', async () => {
      loginProtection.clear.mockResolvedValueOnce(true); // there was something to clear
      users.find.mockResolvedValueOnce([credUser]);
      users.findOne.mockResolvedValueOnce(principalRow());
      bcryptCompare.mockResolvedValueOnce(true);

      await service.login({ email: 'owner@clinic.com', password: 'pw' } as any);

      expect(auditLogs.save).toHaveBeenCalledTimes(1);
      const saved = JSON.stringify(auditLogs.save.mock.calls[0][0]);
      expect(saved).toContain('auth.login.protection_cleared');
      expect(saved).not.toContain('owner@clinic.com');
    });

    it('does NOT write an audit record on an ordinary successful login with no prior failures', async () => {
      loginProtection.clear.mockResolvedValueOnce(false); // nothing to clear
      users.find.mockResolvedValueOnce([credUser]);
      users.findOne.mockResolvedValueOnce(principalRow());
      bcryptCompare.mockResolvedValueOnce(true);

      await service.login({ email: 'owner@clinic.com', password: 'pw' } as any);

      expect(auditLogs.save).not.toHaveBeenCalled();
    });

    it('varying tenantSlug does NOT change the protection identity — cannot bypass by switching slugs', async () => {
      loginProtection.isLocked.mockResolvedValueOnce(true);
      await service
        .login({
          email: 'owner@clinic.com',
          password: 'pw',
          tenantSlug: 'clinic-a',
        } as any)
        .catch(() => undefined);

      loginProtection.isLocked.mockResolvedValueOnce(true);
      await service
        .login({
          email: 'owner@clinic.com',
          password: 'pw',
          tenantSlug: 'clinic-b',
        } as any)
        .catch(() => undefined);

      expect(loginProtection.isLocked).toHaveBeenCalledTimes(2);
      const [firstCallIdentity] = loginProtection.isLocked.mock.calls[0] ?? [];
      const [secondCallIdentity] = loginProtection.isLocked.mock.calls[1] ?? [];
      expect(firstCallIdentity).toEqual(secondCallIdentity);
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

      await expect(service.validateCredentials('a@b.com', 'pw')).resolves.toBe(
        activeUser,
      );
    });

    it('resolves a tenant owner by email WITHOUT a tenantSlug (unified login form)', async () => {
      // Regression: the web login form sends only email + password. A
      // tenant-scoped owner must resolve without a slug — previously this
      // matched `tenant IS NULL` and always failed.
      const owner = { ...activeUser, tenant: { id: 'tenant-1' } };
      users.find.mockResolvedValueOnce([owner]);
      bcryptCompare.mockResolvedValueOnce(true);

      await expect(
        service.validateCredentials('OWNER@Clinic.com ', 'pw'),
      ).resolves.toBe(owner);
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

      expect(tenants.findOne).toHaveBeenCalledWith({
        where: { slug: 'clinic-slug' },
      });
      expect(users.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'a@b.com', tenant: { id: 'tenant-9' } },
        }),
      );
    });

    it('throws INVALID_CREDENTIALS for an unknown tenant slug (no enumeration leak)', async () => {
      tenants.findOne.mockResolvedValueOnce(null);

      await expect(
        service.validateCredentials('a@b.com', 'pw', 'nope'),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS when the user does not exist', async () => {
      users.find.mockResolvedValueOnce([]);
      await expect(
        service.validateCredentials('a@b.com', 'pw'),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS when the user has no password hash', async () => {
      users.find.mockResolvedValueOnce([
        { ...activeUser, password_hash: null },
      ]);
      await expect(
        service.validateCredentials('a@b.com', 'pw'),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS for an inactive user', async () => {
      users.find.mockResolvedValueOnce([{ ...activeUser, is_active: false }]);
      await expect(
        service.validateCredentials('a@b.com', 'pw'),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });

    it('throws INVALID_CREDENTIALS on a wrong password', async () => {
      users.find.mockResolvedValueOnce([activeUser]);
      bcryptCompare.mockResolvedValueOnce(false);
      await expect(
        service.validateCredentials('a@b.com', 'pw'),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_CREDENTIALS,
      });
    });
  });

  // ────────────────────────────────── refresh ───────────────────────────────
  describe('refresh', () => {
    const validPayload = {
      sub: 'user-1',
      tenantId: 'tenant-1',
      jti: 'jti-1',
      type: 'refresh',
    };

    /** The persisted row must hash-match the presented token. */
    const storedFor = (
      rawToken: string,
      overrides: Record<string, unknown> = {},
    ) => {
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
      jwt.verifyAsync.mockResolvedValueOnce({
        ...validPayload,
        type: 'access',
      });
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
  // FND-006: the reset token must NEVER appear in the response, in ANY
  // environment. This block intentionally INVERTS the pre-fix assertion
  // that used to require `result.resetToken` to be a string — that was the
  // vulnerability itself, encoded as a passing test (Feature 003, TR-003).
  describe('forgotPassword', () => {
    it('never includes a reset credential in the response when the email exists', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });
      const result = await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(result).not.toHaveProperty('resetToken');
      expect((result as Record<string, unknown>).token).toBeUndefined();
      expect(result).toEqual({ message: expect.any(String) });
      expect(passwordResets.save).toHaveBeenCalledTimes(1);
    });

    it.each(['production', 'development', 'test', undefined])(
      'never includes a reset credential regardless of NODE_ENV (%s)',
      async (envValue) => {
        (config.get as jest.Mock).mockImplementation(
          (key: string, def?: unknown) => (key === 'NODE_ENV' ? envValue : def),
        );
        users.findOne.mockResolvedValueOnce({ id: 'user-1' });
        const result = await service.forgotPassword({
          email: 'a@b.com',
        } as any);
        expect(result).not.toHaveProperty('resetToken');
        expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/); // no raw 32-byte hex token anywhere in the body
      },
    );

    it('returns a response identical to the known-email case for an unknown email — anti-enumeration', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });
      const knownResult = await service.forgotPassword({
        email: 'a@b.com',
      } as any);

      users.findOne.mockResolvedValueOnce(null);
      const unknownResult = await service.forgotPassword({
        email: 'ghost@b.com',
      } as any);

      expect(unknownResult).toEqual(knownResult);
      expect(passwordResets.save).toHaveBeenCalledTimes(1); // only for the known-email case
    });

    it('tolerates a tenant-slug resolution failure and still does not leak', async () => {
      tenants.findOne.mockRejectedValueOnce(new Error('boom'));
      users.findOne.mockResolvedValueOnce(null);
      await expect(
        service.forgotPassword({ email: 'a@b.com', tenantSlug: 'x' } as any),
      ).resolves.toEqual({ message: expect.any(String) });
    });

    it('still dispatches the reset email and persists the token hash', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });
      await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(passwordResets.save).toHaveBeenCalledTimes(1);
      expect(email.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    // FR-H014/T156 gap-closure: the user row is already loaded here, so its
    // recorded locale (M-08) must reach the email — a free, no-risk win.
    it("[T156] forwards the user's preferred_locale to the reset email", async () => {
      users.findOne.mockResolvedValueOnce({
        id: 'user-1',
        preferred_locale: 'ar',
      });
      await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(email.sendPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'ar' }),
      );
    });

    it('[T156] leaves locale undefined (not a guess) when the user never set one', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });
      await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(email.sendPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({ locale: undefined }),
      );
    });

    // ─────────────── FND-006: no credential may enter any log ───────────────
    it('with AUTH_EXPOSE_RESET_TOKEN off (the default), no log line contains the token', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      (config.get as jest.Mock).mockImplementation(
        (key: string, def?: unknown) => {
          if (key === 'AUTH_EXPOSE_RESET_TOKEN') return 'false';
          if (key === 'NODE_ENV') return 'development';
          return def;
        },
      );
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });

      await service.forgotPassword({ email: 'a@b.com' } as any);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('with AUTH_EXPOSE_RESET_TOKEN on in production, no log line contains the token — production never reaches this branch', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      (config.get as jest.Mock).mockImplementation(
        (key: string, def?: unknown) => {
          if (key === 'AUTH_EXPOSE_RESET_TOKEN') return 'true';
          if (key === 'NODE_ENV') return 'production';
          return def;
        },
      );
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });

      await service.forgotPassword({ email: 'a@b.com' } as any);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('with the flag explicitly on AND a non-production environment, the token is logged via the gated dev channel ONLY (never returned)', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      (config.get as jest.Mock).mockImplementation(
        (key: string, def?: unknown) => {
          if (key === 'AUTH_EXPOSE_RESET_TOKEN') return 'true';
          if (key === 'NODE_ENV') return 'development';
          return def;
        },
      );
      users.findOne.mockResolvedValueOnce({ id: 'user-1' });

      const result = await service.forgotPassword({ email: 'a@b.com' } as any);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/[0-9a-f]{64}/); // the token IS in the log here
      expect(result).not.toHaveProperty('resetToken'); // but NEVER in the response, even here
      warnSpy.mockRestore();
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

      await service.resetPassword({
        token: 'tok',
        newPassword: 'NewPass123!',
      } as any);

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
      users.findOne.mockResolvedValueOnce({
        id: 'user-1',
        password_hash: 'old',
      });
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
        service.changePassword('user-1', {
          currentPassword: 'x',
          newPassword: 'y',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
    });

    it('rejects when the current password is wrong', async () => {
      users.findOne.mockResolvedValueOnce({
        id: 'user-1',
        password_hash: 'old',
      });
      bcryptCompare.mockResolvedValueOnce(false);
      await expect(
        service.changePassword('user-1', {
          currentPassword: 'bad',
          newPassword: 'y',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
      expect(users.save).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────── buildAuthenticatedUser ──────────────────────
  describe('buildAuthenticatedUser', () => {
    it('flattens roles + permissions and de-duplicates', async () => {
      users.findOne.mockResolvedValueOnce(principalRow());
      await expect(service.buildAuthenticatedUser('user-1')).resolves.toEqual(
        expectedPrincipal,
      );
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
      await expect(
        service.buildAuthenticatedUser('nope'),
      ).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
    });

    it('throws USER_INACTIVE when the user is deactivated', async () => {
      users.findOne.mockResolvedValueOnce({
        ...principalRow(),
        is_active: false,
      });
      await expect(
        service.buildAuthenticatedUser('user-1'),
      ).rejects.toMatchObject({
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

  // ─────────────────── buildAuthenticatedUserWithTenant (PERF-BE-003) ───────────────
  describe('buildAuthenticatedUserWithTenant', () => {
    it('returns the same principal as buildAuthenticatedUser, plus the loaded Tenant row', async () => {
      const row = principalRow();
      users.findOne.mockResolvedValueOnce(row);
      const { principal, tenant } =
        await service.buildAuthenticatedUserWithTenant('user-1');
      expect(principal).toEqual(expectedPrincipal);
      expect(tenant).toBe(row.tenant);
      // The tenant is never merged into the principal — guards against a future
      // regression that would leak it through GET /auth/me.
      expect((principal as any).tenant).toBeUndefined();
    });

    it('returns tenant: null for a super-admin / no-tenant user', async () => {
      users.findOne.mockResolvedValueOnce({
        id: 'sa-1',
        email: 'root@platform',
        is_active: true,
        tenant: null,
        userRoles: [{ role: { slug: 'super_admin', rolePermissions: [] } }],
      });
      const { principal, tenant } =
        await service.buildAuthenticatedUserWithTenant('sa-1');
      expect(principal.tenantId).toBeNull();
      expect(tenant).toBeNull();
    });

    it('throws USER_INACTIVE when the user is deactivated, same as buildAuthenticatedUser', async () => {
      users.findOne.mockResolvedValueOnce({
        ...principalRow(),
        is_active: false,
      });
      await expect(
        service.buildAuthenticatedUserWithTenant('user-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
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
        auditLogs as any,
        jwt as any,
        createMockConfigService({
          JWT_ACCESS_SECRET: 'test-access-secret',
          JWT_REFRESH_SECRET: 'test-refresh-secret',
          ...overrides,
        }) as any,
        dataSource as any,
        usage as any,
        platformSettings as any,
        email as any,
        {
          isLocked: jest.fn().mockResolvedValue(false),
          recordFailure: jest.fn().mockResolvedValue(false),
          clear: jest.fn().mockResolvedValue(false),
        } as any,
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
      const svc = buildWithConfig({
        JWT_ACCESS_TTL: '900',
        JWT_REFRESH_TTL: '7d',
      });
      const result = await svc.login({
        email: 'a@b.com',
        password: 'pw',
      } as any);
      expect(result.expiresIn).toBe(900); // 900s → 900_000ms → /1000
    });

    it('treats an unparseable TTL as 0 (defensive no-match branch)', async () => {
      primeLogin();
      const svc = buildWithConfig({
        JWT_ACCESS_TTL: 'not-a-duration',
        JWT_REFRESH_TTL: '7d',
      });
      const result = await svc.login({
        email: 'a@b.com',
        password: 'pw',
      } as any);
      expect(result.expiresIn).toBe(0);
    });
  });

  // ZT-007: every JWT secret-consuming path in this file uses getOrThrow —
  // no path may fall back to a public literal when its variable is absent.
  describe('fails loudly when a JWT secret is unset (ZT-007)', () => {
    const buildWithoutSecret = (
      omit: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET',
    ) => {
      const overrides: Record<string, unknown> = {
        JWT_ACCESS_SECRET: 'test-access-secret',
        JWT_REFRESH_SECRET: 'test-refresh-secret',
      };
      delete overrides[omit];
      return new AuthService(
        users as any,
        refreshTokens as any,
        passwordResets as any,
        tenants as any,
        auditLogs as any,
        jwt as any,
        createMockConfigService(overrides) as any,
        dataSource as any,
        usage as any,
        platformSettings as any,
        email as any,
        loginProtection as any,
      );
    };

    const primeLoginForSecretTest = () => {
      users.find.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'a@b.com',
          password_hash: 'hashed-password',
          is_active: true,
          tenant: { id: 'tenant-1' },
        },
      ]);
      users.findOne.mockResolvedValueOnce(principalRow());
      bcryptCompare.mockResolvedValueOnce(true);
    };

    it('signing raises when JWT_ACCESS_SECRET is unset (login → issueTokens)', async () => {
      primeLoginForSecretTest();
      const svc = buildWithoutSecret('JWT_ACCESS_SECRET');
      await expect(
        svc.login({ email: 'a@b.com', password: 'pw' } as any),
      ).rejects.toThrow(/JWT_ACCESS_SECRET/);
    });

    it('signing raises when JWT_REFRESH_SECRET is unset (login → issueTokens)', async () => {
      primeLoginForSecretTest();
      const svc = buildWithoutSecret('JWT_REFRESH_SECRET');
      await expect(
        svc.login({ email: 'a@b.com', password: 'pw' } as any),
      ).rejects.toThrow(/JWT_REFRESH_SECRET/);
    });

    it('refresh-token verification raises when JWT_REFRESH_SECRET is unset', async () => {
      const svc = buildWithoutSecret('JWT_REFRESH_SECRET');
      await expect(svc.refresh('some.refresh.token')).rejects.toThrow(
        /JWT_REFRESH_SECRET/,
      );
    });

    it('logout verification raises when JWT_REFRESH_SECRET is unset (fails loudly, not a silent no-op)', async () => {
      const svc = buildWithoutSecret('JWT_REFRESH_SECRET');
      await expect(svc.logout('some.refresh.token')).rejects.toThrow(
        /JWT_REFRESH_SECRET/,
      );
    });
  });
});
