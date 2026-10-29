import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import * as bcrypt from 'bcrypt';

import { AuthService } from './auth.service';
import { LoginProtectionService } from './login-protection.service';
import { FixedWindowLimiterService } from '../../queue/fixed-window-limiter.service';
import { MetricsService } from '../../metrics/metrics.service';
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
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
} from '../../../test/utils/mock-factories';

// bcrypt is mocked module-wide: unit tests must never run real 12-round hashing.
jest.mock('bcrypt');

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

/**
 * P5-1 (015-db-api-efficiency-audit, AUTH-001): `loadPrincipal` no longer
 * does `users.findOne({ relations })` — it issues one `createQueryBuilder`
 * read and folds the flat (role, permission) rows itself. This converts the
 * same nested "row as loaded with relations" fixture shape the tests already
 * used (`principalRow()` and its variants) into the flat raw-row array that
 * query now produces, so every existing fixture keeps expressing "what the
 * database holds" rather than "which TypeORM API loaded it".
 *
 * Mirrors `AuthService.loadPrincipal`'s fold exactly: one row per
 * (role, permission) pair; a role with no permissions still contributes one
 * row (permissionSlug: null); a user with no roles at all still contributes
 * one row (LEFT JOIN — the row never disappears, only the joined columns go
 * null), which is why `rows.length === 0` means "no such user", not "no
 * roles".
 */
function toRawPrincipalRows(row: any): any[] {
  if (!row) return [];
  const t = row.tenant ?? null;
  const base = {
    userId: row.id,
    userIsActive: row.is_active,
    userEmail: row.email ?? null,
    userFullName: row.full_name ?? null,
    tenantId: t?.id ?? null,
    tenantName: t?.name ?? null,
    tenantSlug: t?.slug ?? null,
    tenantLogoUrl: t?.logo_url ?? null,
    tenantCommercialRegistrationNumber:
      t?.commercial_registration_number ?? null,
    tenantLegalName: t?.legal_name ?? null,
    tenantContactEmail: t?.contact_email ?? null,
    tenantContactPhone: t?.contact_phone ?? null,
    tenantCountryId: t?.country_id ?? null,
    tenantDefaultCurrency: t?.default_currency ?? null,
    tenantDefaultTimezone: t?.default_timezone ?? null,
    tenantApprovalStatus: t?.approval_status ?? null,
    tenantIsActive: t?.is_active ?? null,
    tenantCreatedAt: t?.created_at ?? null,
    tenantUpdatedAt: t?.updated_at ?? null,
    tenantDeletedAt: t?.deleted_at ?? null,
  };

  const userRoles = row.userRoles ?? [];
  const pairs: Array<{
    roleSlug: string | null;
    permissionSlug: string | null;
  }> = [];
  if (userRoles.length === 0) {
    pairs.push({ roleSlug: null, permissionSlug: null });
  } else {
    for (const ur of userRoles) {
      if (!ur.role) {
        pairs.push({ roleSlug: null, permissionSlug: null });
        continue;
      }
      const rps = ur.role.rolePermissions ?? [];
      if (rps.length === 0) {
        pairs.push({ roleSlug: ur.role.slug, permissionSlug: null });
      } else {
        for (const rp of rps) {
          pairs.push({
            roleSlug: ur.role.slug,
            permissionSlug: rp.permission?.slug ?? null,
          });
        }
      }
    }
  }
  return pairs.map((p) => ({ ...base, ...p }));
}

/**
 * Wires `users.createQueryBuilder()` to return `toRawPrincipalRows(row)` for
 * exactly the next call — the raw-row equivalent of the old
 * `users.findOne.mockResolvedValueOnce(row)`. Returns the query-builder mock
 * so a test can additionally assert on `leftJoin`/`where`/`getRawMany` calls.
 */
