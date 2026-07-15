import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { RefreshToken } from '../../entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { RegisterOwnerDto } from './dto/register-owner.dto';
import {
  ASSIGNABLE_STAFF_ROLES,
  RegisterUserDto,
} from './dto/register-user.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

import { JwtPayload, RefreshTokenPayload } from './interfaces/jwt-payload.interface';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { AuthResult, AuthTokens } from './interfaces/auth-tokens.interface';
import { AppError, ErrorCode } from '../../common/errors';
import { ROLE, RoleSlug } from '../../rbac/rbac.constants';
import { UsageService } from '../subscription-billing/usage.service';
import { COUNT_LIMIT } from '../subscription-billing/usage-metric';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import { EmailService } from '../email/email.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(PasswordReset)
    private readonly passwordResets: Repository<PasswordReset>,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly platformSettings: SystemSettingService,
    private readonly email: EmailService,
  ) {}

  /** Base URL for links embedded in emails (APP_URL, else first FRONTEND_ORIGIN). */
  private appUrl(): string {
    return (
      this.config.get<string>('APP_URL') ??
      (this.config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000')
        .split(',')[0]
        .trim()
    );
  }

  // ----------------------------------------------------------------------- //
  // Registration & login
  // ----------------------------------------------------------------------- //

  /**
   * CLINIC ONBOARDING (public). Creates a brand-new tenant (clinic) and its
   * first user, who is assigned the `owner` role — atomically. The owner is
   * signed in immediately, so a token pair is returned.
   *
   * The tenant starts `PENDING_VERIFICATION` / inactive (entity defaults); a
   * super-admin approves it later.
   */
  async registerOwner(
    dto: RegisterOwnerDto,
    context?: TokenContext,
  ): Promise<AuthResult> {
    const allowRegistration = await this.platformSettings.getTyped<boolean>(
      SettingKey.ALLOW_REGISTRATION,
    );
    if (!allowRegistration) {
      throw new ForbiddenException(
        'New registrations are currently closed. Please contact the platform administrator.',
      );
    }

    const slugTaken = await this.tenants.findOne({ where: { slug: dto.slug } });
    if (slugTaken) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A clinic with this slug already exists',
      });
    }

    // Canonicalise the email so the stored login identifier matches what login
    // will normalise it to (see normalizeEmail / validateCredentials).
    const email = this.normalizeEmail(dto.email);

    const userId = await this.dataSource.transaction(async (manager) => {
      const tenant = await manager.save(
        manager.create(Tenant, {
          name: dto.clinicName,
          slug: dto.slug,
          contact_email: email,
          contact_phone: dto.phone,
          commercial_registration_number: dto.commercialRegistrationNumber,
        }),
      );

      // Owner ALWAYS gets the owner role; if this fails the tenant+user roll back.
      const user = await this.createUserWithRole(
        manager,
        { email, password: dto.password, fullName: dto.fullName, phone: dto.phone },
        ROLE.OWNER,
        tenant.id,
      );
      return user.id;
    });

    // Welcome the new clinic owner (best-effort; never blocks onboarding).
    await this.email.sendWelcome({
      to: email,
      name: dto.fullName,
      clinicName: dto.clinicName,
    });

    return this.issueAuthResult(userId, context);
  }

  /**
   * STAFF CREATION (admin-only). Adds a user to an EXISTING tenant and assigns
   * a non-privileged staff role (default: receptionist). The tenant comes from
   * the acting admin's principal — never the body — preserving tenant isolation.
   *
   * Returns the created principal (NOT tokens): an admin is provisioning
   * someone else, not signing themselves in.
   */
  async createTenantUser(
    dto: RegisterUserDto,
    actorTenantId: string | null,
  ): Promise<AuthenticatedUser> {
    if (!actorTenantId) {
      // A platform super-admin has no tenant scope to create staff into.
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'Staff can only be created within a tenant',
      });
    }

    const roleSlug = dto.roleSlug ?? ROLE.RECEPTIONIST;
    this.assertAssignableStaffRole(roleSlug);

    const email = this.normalizeEmail(dto.email);
    const existing = await this.users.findOne({
      where: { email, tenant: { id: actorTenantId } },
    });
    if (existing) {
      throw new AppError(ErrorCode.EMAIL_ALREADY_EXISTS);
    }

    // Plan limit: max_users. Counts the tenant's existing users and rejects
    // (422) when adding another would exceed the cap. Self-signup of the owner
    // (registerOwner) is deliberately NOT limited — only adding staff to an
    // existing tenant is. No-op under free mode / active override.
    const currentUsers = await this.users.count({
      where: { tenant: { id: actorTenantId } },
    });
    await this.usage.assertCountWithinLimit(
      actorTenantId,
      COUNT_LIMIT.USERS,
      currentUsers,
    );

    const userId = await this.dataSource.transaction(async (manager) => {
      const user = await this.createUserWithRole(
        manager,
        { email, password: dto.password, fullName: dto.fullName, phone: dto.phone },
        roleSlug,
        actorTenantId,
      );
      return user.id;
    });

    return this.buildAuthenticatedUser(userId);
  }

  /**
   * Creates a User row and assigns it the given role, inside the CALLER's
   * transaction (a bare `manager`, not `this.dataSource`) — so a caller can
   * compose it with further writes (e.g. StaffService creating a StaffProfile
   * in the same transaction) and have everything roll back together.
   *
   * Shared by registerOwner, createTenantUser, and StaffService's "create new
   * staff user" flow. Does NOT check email uniqueness or plan limits — those
   * checks are scoped differently per caller (a brand-new tenant can never
   * collide; an existing tenant must pre-check) and are the caller's job.
   */
  async createUserWithRole(
    manager: EntityManager,
    input: { email: string; password: string; fullName: string; phone?: string },
    roleSlug: RoleSlug,
    tenantId: string,
  ): Promise<User> {
    const user = await manager.save(
      manager.create(User, {
        email: input.email,
        phone: input.phone,
        full_name: input.fullName,
        password_hash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
        is_active: true,
        tenant: { id: tenantId } as Tenant,
      }),
    );
    await this.assignRoleBySlug(manager, user, roleSlug);
    return user;
  }

  /** Verifies credentials and returns a token pair on success. */
  async login(dto: LoginDto, context?: TokenContext): Promise<AuthResult> {
    const user = await this.validateCredentials(
      dto.email,
      dto.password,
      dto.tenantSlug,
    );

    user.last_login_at = new Date();
    await this.users.save(user);

    return this.issueAuthResult(user.id, context);
  }

  /**
   * Resolves a user from email (+ optional tenant slug) and verifies the
   * password. Throws a uniform error so callers can't probe which part failed.
   *
   * Tenant resolution:
   *  - With an explicit `tenantSlug`, the lookup is scoped strictly to that
   *    clinic — this is also how an email reused across clinics is disambiguated.
   *  - Without one, the account is matched by email across EVERY scope
   *    (platform super-admin + all tenants) and the password picks the account.
   *    The login form only collects email + password, so a tenant owner/staff
   *    must be resolvable without knowing their slug; scoping to `tenant IS NULL`
   *    (the old behaviour) could only ever find super-admins and made every
   *    tenant login fail. Soft-deleted users are excluded by TypeORM.
   */
  async validateCredentials(
    email: string,
    password: string,
    tenantSlug?: string,
  ): Promise<User> {
    const normalizedEmail = this.normalizeEmail(email);

    // password_hash is `select: false` on the entity (never leak it in normal
    // reads) — re-select it explicitly here since this is the one legitimate
    // site that needs to compare it.
    const select = {
      id: true,
      email: true,
      phone: true,
      password_hash: true,
      full_name: true,
      avatar_url: true,
      is_active: true,
      last_login_at: true,
      created_at: true,
      updated_at: true,
      deleted_at: true,
    } as const;

    let candidates: User[];
    if (tenantSlug) {
      const tenantId = await this.resolveTenantId(tenantSlug); // throws INVALID_CREDENTIALS if unknown
      if (!tenantId) {
        throw new AppError(ErrorCode.INVALID_CREDENTIALS);
      }
      candidates = await this.users.find({
        where: { email: normalizedEmail, tenant: { id: tenantId } },
        relations: { tenant: true },
        select,
      });
    } else {
      candidates = await this.users.find({
        where: { email: normalizedEmail },
        relations: { tenant: true },
        select,
      });
    }

    // Uniform failure — never reveal whether the email, tenant, activation state
    // or password was the mismatch. The password disambiguates when more than
    // one account shares the email across clinics.
    for (const user of candidates) {
      if (!user.password_hash || !user.is_active) continue;
      if (await bcrypt.compare(password, user.password_hash)) {
        return user;
      }
    }
    throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  }

  /**
   * Canonical email form used everywhere a user is created or looked up, so
   * creation and login always agree regardless of the client's casing/whitespace.
   */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  // ----------------------------------------------------------------------- //
  // Token lifecycle
  // ----------------------------------------------------------------------- //

  /** Rotates a refresh token: validates the old one, revokes it, issues a new pair. */
  async refresh(refreshToken: string, context?: TokenContext): Promise<AuthResult> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
      });
    } catch {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    if (payload.type !== 'refresh') {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN, { message: 'Invalid token type' });
    }

    const stored = await this.refreshTokens.findOne({
      where: { id: payload.jti },
      relations: { user: true },
    });

    const tokenHash = this.hashToken(refreshToken);
    if (
      !stored ||
      stored.revoked_at ||
      stored.token_hash !== tokenHash ||
      stored.expires_at.getTime() < Date.now()
    ) {
      // If a revoked/forged token is presented, defensively revoke the whole
      // family for that user (possible token theft).
      if (stored?.user) {
        await this.revokeAllForUser(stored.user.id);
      }
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    stored.revoked_at = new Date();
    await this.refreshTokens.save(stored);

    // Return the rotated tokens AND the live principal so the controller can
    // set fresh cookies and respond with the user (never tokens in the body).
    return this.issueAuthResult(stored.user.id, context);
  }

  /** Revokes a single refresh token (single-device logout). */
  async logout(refreshToken: string): Promise<void> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
      });
    } catch {
      return; // logging out with a bad token is a no-op
    }
    await this.refreshTokens.update(
      { id: payload.jti, revoked_at: IsNull() },
      { revoked_at: new Date() },
    );
  }

  /** Revokes every active refresh token for a user (global logout). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshTokens.update(
      { user: { id: userId }, revoked_at: IsNull() },
      { revoked_at: new Date() },
    );
  }

  // ----------------------------------------------------------------------- //
  // Password management
  // ----------------------------------------------------------------------- //

  /**
   * Issues a single-use password-reset token. Always resolves the same way
   * regardless of whether the email exists, to prevent account enumeration.
   * Returns the raw token so the caller (a mailer) can deliver it.
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ resetToken?: string }> {
    const tenantId = await this.resolveTenantId(dto.tenantSlug).catch(() => null);
    const email = this.normalizeEmail(dto.email);

    const user = await this.users.findOne({
      where: {
        email,
        tenant: tenantId ? { id: tenantId } : IsNull(),
      },
    });

    if (!user) {
      return {};
    }

    const rawToken = randomBytes(32).toString('hex');
    const ttlMinutes = this.config.get<number>('PASSWORD_RESET_TTL_MIN', 30);

    await this.passwordResets.save(
      this.passwordResets.create({
        user: { id: user.id } as User,
        token_hash: this.hashToken(rawToken),
        expires_at: new Date(Date.now() + ttlMinutes * 60_000),
      }),
    );

    // Deliver the reset link by email (best-effort; never blocks the response).
    const resetUrl = `${this.appUrl()}/auth/reset-password?token=${rawToken}`;
    await this.email.sendPasswordReset({
      to: dto.email,
      name: user.full_name ?? undefined,
      resetUrl,
      token: rawToken,
      tenantId: tenantId ?? undefined,
    });

    // The raw token is still returned so non-email deployments keep working; the
      if (this.config.get<string>('NODE_ENV') !== 'production') {
          return {
              resetToken: rawToken,
          };
      }
      return {};
  }

  /** Consumes a reset token, sets the new password and kills all sessions. */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const reset = await this.passwordResets.findOne({
      where: { token_hash: this.hashToken(dto.token), used_at: IsNull() },
      relations: { user: true },
    });

    if (!reset || reset.expires_at.getTime() < Date.now() || !reset.user) {
      throw new AppError(ErrorCode.INVALID_RESET_TOKEN);
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        User,
        { id: reset.user.id },
        { password_hash: await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS) },
      );
      await manager.update(
        PasswordReset,
        { id: reset.id },
        { used_at: new Date() },
      );
    });

    await this.revokeAllForUser(reset.user.id);
  }

  /** Changes the password for an authenticated user after re-verifying it. */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    // password_hash is `select: false` on the entity — re-select it explicitly
    // since this is a legitimate site that needs to compare it.
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, password_hash: true },
    });
    if (!user || !user.password_hash) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    const matches = await bcrypt.compare(dto.currentPassword, user.password_hash);
    if (!matches) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, { message: 'Current password is incorrect' });
    }

    user.password_hash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.users.save(user);
    await this.revokeAllForUser(userId);
  }

  // ----------------------------------------------------------------------- //
  // Principal resolution (used by JwtStrategy)
  // ----------------------------------------------------------------------- //

  /**
   * Loads a user with its roles and the permissions granted through them, and
   * flattens everything into the principal that guards consume.
   */
  async buildAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.users.findOne({
      where: { id: userId },
      relations: {
        tenant: true,
        userRoles: {
          role: { rolePermissions: { permission: true } },
        },
      },
    });

    if (!user || !user.is_active) {
      throw new AppError(ErrorCode.USER_INACTIVE);
    }

    const roleSlugs = new Set<string>();
    const permissionSlugs = new Set<string>();

    for (const ur of user.userRoles ?? []) {
      if (!ur.role) continue;
      roleSlugs.add(ur.role.slug);
      for (const rp of ur.role.rolePermissions ?? []) {
        if (rp.permission) permissionSlugs.add(rp.permission.slug);
      }
    }

    return {
      id: user.id,
      tenantId: user.tenant?.id ?? null,
      email: user.email ?? null,
      roles: [...roleSlugs],
      permissions: [...permissionSlugs],
    };
  }

  // ----------------------------------------------------------------------- //
  // Internal helpers
  // ----------------------------------------------------------------------- //

  /**
   * Links a user to a seeded SYSTEM role (tenant IS NULL) inside a transaction.
   * Throws if the role isn't seeded, so a user is never left without a role.
   */
  private async assignRoleBySlug(
    manager: EntityManager,
    user: User,
    slug: RoleSlug,
  ): Promise<void> {
    const role = await manager.findOne(Role, {
      where: { slug, tenant: IsNull() },
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND, {
        message: `System role "${slug}" is not seeded`,
      });
    }
    await manager.save(manager.create(UserRole, { user, role }));
  }

  /** Guards against assigning privileged roles through the staff flow. */
  private assertAssignableStaffRole(slug: RoleSlug): void {
    if (!ASSIGNABLE_STAFF_ROLES.includes(slug)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Role "${slug}" cannot be assigned to staff`,
      });
    }
  }

  private async issueAuthResult(
    userId: string,
    context?: TokenContext,
  ): Promise<AuthResult> {
    const principal = await this.buildAuthenticatedUser(userId);
    const tokens = await this.issueTokens(userId, principal.tenantId, context);
    return {
      ...tokens,
      user: {
        id: principal.id,
        tenantId: principal.tenantId,
        email: principal.email,
        roles: principal.roles,
        permissions: principal.permissions,
      },
    };
  }

  /** Signs an access token and a persisted, rotating refresh token. */
  private async issueTokens(
    userId: string,
    tenantId: string | null,
    context?: TokenContext,
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');

    const accessPayload: JwtPayload = {
      sub: userId,
      tenantId,
      type: 'access',
    };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: accessTtl as JwtSignOptions['expiresIn'],
    });

    // Reserve the refresh-token row id so it can be embedded as the jti.
    const jti = randomUUID();
    const refreshPayload: RefreshTokenPayload = {
      sub: userId,
      tenantId,
      jti,
      type: 'refresh',
    };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
      expiresIn: refreshTtl as JwtSignOptions['expiresIn'],
    });

    await this.refreshTokens.save(
      this.refreshTokens.create({
        id: jti,
        user: { id: userId } as User,
        token_hash: this.hashToken(refreshToken),
        device_info: context?.deviceInfo,
        ip_address: context?.ipAddress,
        expires_at: new Date(Date.now() + this.ttlToMs(refreshTtl)),
      }),
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.floor(this.ttlToMs(accessTtl) / 1000),
    };
  }

  private async resolveTenantId(tenantSlug?: string): Promise<string | null> {
    if (!tenantSlug) {
      return null; // super-admin scope
    }
    const tenant = await this.tenants.findOne({ where: { slug: tenantSlug } });
    if (!tenant) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }
    return tenant.id;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Converts a jwt-style duration ("15m", "7d", "3600s", "900") to milliseconds. */
  private ttlToMs(ttl: string): number {
    const match = /^(\d+)\s*([smhd])?$/.exec(ttl.trim());
    if (!match) {
      return 0;
    }
    const value = Number(match[1]);
    const unit = match[2] ?? 's';
    const multipliers: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return value * multipliers[unit];
  }
}

/** Optional request metadata captured against an issued refresh token. */
export interface TokenContext {
  ipAddress?: string;
  deviceInfo?: string;
}