function mockPrincipal(users: MockRepository, row: any) {
  const qb = createMockQueryBuilder();
  qb.getRawMany = jest.fn(async () => toRawPrincipalRows(row));
  users.createQueryBuilder.mockReturnValueOnce(qb);
  return qb;
}

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
  // 009-auth-abuse-resistance — required so AuthService's widened
  // constructor resolves in every test in this file, same reasoning as
  // loginProtection above. Defaults to an always-allowed, healthy-mode
  // decision so every pre-existing test's downstream behaviour (lookups,
  // writes, dispatch) is unaffected; individual limiter-specific tests
  // override `consume`/`peek` per case.
  let limiter: { consume: jest.Mock; peek: jest.Mock };
  let metrics: {
    recordAuthAbuseLimiterEvent: jest.Mock;
    recordAuthRecoveryEvent: jest.Mock;
    recordRefreshRotationEvent: jest.Mock;
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
    limiter = {
      consume: jest
        .fn()
        .mockResolvedValue({ allowed: true, degraded: false, count: 1 }),
      peek: jest
        .fn()
        .mockResolvedValue({ allowed: true, degraded: false, count: 0 }),
    };
    metrics = {
      recordAuthAbuseLimiterEvent: jest.fn(),
      recordAuthRecoveryEvent: jest.fn(),
      // AUTH-002 — reuse detection and the bounded retry window are now
      // observable; pre-fix a detected replay emitted nothing at all.
      recordRefreshRotationEvent: jest.fn(),
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
        { provide: FixedWindowLimiterService, useValue: limiter },
        { provide: MetricsService, useValue: metrics },
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

    // RL-07: opt-in per-client layer, consulted before the endpoint ceiling.
    it('skips the per-client layer when AUTH_REGISTER_OWNER_MAX_PER_CLIENT is unset', async () => {
      limiter.consume.mockResolvedValueOnce({ allowed: true, count: 1 });
      limiter.consume.mockResolvedValueOnce({ allowed: false, count: 1001 });
      await expect(
        service.registerOwner(dto, { ipAddress: '198.51.100.7' }),
      ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
      const scopes = limiter.consume.mock.calls.map((c) => c[0]);
      expect(scopes).toEqual(['register_identity', 'register_endpoint']);
    });

    it('refuses at the per-client layer without touching the endpoint ceiling', async () => {
      config.get.mockImplementation((key: string, def?: unknown) =>
        key === 'AUTH_REGISTER_OWNER_MAX_PER_CLIENT' ? 5 : def,
      );
      limiter.consume.mockResolvedValueOnce({ allowed: true, count: 1 });
      limiter.consume.mockResolvedValueOnce({ allowed: false, count: 6 });
      await expect(
        service.registerOwner(dto, { ipAddress: '198.51.100.7' }),
      ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
      const calls = limiter.consume.mock.calls;
      expect(calls.map((c) => c[0])).toEqual([
        'register_identity',
        'register_client',
      ]);
      expect(calls[1][1]).not.toContain('198.51.100.7'); // digested, never raw
      expect(calls[1][2]).toBe(5);
    });

    it('creates tenant + owner atomically and returns tokens + principal (success path)', async () => {
      tenants.findOne.mockResolvedValueOnce(null); // slug free
      dataSource.manager.findOne.mockResolvedValueOnce({
        id: 'role-owner',
        slug: 'owner',
      }); // owner role seeded
      mockPrincipal(users, principalRow()); // buildAuthenticatedUser

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
      mockPrincipal(users, principalRow());

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
      mockPrincipal(users, principalRow());

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
      mockPrincipal(users, principalRow()); // buildAuthenticatedUser

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

    it("rejects manager — retired from this endpoint's assignable-role allow-list", async () => {
      await expect(
        service.createTenantUser(
          { ...dto, roleSlug: ROLE.MANAGER },
          'tenant-1',
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
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
      mockPrincipal(users, principalRow()); // buildAuthenticatedUser
      bcryptCompare.mockResolvedValueOnce(true);

      const result = await service.login({
        email: 'owner@clinic.com',
        password: 'pw',
      } as any);

      // P1.2 — a targeted UPDATE of last_login_at, not a full-entity save
      // (which would re-write the password_hash validateCredentials just
      // SELECTed, for no reason).
      expect(users.update).toHaveBeenCalledWith(
        { id: credUser.id },
        { last_login_at: expect.any(Date) },
      );
      expect(users.save).not.toHaveBeenCalled();
      expect(result.user).toEqual(expectedPrincipal);
    });

    // ─────────────────── FND-008: account-aware protection ───────────────────
    // login() must NOT yet be wired to call LoginProtectionService — that is
    // Track B's real implementation (T025). These assertions are the red-phase
    // pin: they fail until login() actually consults isLocked/recordFailure/clear.

    it('checks login protection BEFORE validating credentials', async () => {
      users.find.mockResolvedValueOnce([credUser]);
      mockPrincipal(users, principalRow());
      bcryptCompare.mockResolvedValueOnce(true);

      await service.login({
        email: 'OWNER@Clinic.com ',
        password: 'pw',
      } as any);

      // The identity passed to the protection layer must be normalised
      // (trim + lower-case) the SAME way validateCredentials normalises it.
      expect(loginProtection.isLocked).toHaveBeenCalledWith(
        'owner@clinic.com',
        undefined,
      );
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
        undefined,
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
        undefined,
      );
    });

    it('clears protection state on a successful login', async () => {
      users.find.mockResolvedValueOnce([credUser]);
      mockPrincipal(users, principalRow());
      bcryptCompare.mockResolvedValueOnce(true);

      await service.login({ email: 'owner@clinic.com', password: 'pw' } as any);

      expect(loginProtection.clear).toHaveBeenCalledWith(
        'owner@clinic.com',
        undefined,
      );
    });

    // RL-05: the request's resolved address reaches every protection call.
    it('passes the client address to the lockout check, failure and clear', async () => {
      users.find.mockResolvedValueOnce([credUser]);
      bcryptCompare.mockResolvedValueOnce(false);
      await expect(
        service.login({ email: 'owner@clinic.com', password: 'wrong' } as any, {
          ipAddress: '203.0.113.7',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
      expect(loginProtection.isLocked).toHaveBeenCalledWith(
        'owner@clinic.com',
        '203.0.113.7',
      );
      expect(loginProtection.recordFailure).toHaveBeenCalledWith(
        'owner@clinic.com',
        '203.0.113.7',
      );
    });

    // RL-16: an unknown email pays the same bcrypt cost as a wrong password.
    it('runs one bcrypt compare even when no account matches', async () => {
      users.find.mockResolvedValueOnce([]);
      bcryptCompare.mockClear();
      await expect(
        service.login({ email: 'ghost@clinic.com', password: 'pw' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
      expect(bcryptCompare).toHaveBeenCalledTimes(1);
      expect(bcryptCompare.mock.calls[0][1]).toMatch(/^\$2[aby]\$12\$/);
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
      mockPrincipal(users, principalRow());
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
      mockPrincipal(users, principalRow());
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
  /**
   * Rewritten for the AUTH-001/002/003 remediation. The previous versions of
   * these tests asserted the DEFECTIVE contract — that a replay, a hash
   * mismatch, or a merely EXPIRED token each revoked every session the user
   * owned. That whole-account response is exactly what the audit found
   * (docs/AUTH_CONCURRENCY_GC_AUDIT.md, AUTH-002/AUTH-003), so the assertions
   * were inverted rather than adjusted.
   *
   * Admission is now decided by a conditional UPDATE (`claimRefreshRow`), which
   * surfaces here as `refreshTokens.createQueryBuilder(...).execute()`. A
   * non-empty `raw` means this request won the row; an empty one means it lost
   * and everything after it is diagnosis, never admission.
   */
  describe('refresh', () => {
    const JTI = '11111111-1111-4111-8111-111111111111';
    const SUCCESSOR = '22222222-2222-4222-8222-222222222222';
    const FAMILY = '33333333-3333-4333-8333-333333333333';

    const validPayload = {
      sub: 'user-1',
      tenantId: 'tenant-1',
      jti: JTI,
      type: 'refresh',
    };

    /** Makes the atomic claim win, returning the row's owner + family. */
    const claimWins = () => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn(async () => ({
        affected: 1,
        raw: [{ userId: 'user-1', family_id: FAMILY }],
      }));
      refreshTokens.createQueryBuilder.mockReturnValueOnce(qb);
      return qb;
    };

    /** Makes the atomic claim lose — no row matched the conditional UPDATE. */
    const claimLoses = () => {
      const qb = createMockQueryBuilder();
      qb.execute = jest.fn(async () => ({ affected: 0, raw: [] }));
      refreshTokens.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    /** The persisted row must hash-match the presented token. */
    const storedFor = (
      rawToken: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const { createHash } = require('crypto');
      const token_hash = createHash('sha256').update(rawToken).digest('hex');
      return {
        id: JTI,
        token_hash,
        family_id: FAMILY,
        revoked_at: null,
        rotated_at: null,
        replaced_by_id: null,
        retry_count: 0,
        expires_at: new Date(Date.now() + 60_000),
        user: { id: 'user-1' },
        ...overrides,
      };
    };

    it('rotates when the atomic claim wins, continuing the parent family', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimWins();
      mockPrincipal(users, principalRow());

      const result = await service.refresh('rt');

      expect(result.user).toEqual(expectedPrincipal);
      // SEC-02 — the new access token names the SAME session as the family, so
      // revoking the family (logout) ends it too.
      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'access', sid: FAMILY }),
        expect.anything(),
      );
      // The child inherits the family and records its parent — the lineage
      // that makes family-scoped revocation possible.
      expect(refreshTokens.save).toHaveBeenCalledWith(
        expect.objectContaining({ family_id: FAMILY, parent_id: JTI }),
      );
      // Admission came from the conditional UPDATE, not from a read-then-write.
      expect(refreshTokens.createQueryBuilder).toHaveBeenCalled();
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

    it('rejects a MALFORMED jti before it ever reaches the database', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        ...validPayload,
        jti: 'not-a-uuid',
      });

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      // A non-UUID compared against a uuid column raises a Postgres syntax
      // error — a 500 where a 401 belongs. Nothing may be issued at all.
      expect(refreshTokens.createQueryBuilder).not.toHaveBeenCalled();
      expect(refreshTokens.findOne).not.toHaveBeenCalled();
    });

    it('rejects an unknown jti without revoking anything', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimLoses();
      refreshTokens.findOne.mockResolvedValueOnce(null);

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('rejects a token-hash mismatch without revoking anything (AUTH-002)', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimLoses();
      refreshTokens.findOne.mockResolvedValueOnce(
        storedFor('rt', { token_hash: 'different-hash' }),
      );

      await expect(service.refresh('rt')).rejects.toBeInstanceOf(AppError);
      // The bearer never held this token, so it is no evidence about the
      // legitimate holder's session. Pre-fix this revoked every session.
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('rejects an EXPIRED token without revoking anything (AUTH-003)', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimLoses();
      refreshTokens.findOne.mockResolvedValueOnce(
        storedFor('rt', { expires_at: new Date(Date.now() - 1000) }),
      );

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      // Expiry is the ordinary fate of every token, not evidence of theft.
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('treats a lost race as CONCURRENT — 401, and revokes nothing (AUTH-001)', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimLoses();
      refreshTokens.findOne
        // the parent: revoked by the winner, successor id already recorded
        .mockResolvedValueOnce(
          storedFor('rt', {
            revoked_at: new Date(),
            rotated_at: new Date(),
            replaced_by_id: SUCCESSOR,
          }),
        )
        // the successor row does not exist yet — the winner is still issuing
        .mockResolvedValueOnce(null);

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });
      expect(refreshTokens.update).not.toHaveBeenCalled();
      // The outcome a client must NOT read as session loss — and, before this,
      // the one rotation outcome with no metric and no log at all, which is
      // why a client that did mistake it for one was invisible here.
      expect(metrics.recordRefreshRotationEvent).toHaveBeenCalledWith(
        'concurrent_refused',
      );
      // Never mislabelled as theft: that would revoke the winner's family too.
      expect(metrics.recordRefreshRotationEvent).not.toHaveBeenCalledWith(
        'reuse_detected',
      );
    });

    it('revokes ONLY the family when a consumed token is replayed (AUTH-002)', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimLoses();
      refreshTokens.findOne
        .mockResolvedValueOnce(
          storedFor('rt', {
            revoked_at: new Date(),
            rotated_at: new Date(),
            replaced_by_id: SUCCESSOR,
          }),
        )
        // the successor has already been consumed — unambiguous replay
        .mockResolvedValueOnce({
          id: SUCCESSOR,
          revoked_at: new Date(),
          expires_at: new Date(Date.now() + 60_000),
        });

      await expect(service.refresh('rt')).rejects.toMatchObject({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
      });

      // Scoped to the family...
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ family_id: FAMILY }),
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
      // ...and NEVER to the whole user, which was the pre-fix behaviour.
      expect(refreshTokens.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.anything() }),
        expect.anything(),
      );
      // Real replay is reported as replay, never as a benign lost race.
      expect(metrics.recordRefreshRotationEvent).toHaveBeenCalledWith(
        'reuse_detected',
      );
      expect(metrics.recordRefreshRotationEvent).not.toHaveBeenCalledWith(
        'concurrent_refused',
      );
    });

    it('a token retired by logout has no successor, so a replay is reuse of its family alone', async () => {
      jwt.verifyAsync.mockResolvedValueOnce(validPayload);
      claimLoses();
      refreshTokens.findOne.mockResolvedValueOnce(
        // logout revokes without rotating: no rotated_at, no successor
        storedFor('rt', { revoked_at: new Date() }),
      );

      await expect(service.refresh('rt')).rejects.toBeInstanceOf(AppError);
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ family_id: FAMILY }),
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
    });
  });

  // ────────────────────────────────── logout ────────────────────────────────
  describe('logout', () => {
    const JTI = '11111111-1111-4111-8111-111111111111';
    const FAMILY = '22222222-2222-4222-8222-222222222222';

    it("ends the whole session: every live token in the presented token's family is revoked (SEC-02)", async () => {
      jwt.verifyAsync.mockResolvedValueOnce({ jti: JTI, type: 'refresh' });
      refreshTokens.findOne.mockResolvedValueOnce({
        id: JTI,
        family_id: FAMILY,
      });
      await service.logout('rt');
      expect(refreshTokens.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: JTI } }),
      );
      // Family-scoped, not user-scoped: other devices keep their sessions.
      expect(refreshTokens.update).toHaveBeenCalledTimes(1);
      expect(refreshTokens.update).toHaveBeenCalledWith(
        expect.objectContaining({ family_id: FAMILY }),
        expect.objectContaining({ revoked_at: expect.any(Date) }),
      );
    });

    it('is a no-op for an invalid token (never throws)', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new Error('bad'));
      await expect(service.logout('rt')).resolves.toBeUndefined();
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('is a no-op for a token whose jti is not a uuid or matches no row', async () => {
      jwt.verifyAsync.mockResolvedValueOnce({
        jti: 'not-a-uuid',
        type: 'refresh',
      });
      await service.logout('rt');
      jwt.verifyAsync.mockResolvedValueOnce({ jti: JTI, type: 'refresh' });
      refreshTokens.findOne.mockResolvedValueOnce(null);
      await service.logout('rt');
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });
  });

  describe('isSessionLive (SEC-02)', () => {
    const SID = '33333333-3333-4333-8333-333333333333';
    let query: jest.Mock;
    beforeEach(() => {
      query = jest.fn();
      (refreshTokens as unknown as { query: jest.Mock }).query = query;
    });

    it('is live while the family has a live token or a rotation is mid-flight', async () => {
      query.mockResolvedValueOnce([{ '?column?': 1 }]);
      await expect(service.isSessionLive(SID)).resolves.toBe(true);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/revoked_at IS NULL AND expires_at > now\(\)/);
      // In-flight rotation: revoked parent, recorded successor not inserted yet.
      expect(sql).toMatch(/replaced_by_id IS NOT NULL/);
      expect(sql).toMatch(/NOT EXISTS/);
      expect(params).toEqual([SID, 10]);
    });

    it('is ended once nothing in the family is live (logout, logout-all, reuse, offboarding)', async () => {
      query.mockResolvedValueOnce([]);
      await expect(service.isSessionLive(SID)).resolves.toBe(false);
    });

    it('treats a malformed sid as ended without touching the database', async () => {
      await expect(service.isSessionLive('nope')).resolves.toBe(false);
      expect(query).not.toHaveBeenCalled();
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
  describe('loginUrl', () => {
    it('builds the sign-in URL from the configured app base URL', () => {
      (config.get as jest.Mock).mockImplementation((key: string) =>
        key === 'APP_URL' ? 'https://clinic.example.com' : undefined,
      );
      expect(service.loginUrl()).toBe('https://clinic.example.com/auth/login');
    });
  });

  describe('forgotPassword', () => {
    it('never includes a reset credential in the response when the email exists', async () => {
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);
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
        users.find.mockResolvedValueOnce([{ id: 'user-1' }]);
        const result = await service.forgotPassword({
          email: 'a@b.com',
        } as any);
        expect(result).not.toHaveProperty('resetToken');
        expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{64}/); // no raw 32-byte hex token anywhere in the body
      },
    );

    it('returns a response identical to the known-email case for an unknown email — anti-enumeration', async () => {
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);
      const knownResult = await service.forgotPassword({
        email: 'a@b.com',
      } as any);

      users.find.mockResolvedValueOnce([]);
      const unknownResult = await service.forgotPassword({
        email: 'ghost@b.com',
      } as any);

      expect(unknownResult).toEqual(knownResult);
      expect(passwordResets.save).toHaveBeenCalledTimes(1); // only for the known-email case
    });

    it('tolerates a tenant-slug resolution failure and still does not leak', async () => {
      tenants.findOne.mockRejectedValueOnce(new Error('boom'));
      users.find.mockResolvedValueOnce([]);
      await expect(
        service.forgotPassword({ email: 'a@b.com', tenantSlug: 'x' } as any),
      ).resolves.toEqual({ message: expect.any(String) });
    });

    it('still dispatches the reset email and persists the token hash', async () => {
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);
      await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(passwordResets.save).toHaveBeenCalledTimes(1);
      expect(email.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    // FR-H014/T156 gap-closure: the user row is already loaded here, so its
    // recorded locale (M-08) must reach the email — a free, no-risk win.
    it("[T156] forwards the user's preferred_locale to the reset email", async () => {
      users.find.mockResolvedValueOnce([
        {
          id: 'user-1',
          preferred_locale: 'ar',
        },
      ]);
      await service.forgotPassword({ email: 'a@b.com' } as any);
      expect(email.sendPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'ar' }),
      );
    });

    it('[T156] leaves locale undefined (not a guess) when the user never set one', async () => {
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);
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
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);

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
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);

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
      users.find.mockResolvedValueOnce([{ id: 'user-1' }]);

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

    it('kills every other outstanding link for the user in the same transaction', async () => {
      passwordResets.findOne.mockResolvedValueOnce(reset());
      await service.resetPassword({
        token: 'tok',
        newPassword: 'NewPass123!',
      } as any);
      expect(dataSource.manager.createQueryBuilder).toHaveBeenCalled();
    });

    it('the loser of a double submit changes nothing: claim affects 0 rows -> invalid token, password untouched', async () => {
      passwordResets.findOne.mockResolvedValueOnce(reset());
      dataSource.manager.update.mockResolvedValueOnce({ affected: 0 });
      await expect(
        service.resetPassword({
          token: 'tok',
          newPassword: 'NewPass123!',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_RESET_TOKEN });
      expect(dataSource.manager.update).toHaveBeenCalledTimes(1); // only the claim
      expect(refreshTokens.update).not.toHaveBeenCalled();
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
      mockPrincipal(users, principalRow());
      await expect(service.buildAuthenticatedUser('user-1')).resolves.toEqual(
        expectedPrincipal,
      );
    });

    it('maps a null tenant (super-admin) correctly', async () => {
      mockPrincipal(users, {
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
      mockPrincipal(users, null); // no row at all — LEFT JOIN never applies
      await expect(
        service.buildAuthenticatedUser('nope'),
      ).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
    });

    it('throws USER_INACTIVE when the user is deactivated', async () => {
      mockPrincipal(users, { ...principalRow(), is_active: false });
      await expect(
        service.buildAuthenticatedUser('user-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
    });

    it('tolerates a null permission row (LEFT JOIN with an empty rolePermissions set)', async () => {
      mockPrincipal(users, {
        id: 'user-2',
        email: 'staff@clinic.com',
        is_active: true,
        tenant: { id: 'tenant-1' },
        userRoles: [
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

    it('handles a user with an undefined userRoles relation (zero roles)', async () => {
      mockPrincipal(users, {
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
    it('returns the same principal as buildAuthenticatedUser, plus the Tenant row folded from the same rows', async () => {
      const row = {
        ...principalRow(),
        tenant: {
          id: 'tenant-1',
          name: 'Al-Noor Clinic',
          approval_status: 'APPROVED',
          is_active: true,
        },
      };
      mockPrincipal(users, row);
      const { principal, tenant } =
        await service.buildAuthenticatedUserWithTenant('user-1');
      expect(principal).toEqual(expectedPrincipal);
      // Byte-identical to what ActiveTenantGuard and the one other consumer
      // (WhatsappAnalyticsController reading `.name`) actually read — not a
      // reference-equal object any more (it's rebuilt from flat rows, not
      // hydrated by TypeORM), but the same fields with the same values.
      expect(tenant).toMatchObject({
        id: 'tenant-1',
        name: 'Al-Noor Clinic',
        approval_status: 'APPROVED',
        is_active: true,
      });
      // The tenant is never merged into the principal — guards against a future
      // regression that would leak it through GET /auth/me.
      expect((principal as any).tenant).toBeUndefined();
    });

    it('returns tenant: null for a super-admin / no-tenant user', async () => {
      mockPrincipal(users, {
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
      mockPrincipal(users, { ...principalRow(), is_active: false });
      await expect(
        service.buildAuthenticatedUserWithTenant('user-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.USER_INACTIVE,
      });
    });
  });

  // ───────── P5-1 (015-db-api-efficiency-audit, AUTH-001) — loadPrincipal ─────────
  //
  // T031: a differential test over a fixture matrix, asserting the query-
  // builder-based `loadPrincipal` resolves EXACTLY the role/permission sets
  // the old `findOne({ relations })` fold algorithm would have produced from
  // the same underlying data — a dropped permission is a lockout, an extra
  // one is privilege escalation (Constitution VII). `expectedFor()` below
  // independently re-implements that old fold (dedupe via Set, skip nulls)
  // over the fixture's nested shape, so this is a genuine comparison against
  // the pre-change algorithm's semantics, not a tautology against whatever
  // the current code happens to output.
  describe('loadPrincipal — differential across role fixtures (T031, AUTH-001)', () => {
    type RoleFixture = { slug: string; permissions: string[] };
    const buildRow = (opts: {
      id: string;
      email?: string | null;
      fullName?: string | null;
      isActive?: boolean;
      tenant?: { id: string } | null;
      roles?: RoleFixture[];
    }) => ({
      id: opts.id,
      email: opts.email ?? null,
      full_name: opts.fullName ?? null,
      is_active: opts.isActive ?? true,
      tenant: opts.tenant ?? null,
      userRoles: (opts.roles ?? []).map((r) => ({
        role: {
          slug: r.slug,
          rolePermissions: r.permissions.map((p) => ({
            permission: { slug: p },
          })),
        },
      })),
    });

    // Independent re-implementation of the OLD entity-relations fold, over
    // the fixture's nested shape — deliberately NOT calling any AuthService
    // code, so this is a real second source of truth to diff against.
    const expectedFor = (row: ReturnType<typeof buildRow>) => {
      const roleSlugs = new Set<string>();
      const permissionSlugs = new Set<string>();
      for (const ur of row.userRoles ?? []) {
        if (!ur.role) continue;
        roleSlugs.add(ur.role.slug);
        for (const rp of ur.role.rolePermissions ?? []) {
          if (rp.permission) permissionSlugs.add(rp.permission.slug);
        }
      }
      return {
        id: row.id,
        tenantId: row.tenant?.id ?? null,
        email: row.email,
        fullName: row.full_name,
        roles: [...roleSlugs],
        permissions: [...permissionSlugs],
      };
    };

    const FIXTURES: Record<string, ReturnType<typeof buildRow>> = {
      owner: buildRow({
        id: 'u-owner',
        email: 'owner@t1.test',
        tenant: { id: 'tenant-1' },
        roles: [
          {
            slug: ROLE.OWNER,
            permissions: [
              'appointments.read',
              'appointments.create',
              'staff.manage',
            ],
          },
        ],
      }),
      manager: buildRow({
        id: 'u-mgr',
        email: 'mgr@t1.test',
        tenant: { id: 'tenant-1' },
        roles: [
          {
            slug: ROLE.MANAGER,
            permissions: ['appointments.read', 'staff.manage'],
          },
        ],
      }),
      'doctor (ownership-scoped)': buildRow({
        id: 'u-doc',
        email: 'doc@t1.test',
        tenant: { id: 'tenant-1' },
        roles: [{ slug: ROLE.DOCTOR, permissions: ['appointments.read_own'] }],
      }),
      receptionist: buildRow({
        id: 'u-rec',
        email: 'rec@t1.test',
        tenant: { id: 'tenant-1' },
        roles: [
          {
            slug: ROLE.RECEPTIONIST,
            permissions: ['appointments.read', 'customers.read'],
          },
        ],
      }),
      'platform support': buildRow({
        id: 'u-sup',
        email: 'sup@platform.test',
        tenant: null,
        roles: [
          {
            slug: ROLE.PLATFORM_SUPPORT,
            permissions: ['support.tickets.read'],
          },
        ],
      }),
      'super-admin (tenantId: null)': buildRow({
        id: 'u-sa',
        email: 'sa@platform.test',
        tenant: null,
        roles: [
          { slug: ROLE.SUPER_ADMIN, permissions: ['platform.settings.manage'] },
        ],
      }),
      "custom 'other' role": buildRow({
        id: 'u-other',
        email: 'other@t2.test',
        tenant: { id: 'tenant-2' },
        roles: [{ slug: 'other', permissions: ['custom.permission'] }],
      }),
      'two-role user (overlapping permission de-duplicated)': buildRow({
        id: 'u-two',
        email: 'two@t1.test',
        tenant: { id: 'tenant-1' },
        roles: [
          {
            slug: ROLE.OWNER,
            permissions: ['appointments.read', 'staff.manage'],
          },
          {
            slug: ROLE.DOCTOR,
            permissions: ['appointments.read_own', 'appointments.read'],
          },
        ],
      }),
      'zero-role user': buildRow({
        id: 'u-zero',
        email: 'zero@t1.test',
        tenant: { id: 'tenant-1' },
        roles: [],
      }),
    };

    it.each(Object.entries(FIXTURES))(
      '%s: resolves byte-identical role/permission sets to the pre-change fold',
      async (_label, row) => {
        mockPrincipal(users, row);
        const principal = await service.buildAuthenticatedUser(row.id);
        expect(principal).toEqual(expectedFor(row));
      },
    );

    it('inactive user (from the fixture matrix) throws USER_INACTIVE', async () => {
      mockPrincipal(users, { ...FIXTURES.owner, is_active: false });
      await expect(
        service.buildAuthenticatedUser(FIXTURES.owner.id),
      ).rejects.toMatchObject({ code: ErrorCode.USER_INACTIVE });
    });

    it('missing user (no row returned at all) throws USER_INACTIVE', async () => {
      mockPrincipal(users, null);
      await expect(
        service.buildAuthenticatedUser('does-not-exist'),
      ).rejects.toMatchObject({ code: ErrorCode.USER_INACTIVE });
    });
  });

  // T033: the property a differential test on VALUES cannot see — that the
  // fix is actually ONE round trip, not two.
  describe('loadPrincipal — single-statement guarantee (T033, AUTH-001)', () => {
    it('issues exactly one query per buildAuthenticatedUser call (spy on the query runner)', async () => {
      const qb = mockPrincipal(users, principalRow());
      await service.buildAuthenticatedUser('user-1');

      // Exactly one createQueryBuilder() — the single entry point to the DB
      // for this call — and no fallback to the old findOne/relations path.
      expect(users.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(users.findOne).not.toHaveBeenCalled();
      expect(qb.getRawMany).toHaveBeenCalledTimes(1);
      // No pagination branch entered — the specific TypeORM behaviour
      // (research.md R-01/R-10) that turns a joined read into two queries.
      expect(qb.take).not.toHaveBeenCalled();
      expect(qb.skip).not.toHaveBeenCalled();
      expect(qb.limit).not.toHaveBeenCalled();
      expect(qb.offset).not.toHaveBeenCalled();
    });

    it('issues exactly one query per buildAuthenticatedUserWithTenant call', async () => {
      const qb = mockPrincipal(users, principalRow());
      await service.buildAuthenticatedUserWithTenant('user-1');

      expect(users.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.getRawMany).toHaveBeenCalledTimes(1);
    });

    it('USER_INACTIVE for an inactive user (statement-count context)', async () => {
      mockPrincipal(users, { ...principalRow(), is_active: false });
      await expect(
        service.buildAuthenticatedUser('user-1'),
      ).rejects.toMatchObject({ code: ErrorCode.USER_INACTIVE });
    });

    it('USER_INACTIVE for a missing user (statement-count context)', async () => {
      mockPrincipal(users, null);
      await expect(
        service.buildAuthenticatedUser('nope'),
      ).rejects.toMatchObject({ code: ErrorCode.USER_INACTIVE });
    });

    it('preloadedTenant: set (non-null) on a tenant user, null on a super-admin, and never present on the principal', async () => {
      mockPrincipal(users, {
        ...principalRow(),
        tenant: {
          id: 'tenant-1',
          approval_status: 'APPROVED',
          is_active: true,
        },
      });
      const withTenant =
        await service.buildAuthenticatedUserWithTenant('user-1');
      expect(withTenant.tenant).not.toBeNull();
      expect((withTenant.principal as any).tenant).toBeUndefined();

      mockPrincipal(users, {
        id: 'sa-1',
        is_active: true,
        tenant: null,
        userRoles: [{ role: { slug: 'super_admin', rolePermissions: [] } }],
      });
      const superAdmin = await service.buildAuthenticatedUserWithTenant('sa-1');
      expect(superAdmin.tenant).toBeNull();
      expect((superAdmin.principal as any).tenant).toBeUndefined();
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
        limiter as any,
        metrics as any,
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
      mockPrincipal(users, principalRow()); // buildAuthenticatedUser
      bcryptCompare.mockResolvedValueOnce(true);
    };

    it('parses a unit-less TTL ("900") as seconds, ±10% P1.2 jitter', async () => {
      primeLogin();
      const svc = buildWithConfig({
        JWT_ACCESS_TTL: '900',
        JWT_REFRESH_TTL: '7d',
      });
      const result = await svc.login({
        email: 'a@b.com',
        password: 'pw',
      } as any);
      // 900s → 900_000ms base, jittered ±10% (P1.2 / MS-008 — de-synchronizes
      // a cohort's token expiry so a mass session-expiry event doesn't
      // produce a mass-reauth burst). Exact 900 is no longer expected.
      expect(result.expiresIn).toBeGreaterThanOrEqual(810);
      expect(result.expiresIn).toBeLessThanOrEqual(990);
    });

    it('applies jitter freshly on every issuance — two logins are not forced to the same TTL', async () => {
      primeLogin();
      const svc = buildWithConfig({
        JWT_ACCESS_TTL: '900',
        JWT_REFRESH_TTL: '7d',
      });
      const seen = new Set<number>();
      for (let i = 0; i < 20; i++) {
        primeLogin();
        const result = await svc.login({
          email: 'a@b.com',
          password: 'pw',
        } as any);
        seen.add(result.expiresIn);
      }
      // Overwhelmingly unlikely to collapse to a single value across 20
      // independent draws from a continuous ±10% range unless jitter isn't
      // actually being applied per-call.
      expect(seen.size).toBeGreaterThan(1);
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
        limiter as any,
        metrics as any,
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
      mockPrincipal(users, principalRow());
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
