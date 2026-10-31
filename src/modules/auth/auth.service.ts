import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { MfaService } from './mfa/mfa.service';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { RefreshToken } from '../../entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { RegisterOwnerDto } from './dto/register-owner.dto';
import {
  ASSIGNABLE_STAFF_ROLES,
  RegisterUserDto,
} from './dto/register-user.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

import {
  JwtPayload,
  RefreshTokenPayload,
} from './interfaces/jwt-payload.interface';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { AuthResult, AuthTokens } from './interfaces/auth-tokens.interface';
import { AppError, ErrorCode, isUniqueViolation } from '../../common/errors';
import { ROLE, RoleSlug } from '../../rbac/rbac.constants';
import { UsageService } from '../subscription-billing/usage.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { SettingKey } from '../platform/settings.registry';
import { EmailService } from '../email/email.service';
import { LoginProtectionService } from './login-protection.service';
import { FixedWindowLimiterService } from '../../queue/fixed-window-limiter.service';
import { MetricsService } from '../../metrics/metrics.service';
import {
  AUTH_ABUSE_LIMITER_SCOPE,
  AUTH_ABUSE_ENDPOINT_WIDE_SUBJECT,
} from './auth-abuse.constants';
import { LOG_EVENT } from '../../common/logging/log-events';
import { formatClientIp } from '../../common/logging/http-access-log';
import { constantTimeEqual } from '../../common/utils/constant-time.util';

const BCRYPT_ROUNDS = 12;

/**
 * RL-16 — a cost-12 hash of discarded random bytes. Comparing against it when
 * no account matches makes an unknown email cost the same bcrypt work as a
 * wrong password, so response time no longer tells the two apart and a flood
 * of made-up emails is no cheaper than one aimed at real accounts. It can
 * never match: nobody knows the input.
 */
const DUMMY_PASSWORD_HASH =
  '$2b$12$MHyGgAC.atV2OacDBMUA.eLCmKAdp.uvTRhtGwWIMhkYjOf3k8TIi';

export type MfaPending =
  | { mfaRequired: true; challengeToken: string }
  | { mfaEnrollmentRequired: true; challengeToken: string };

export function isMfaPending(r: AuthResult | MfaPending): r is MfaPending {
  return 'challengeToken' in r;
}

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
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly usage: UsageService,
    private readonly platformSettings: SystemSettingService,
    private readonly email: EmailService,
    private readonly loginProtection: LoginProtectionService,
    private readonly limiter: FixedWindowLimiterService,
    private readonly metrics: MetricsService,
    @Optional() private readonly mfa?: MfaService,
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
    // 009-auth-abuse-resistance (ZT-006) — both layers run as the FIRST
    // statements, before the ALLOW_REGISTRATION read, the slug-uniqueness
    // query, the tenant+user transaction, sendWelcome and issueAuthResult
    // (FR-068): every one of those is expensive, irreversible, or both.
    //
    // Identity layer (FR-011d, FR-066) — supplemental only: email is
    // attacker-rotatable, so this alone would look like protection while
    // providing none against a rotating attacker. Endpoint layer (FR-067,
    // FR-069) is the layer that actually bounds that attacker — separate
    // key, separate configured limit, independently observable (FR-069).
    const registerWindowSeconds = this.config.get<number>(
      'AUTH_REGISTER_OWNER_WINDOW_SECONDS',
      3600,
    );
    const identityDecision = await this.limiter.consume(
      AUTH_ABUSE_LIMITER_SCOPE.REGISTER_IDENTITY,
      this.abuseSubjectDigest(this.normalizeEmail(dto.email)),
      this.config.get<number>('AUTH_REGISTER_OWNER_MAX_PER_IDENTITY', 3),
      registerWindowSeconds,
    );
    if (!identityDecision.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many requests. Please try again later.',
      });
    }
    // RL-07: per-client layer, BEFORE the endpoint-wide ceiling so one
    // client's refused attempts never use up everybody's sign-up budget (the
    // ceiling counts every attempt, so without this a low ceiling is itself a
    // way to block all onboarding). Opt-in: until the edge token (RL-01) is
    // live, browser sign-ups share Vercel's egress addresses.
    const maxPerClient = this.config.get<number>(
      'AUTH_REGISTER_OWNER_MAX_PER_CLIENT',
    );
    if (maxPerClient && context?.ipAddress) {
      const clientDecision = await this.limiter.consume(
        AUTH_ABUSE_LIMITER_SCOPE.REGISTER_CLIENT,
        this.abuseSubjectDigest(context.ipAddress),
        maxPerClient,
        registerWindowSeconds,
      );
      if (!clientDecision.allowed) {
        throw new AppError(ErrorCode.RATE_LIMITED, {
          message: 'Too many requests. Please try again later.',
        });
      }
    }
    const endpointDecision = await this.limiter.consume(
      AUTH_ABUSE_LIMITER_SCOPE.REGISTER_ENDPOINT,
      AUTH_ABUSE_ENDPOINT_WIDE_SUBJECT,
      this.config.get<number>('AUTH_REGISTER_OWNER_ENDPOINT_CEILING', 1000),
      registerWindowSeconds,
    );
    if (!endpointDecision.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many requests. Please try again later.',
      });
    }

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
      const ownerRole = await this.resolveSystemRole(manager, ROLE.OWNER);
      const user = await this.createUserWithRole(
        manager,
        {
          email,
          password: dto.password,
          fullName: dto.fullName,
          phone: dto.phone,
          locale: dto.locale,
        },
        ownerRole,
        tenant.id,
      );
      return user.id;
    });

    // Welcome the new clinic owner (best-effort; never blocks onboarding).
    // `dto.locale` is the ONLY locale signal that exists at this point — the
    // user record was just created in this same call, so there is no stored
    // preference to read back yet (M-08 — CAP-I18N).
    await this.email.sendWelcome({
      to: email,
      name: dto.fullName,
      clinicName: dto.clinicName,
      userId,
      locale: dto.locale,
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
    // D7 — email uniqueness is enforced globally inside createUserWithRole
    // (the shared chokepoint every creation path routes through); no
    // tenant-scoped pre-check is needed here anymore.

    // Plan limit: max_users. Self-signup of the owner (registerOwner) is
    // deliberately NOT limited — only adding staff to an existing tenant is.
    // No-op under free mode / active override.
    //
    // FND-007: the count-and-assert now runs ATOMICALLY inside the SAME
    // transaction as the insert (see UsageService.assertUserSeatWithinLimit)
    // — a tenant-row lock serializes concurrent seat additions instead of
    // both racing a stale pre-transaction count.
    const userId = await this.dataSource.transaction(async (manager) => {
      await this.usage.assertUserSeatWithinLimit(actorTenantId, manager);
      const role = await this.resolveSystemRole(manager, roleSlug);
      const user = await this.createUserWithRole(
        manager,
        {
          email,
          password: dto.password,
          fullName: dto.fullName,
          phone: dto.phone,
        },
        role,
        actorTenantId,
      );
      return user.id;
    });

    return this.buildAuthenticatedUser(userId);
  }

  /**
   * Creates a User row and links it to an ALREADY-RESOLVED role, inside the
   * CALLER's transaction (a bare `manager`, not `this.dataSource`) — so a
   * caller can compose it with further writes (e.g. StaffService creating a
   * StaffProfile in the same transaction) and have everything roll back
   * together.
   *
   * Shared by registerOwner, createTenantUser, StaffService's "create new
   * staff user" flow, and PlatformStaffService.create. Callers resolve the
   * role themselves first — via {@link resolveSystemRole} (strictly a seeded
   * system role, for registerOwner/createTenantUser) or via
   * `RolesService.findAssignableRoleBySlug` (tenant custom roles + system
   * roles, for the staff flow) — because the two have different scoping
   * rules. `tenantId: null` provisions a PLATFORM user (e.g. Platform
   * Customer Service) — see PlatformStaffService, the only caller that passes
   * null. This method also does NOT check plan limits — that differs per
   * caller and is the caller's job.
   *
   * D7 — EMAIL UNIQUENESS IS ENFORCED HERE, GLOBALLY (any live user, any
   * tenant, platform included), NOT per-tenant. This reverses this method's
   * prior contract (which explicitly left email checks to each caller) —
   * that was correct while the rule was per-tenant; it is wrong once the
   * rule is global, so this is now the SINGLE shared chokepoint no caller —
   * existing or future — can bypass. The pre-insert check below cannot
   * survive concurrency by itself (two simultaneous callers can both read "no
   * clash"); the actual guarantee is the partial unique index
   * `uq_user_email_global` (GlobalUserEmailUniqueness migration), and the
   * catch below translates a raced-past insert into the same
   * `EMAIL_ALREADY_EXISTS` the pre-check produces, so the caller never sees a
   * raw `UNIQUE_VIOLATION` depending on timing.
   */
  async createUserWithRole(
    manager: EntityManager,
    input: {
      email: string;
      password: string;
      fullName: string;
      phone?: string;
      /** M-08 — the locale the user was created/registering from, if known. NULL (omitted) correctly means "no explicit choice yet", not a guess. */
      locale?: string;
    },
    role: Role,
    tenantId: string | null,
  ): Promise<User> {
    const clash = await manager.findOne(User, {
      where: { email: input.email },
    });
    if (clash) {
      throw new AppError(ErrorCode.EMAIL_ALREADY_EXISTS);
    }

    let user: User;
    try {
      user = await manager.save(
        manager.create(User, {
          email: input.email,
          phone: input.phone,
          full_name: input.fullName,
          password_hash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
          is_active: true,
          tenant: tenantId ? ({ id: tenantId } as Tenant) : undefined,
          preferred_locale: input.locale,
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.EMAIL_ALREADY_EXISTS);
      }
      throw err;
    }
    await manager.save(manager.create(UserRole, { user, role }));
    return user;
  }

  /**
   * Verifies credentials and returns a token pair on success.
   *
   * FND-008 — account-aware brute-force protection wraps credential
   * validation:
   *  1. The identity (normalised email, independent of `tenantSlug` — see
   *     LoginProtectionService) is checked BEFORE any credential lookup, so
   *     a locked identity is refused identically whether or not the account
   *     actually exists (no enumeration oracle).
   *  2. Any credential-validation failure records one failure. All of
   *     validateCredentials' rejection paths (unknown tenant, no user, no
   *     password hash, inactive account, wrong password) already collapse
   *     to the same INVALID_CREDENTIALS error, so this treats them
   *     uniformly, exactly as it must.
   *  3. A successful login fully clears the failure state.
   */
  async login(
    dto: LoginDto,
    context?: TokenContext,
  ): Promise<AuthResult | MfaPending> {
    const identity = this.normalizeEmail(dto.email);
    // RL-05: the trusted-proxy-resolved address (req.ip), so a lock earned
    // from one address does not refuse the owner on another.
    const client = context?.ipAddress;

    if (await this.loginProtection.isLocked(identity, client)) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many failed login attempts. Please try again later.',
      });
    }

    let user: User;
    try {
      user = await this.validateCredentials(
        dto.email,
        dto.password,
        dto.tenantSlug,
      );
    } catch (err) {
      const justEngaged = await this.loginProtection.recordFailure(
        identity,
        client,
      );
      if (justEngaged) {
        await this.auditLoginProtectionEvent(
          'auth.login.protection_engaged',
          identity,
          context,
        );
      }
      throw err;
    }

    const hadState = await this.loginProtection.clear(identity, client);
    if (hadState) {
      await this.auditLoginProtectionEvent(
        'auth.login.protection_cleared',
        identity,
        context,
      );
    }

    // P1.2 — a targeted UPDATE of the one column that actually changed,
    // instead of `save()`'ing the whole entity `validateCredentials` loaded
    // (10 selected columns, `password_hash` among them — `.save()` writes
    // every mapped column back, re-writing the hash it just read for no
    // reason). `issueAuthResult` below only ever needs `user.id`, which this
    // never touches.
    // P0.5 (TSF-03): second factor. Password is proven; NO session is issued
    // until the code is verified (or, for a mandatory-but-unenrolled platform
    // user, the factor is enrolled).
    if (this.mfa) {
      if (await this.mfa.isEnabled(user.id)) {
        return {
          mfaRequired: true,
          challengeToken: await this.mfa.issueChallenge(user.id, 'mfa_verify'),
        };
      }
      if (this.mfaEnforcementConfigured()) {
        const principal = await this.buildAuthenticatedUser(user.id);
        if (await this.mfa.enrolmentRequired(user.id, principal)) {
          return {
            mfaEnrollmentRequired: true,
            challengeToken: await this.mfa.issueChallenge(user.id, 'mfa_enroll'),
          };
        }
      }
    }
    return this.finishLogin(user.id, context);
  }

  /** True when any MFA enforcement date is configured (skips the principal lookup otherwise). */
  private mfaEnforcementConfigured(): boolean {
    return !!(
      this.config.get<string>('MFA_ENFORCE_FROM') ||
      this.config.get<string>('MFA_ENFORCE_CLINICAL_FROM')
    );
  }

  /**
   * Refresh must not outlive a newly enforced MFA policy: a session opened before
   * the policy (or before enrolment) cannot rotate into a fresh one while its owner
   * is required to hold a factor and has none. The whole token family is revoked so
   * the client falls back to login, which then walks the user through enrolment.
   */
  private async assertRefreshAllowedByMfa(
    userId: string,
    familyId: string,
  ): Promise<void> {
    if (!this.mfa || !this.mfaEnforcementConfigured()) return;
    const principal = await this.buildAuthenticatedUser(userId);
    if (await this.mfa.enrolmentRequired(userId, principal)) {
      await this.revokeFamily(familyId);
      this.logger.warn({
        event: 'auth.refresh.mfa_enrolment_required',
        user_id: userId,
      });
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN, {
        message: 'Two-factor authentication is required. Please sign in again.',
      });
    }
  }

  /** Completes a login whose password (and, if required, second factor) is proven. */
  async finishLogin(userId: string, context?: TokenContext): Promise<AuthResult> {
    await this.users.update({ id: userId }, { last_login_at: new Date() });

    const result = await this.issueAuthResult(userId, context);
    // Ids only — never the email, password or any token material. Failures are
    // logged by AllExceptionsFilter (`auth.login.failed`, uniform reason).
    this.logger.log({
      event: LOG_EVENT.AUTH_LOGIN_SUCCEEDED,
      message: 'Login succeeded',
      user_id: result.user.id,
      tenant_id: result.user.tenantId ?? undefined,
      // LSA-08: the /24 (/48) network, never the full address joined to a
      // user and clinic; for browser traffic this is the Vercel egress anyway.
      client_ip: formatClientIp(context?.ipAddress, 'truncated'),
    });
    return result;
  }

  /**
   * Safe audit record (FR-020a's counterpart in the durable trail — OB-001,
   * OB-002). Mirrors Feature 002's `WhatsappDlqService.audit` helper:
   * identifiers and outcome only, never a credential. `tenant`/`user` are
   * left null — login is `@Public()`, so a failed attempt has no
   * authenticated actor to attribute the row to; the identity is recorded
   * ONLY as its hash, exactly as {@link LoginProtectionService} derives its
   * Redis key, so the raw email never reaches `audit_logs` either. Wrapped
   * so a write failure logs a warning and never blocks the security
   * decision it records.
   */
  private async auditLoginProtectionEvent(
    action: 'auth.login.protection_engaged' | 'auth.login.protection_cleared',
    identity: string,
    context?: TokenContext,
  ): Promise<void> {
    try {
      const identityHash = createHash('sha256')
        .update(identity.trim().toLowerCase())
        .digest('hex');
      await this.auditLogs.save(
        this.auditLogs.create({
          action,
          entity_type: 'login_identity',
          ip_address: context?.ipAddress,
          new_values: { identityHash, result: action },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Login-protection audit write failed: ${(err as Error).message}`,
      );
    }
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

    // P1.2 — `uq_user_email_global` (P0.5 curated guard) enforces at most
    // one non-deleted user per email GLOBALLY, so `candidates` should never
    // hold more than one row with a password hash today — this loop's
    // "email shared across clinics" case (still handled, never removed: the
    // password disambiguates) is the pre-uq_user_email_global shape. A
    // second active candidate now means that guard is actually missing —
    // the exact same invariant `forgotPassword`'s own multiplicity check
    // (below) already guards, and the same `recordAuthRecoveryEvent`
    // signal, so the two paths that can observe this loss report it
    // identically rather than two different ad-hoc signals for one cause.
    const activeCandidates = candidates.filter(
      (u): u is User & { password_hash: string } =>
        !!u.password_hash && u.is_active,
    );
    if (activeCandidates.length > 1) {
      this.metrics.recordAuthRecoveryEvent('multiplicity_violation');
      this.logger.warn(
        `${activeCandidates.length} active users share email "${normalizedEmail}"` +
          `${tenantSlug ? ` in tenant "${tenantSlug}"` : ''} — uq_user_email_global ` +
          `may be missing. Login still resolves correctly by password.`,
      );
    }

    // Uniform failure — never reveal whether the email, tenant, activation state
    // or password was the mismatch. The password disambiguates when more than
    // one account shares the email across clinics.
    for (const user of activeCandidates) {
      if (await bcrypt.compare(password, user.password_hash)) {
        return user;
      }
    }
    if (activeCandidates.length === 0) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
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

  /**
   * Rotates a refresh token: atomically claims the presented token, then issues
   * a new pair in the SAME rotation family.
   *
   * AUTH-001 — THE SECURITY BOUNDARY IS THE CONDITIONAL UPDATE IN
   * {@link claimRefreshRow}, NOT ANY CHECK IN THIS METHOD. The pre-fix code
   * read the row, checked `revoked_at` in JavaScript, then wrote
   * unconditionally; two concurrent requests both observed `revoked_at IS NULL`
   * and both minted a child (10/10 rounds locally, 5/5 across two app
   * instances — docs/AUTH_CONCURRENCY_GC_AUDIT.md §4). Everything below the
   * claim is DIAGNOSIS of a request that already lost, never admission.
   *
   * Because the gate is a single `UPDATE ... WHERE revoked_at IS NULL`, the
   * serialisation point is the Postgres row itself: a second statement blocks
   * on the row lock, then re-evaluates the predicate against the committed
   * value and matches nothing. That holds identically across processes and
   * hosts, so it needs no distributed lock and no Redis state.
   */
  async refresh(
    refreshToken: string,
    context?: TokenContext,
  ): Promise<AuthResult> {
    // Resolved BEFORE the try/catch below: that block exists to turn a
    // malformed/forged/expired TOKEN into a uniform INVALID_REFRESH_TOKEN
    // error, and must never also swallow a missing-configuration error
    // (ZT-007, FR-020) into the same generic shape — the two are different
    // failures an operator needs to tell apart.
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: refreshSecret,
      });
    } catch {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    if (payload.type !== 'refresh') {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN, {
        message: 'Invalid token type',
      });
    }

    // `jti` is compared against a `uuid` column. A forged token (only possible
    // with a leaked signing secret) could carry any string, and handing that
    // to Postgres raises `invalid input syntax for type uuid` — a 500 where a
    // 401 belongs. Reject malformed identifiers as the invalid tokens they are.
    if (!AuthService.UUID_PATTERN.test(payload.jti ?? '')) {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    const tokenHash = this.hashToken(refreshToken);
    // Reserved up-front so the successor id can be written by the SAME
    // statement that revokes the parent — see claimRefreshRow.
    const childJti = randomUUID();

    // ── (1) THE GATE ────────────────────────────────────────────────────────
    const claimed = await this.claimRefreshRow(
      payload.jti,
      childJti,
      tokenHash,
    );
    if (claimed) {
      await this.assertRefreshAllowedByMfa(claimed.userId, claimed.familyId);
      return this.issueAuthResult(claimed.userId, context, {
        jti: childJti,
        familyId: claimed.familyId,
        parentId: payload.jti,
      });
    }

    // ── (2) DIAGNOSIS — this request did not win the gate ───────────────────
    // Every branch below returns 401. They differ ONLY in whether they are
    // evidence of theft, and each one is deliberately narrow: over-revoking is
    // exactly the AUTH-002/AUTH-003 defect being fixed.
    // No `relations: { user: true }` any more: the reuse response is scoped by
    // `family_id`, so the owning user is never needed here. Dropping the join
    // also removes needless work from a path `/auth/refresh` being `@Public()`
    // lets an unauthenticated caller drive — the same amplification AUTH-003
    // was about.
    const stored = await this.refreshTokens.findOne({
      where: { id: payload.jti },
    });

    // Unknown jti — nothing to revoke, and revoking on this path would let
    // anyone log anyone out by guessing. (Already correct pre-fix.)
    if (!stored) {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    // The row exists but the presented VALUE is not the one it was issued for.
    // The bearer never held this token, so this says nothing about the
    // legitimate holder's session — reject without touching it.
    if (!constantTimeEqual(stored.token_hash, tokenHash)) {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    // Still live, so the only predicate the claim can have failed on is expiry.
    // An expired token is NOT evidence of theft — it is the ordinary fate of
    // every token — so nothing is revoked. Pre-fix this path nuked every
    // session the user had (audit C8).
    if (!stored.revoked_at) {
      throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
    }

    // Revoked. Three very different situations reach this line — see
    // resolveRevokedToken.
    const resolved = await this.resolveRevokedToken(stored, childJti, context);
    if (resolved.kind === 'rotated') {
      return resolved.result;
    }
    if (resolved.kind === 'reuse') {
      await this.handleRefreshReuse(stored, context);
    } else {
      // Lost the gate to a concurrent rotation of the same token. Nothing is
      // revoked and the winner's session is untouched, but the caller still
      // gets a bare 401 — indistinguishable, from the outside, from a dead
      // session. Metered so that a client mishandling it is visible here
      // rather than only as user-reported "random logouts". The RESPONSE is
      // deliberately unchanged: making this branch distinguishable over the
      // wire would hand a replaying attacker an oracle for "a legitimate
      // rotation is in flight right now".
      this.metrics.recordRefreshRotationEvent('concurrent_refused');
    }
    throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
  }

  /**
   * Classifies a presentation of an ALREADY-REVOKED refresh token. Getting this
   * distinction right is the whole of AUTH-002/AUTH-003: the pre-fix code
   * collapsed all of it into "revoke every session this user has".
   *
   *  - `concurrent` — the successor id is recorded but the successor ROW does
   *    not exist yet, which happens only while the request that won the gate is
   *    still minting its child. This request lost a race with itself (same
   *    client, two in-flight refreshes); it is not evidence of anything.
   *    401, revoke NOTHING. This is the branch that keeps a fixed AUTH-001
   *    from turning every multi-tab client into a global logout.
   *
   *  - `rotated` — the successor exists and is still live, inside the bounded
   *    retry window: a client whose response was lost. Resume from the
   *    successor (see retryRotation).
   *
   *  - `reuse` — anything else: the successor was already consumed, or the
   *    window/retry budget is spent, or the token was retired by logout and has
   *    no successor at all. Genuine replay → revoke this family only.
   */
  private async resolveRevokedToken(
    parent: RefreshToken,
    childJti: string,
    context?: TokenContext,
  ): Promise<
    | { kind: 'concurrent' }
    | { kind: 'reuse' }
    | { kind: 'rotated'; result: AuthResult }
  > {
    // No recorded successor at all — the token was retired by logout, or by a
    // family revoke, not by a rotation. Nothing to resume from.
    if (!parent.rotated_at || !parent.replaced_by_id) {
      return { kind: 'reuse' };
    }

    const successor = await this.refreshTokens.findOne({
      where: { id: parent.replaced_by_id },
    });

    // The successor ROW appears only once the winner has finished issuing,
    // while `replaced_by_id` is written by the claim itself — so an absent row
    // PROVES the winner is still in flight. This request raced it and lost.
    if (!successor) {
      return { kind: 'concurrent' };
    }

    // The successor has already been consumed (rotated away, logged out, or
    // expired). That means the client demonstrably DID receive it and moved
    // on, so presenting the parent again is unambiguous replay — no timing
    // heuristic applies, and none is consulted.
    const successorLive =
      !successor.revoked_at && successor.expires_at.getTime() > Date.now();
    if (!successorLive) {
      return { kind: 'reuse' };
    }

    // The successor is still live: the client has NOT moved on. This is either
    // a duplicate that raced the original, or a retry after a lost response.
    // Only here is timing consulted, and the failure mode is deliberately
    // asymmetric — misreading a retry as concurrent costs one extra round
    // trip, whereas misreading a duplicate as a retry would admit a second
    // rotation. Neither branch revokes anything, so neither can destroy a
    // session.
    //
    // Accepted, bounded gap: a replay arriving within
    // AUTH_REFRESH_RETRY_MIN_AGE_MS of the rotation, while the successor is
    // still untouched, is refused (401) but NOT flagged as reuse. The attacker
    // gains nothing from it, and any later replay — or any use of the
    // successor by either party — lands in the `reuse` branch above.
    const rotationAgeMs = Date.now() - parent.rotated_at.getTime();
    if (
      rotationAgeMs <
      this.config.get<number>('AUTH_REFRESH_RETRY_MIN_AGE_MS', 500)
    ) {
      return { kind: 'concurrent' };
    }

    const retried = await this.retryRotation(parent, childJti, context);
    return retried ? { kind: 'rotated', result: retried } : { kind: 'reuse' };
  }

  /** Matches a canonical UUID (any version) — the shape every `jti` we sign has. */
  private static readonly UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * THE ATOMIC ROTATION GATE (AUTH-001).
   *
   * One statement does all four things that must not be separable: it checks
   * the row is unrevoked, checks it is unexpired, checks the presented value
   * hashes to the stored hash, and revokes it — returning the owner and family
   * only if it actually won. `affected === 1` is the admission decision; there
   * is no application-level check that can disagree with it.
   *
   * `replaced_by_id` is set HERE rather than after the child is inserted, so a
   * concurrent loser can never read "revoked, but no successor recorded" and
   * misclassify a race it lost as token reuse. (If the process dies between
   * this statement and the child INSERT, `replaced_by_id` points at a row that
   * never materialised — {@link retryRotation} treats that as "not a retry"
   * and the caller simply re-authenticates.)
   *
   * `tokenHash` is NULL only for the retry path, which resumes from a
   * successor id this service just read out of the parent row rather than from
   * a value the caller presented — there is no raw token to hash in that case,
   * and the caller's authority was already established by the parent's hash.
   */
  private async claimRefreshRow(
    jti: string,
    nextJti: string,
    tokenHash: string | null,
  ): Promise<{ userId: string; familyId: string } | null> {
    const qb = this.refreshTokens
      .createQueryBuilder()
      .update(RefreshToken)
      .set({
        revoked_at: () => 'now()',
        rotated_at: () => 'now()',
        replaced_by_id: nextJti,
      })
      .where('id = :jti', { jti })
      .andWhere('revoked_at IS NULL')
      .andWhere('expires_at > now()');

    // Omitted only on the retry path, which resumes from an id this service
    // read out of the parent row rather than from a caller-supplied value.
    if (tokenHash !== null) {
      qb.andWhere('token_hash = :tokenHash', { tokenHash });
    }

    // Raw `RETURNING` list: the join column is literally `"userId"`, and
    // passing the projection verbatim avoids depending on how the builder
    // would otherwise quote a mixed-case column name.
    const result = await qb.returning('"userId", family_id').execute();

    const row = (result.raw as Array<{ userId: string; family_id: string }>)[0];
    return row ? { userId: row.userId, familyId: row.family_id } : null;
  }

  /**
   * BOUNDED RETRY WINDOW — the answer to "a client sent a refresh, the response
   * was lost in the network, and it is now sending the same token again".
   *
   * Without this, fixing AUTH-001 would make that ordinary event look exactly
   * like theft and (via reuse detection) kill the session. With it, the retry
   * resumes from the successor the lost response had already created.
   *
   * It is NOT a grace period on the old token: the presented token stays
   * revoked and is never honoured again. What is honoured is the SUCCESSOR,
   * claimed through the same atomic gate. Three independent bounds keep this
   * from becoming a replay window:
   *   1. TIME — `AUTH_REFRESH_RETRY_WINDOW_SECONDS` (default 10s) after the
   *      rotation, not after the token's issuance;
   *   2. COUNT — `AUTH_REFRESH_MAX_RETRIES` (default 3) per row;
   *   3. STATE — the successor must still be live. If the client already used
   *      it, this is not a lost response, and the request falls through to
   *      reuse detection.
   *
   * The successor id is chained forward so a second retry within the window
   * resolves to the current head. At every instant the family still has
   * exactly ONE live token.
   */
  private async retryRotation(
    parent: RefreshToken,
    childJti: string,
    context?: TokenContext,
  ): Promise<AuthResult | null> {
    /* istanbul ignore next — resolveRevokedToken already established both. */
    if (!parent.rotated_at || !parent.replaced_by_id) {
      return null;
    }

    const windowMs =
      this.config.get<number>('AUTH_REFRESH_RETRY_WINDOW_SECONDS', 10) * 1_000;
    if (Date.now() - parent.rotated_at.getTime() > windowMs) {
      return null;
    }
    if (
      parent.retry_count >=
      this.config.get<number>('AUTH_REFRESH_MAX_RETRIES', 3)
    ) {
      return null;
    }

    // Same gate as the primary path — a retry is not a privileged bypass.
    const claimed = await this.claimRefreshRow(
      parent.replaced_by_id,
      childJti,
      null,
    );
    if (!claimed) {
      return null; // successor already consumed, revoked, expired or absent
    }

    await this.refreshTokens.update(
      { id: parent.id },
      { replaced_by_id: childJti, retry_count: parent.retry_count + 1 },
    );
    this.metrics.recordRefreshRotationEvent('retry_served');

    return this.issueAuthResult(claimed.userId, context, {
      jti: childJti,
      familyId: claimed.familyId,
      parentId: parent.replaced_by_id,
    });
  }

  /**
   * REUSE DETECTION RESPONSE (AUTH-002) — revokes the compromised FAMILY, and
   * nothing else.
   *
   * Pre-fix this called `revokeAllForUser`, so one replay signed the user out
   * of every device, including sessions with no relationship to the replayed
   * token — and because `/auth/refresh` is public, anyone holding any stale
   * token could trigger it repeatedly (AUTH-003). Scoping to `family_id`
   * confines the response to the one device chain that actually leaked, which
   * is the correct blast radius and leaves every other session untouched.
   *
   * Reuse is also now OBSERVABLE. Pre-fix it was completely silent — no metric,
   * no audit row — even though replay of a rotated token is the single best
   * theft signal the system has.
   */
  private async handleRefreshReuse(
    stored: RefreshToken,
    context?: TokenContext,
  ): Promise<void> {
    await this.revokeFamily(stored.family_id);
    this.metrics.recordRefreshRotationEvent('reuse_detected');
    this.logger.warn({
      event: LOG_EVENT.AUTH_REFRESH_REUSE_DETECTED,
      message: 'Rotated refresh token replayed; its token family was revoked',
      user_id: stored.user?.id,
      // LSA-08: network only in the log; the full address is kept in the
      // access-controlled audit trail written just below.
      client_ip: formatClientIp(context?.ipAddress, 'truncated'),
    });
    await this.auditRefreshReuseEvent(stored, context);
  }

  /**
   * Safe audit record for a detected replay — identifiers and outcome only,
   * never a token or its hash. Mirrors {@link auditLoginProtectionEvent},
   * including the wrapper that keeps a failed audit write from blocking the
   * security decision it records.
   */
  private async auditRefreshReuseEvent(
    stored: RefreshToken,
    context?: TokenContext,
  ): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          action: 'auth.refresh.reuse_detected',
          entity_type: 'refresh_token_family',
          entity_id: stored.family_id,
          ip_address: context?.ipAddress,
          new_values: {
            familyId: stored.family_id,
            result: 'family_revoked',
          },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Refresh-reuse audit write failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Revokes every live token in ONE rotation family — the reuse-detection
   * response. Distinct from {@link revokeAllForUser}, which stays the correct
   * behaviour for the places the user explicitly asks for it (logout-all,
   * password change, password reset).
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokens.update(
      { family_id: familyId, revoked_at: IsNull() },
      { revoked_at: new Date() },
    );
  }

  /**
   * Ends ONE session (single-device logout): every token in the presented
   * token's rotation family is revoked, and because access tokens carry that
   * family as `sid`, {@link isSessionLive} turns them away from the next
   * request on (SEC-02). Other devices' families are untouched.
   *
   * The whole family rather than only the presented row: a refresh racing the
   * logout (another tab) may already have rotated the presented token into a
   * live successor, which would otherwise outlive the logout.
   */
  async logout(refreshToken: string): Promise<void> {
    // Same reasoning as refresh() above: resolved before the try/catch so a
    // missing secret fails loudly instead of being swallowed into the
    // "logging out with a bad token is a no-op" branch.
    const refreshSecret = this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: refreshSecret,
      });
    } catch {
      return; // logging out with a bad token is a no-op
    }
    if (!AuthService.UUID_PATTERN.test(payload.jti ?? '')) {
      return;
    }
    const stored = await this.refreshTokens.findOne({
      where: { id: payload.jti },
      select: { id: true, family_id: true },
    });
    if (!stored) {
      return;
    }
    await this.revokeFamily(stored.family_id);
    this.logger.log({
      event: LOG_EVENT.AUTH_LOGOUT_SUCCEEDED,
      message: 'Logout succeeded',
      user_id: payload.sub,
    });
  }

  /**
   * Whether the session an access token was issued for (`sid`, its refresh
   * family) is still signed in. Called on every authenticated request, so it is
   * one indexed lookup (`idx_refresh_tokens_family_active`).
   *
   * Live means the family still holds an unrevoked, unexpired token — OR a
   * rotation is mid-flight: `claimRefreshRow` revokes the parent and records
   * its successor in one statement, and the successor row is inserted a moment
   * later. A request landing in that gap must not read "signed out", so a
   * parent rotated within the retry window whose successor does not exist yet
   * still counts. Logout, logout-all, reuse detection, password change/reset
   * and offboarding all revoke WITHOUT recording a successor, so none of them
   * can match that clause.
   */
  async isSessionLive(sid: string): Promise<boolean> {
    if (!AuthService.UUID_PATTERN.test(sid)) {
      return false;
    }
    const windowSeconds = this.config.get<number>(
      'AUTH_REFRESH_RETRY_WINDOW_SECONDS',
      10,
    );
    const rows: unknown[] = await this.refreshTokens.query(
      `SELECT 1 FROM refresh_tokens
        WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now()
       UNION ALL
       SELECT 1 FROM refresh_tokens p
        WHERE p.family_id = $1
          AND p.replaced_by_id IS NOT NULL
          AND p.rotated_at > now() - make_interval(secs => $2)
          AND NOT EXISTS (SELECT 1 FROM refresh_tokens c WHERE c.id = p.replaced_by_id)
       LIMIT 1`,
      [sid, windowSeconds],
    );
    return rows.length > 0;
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
   * A single uniform message returned by {@link forgotPassword} in EVERY case
   * — known email, unknown email, any environment. Matches the response this
   * endpoint's own Swagger contract already documents (auth.controller.ts).
   */
  private static readonly FORGOT_PASSWORD_MESSAGE =
    'If that email is registered, a reset link has been sent.';

  /**
   * Issues a single-use password-reset token and delivers it BY EMAIL ONLY
   * (FND-006). Always resolves to the identical `{ message }` shape
   * regardless of whether the email exists, so the response itself cannot be
   * used to enumerate accounts — this is STRONGER than the pre-fix behaviour,
   * where a non-production response shape differed between the two cases.
   *
   * The raw token is NEVER present in this method's return type. The only
   * legitimate delivery channel is {@link EmailService.sendPasswordReset}
   * above. A narrow, explicitly-gated local-development exception exists
   * below (`AUTH_EXPOSE_RESET_TOKEN`) for a developer with no mail transport
   * configured — it logs the token, it never returns it, and production
   * refuses to boot if the flag is left on (see env.validation.ts).
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    // Uniform: no identity, no outcome — the log must not reveal whether an
    // account exists any more than the response does.
    this.logger.log({
      event: LOG_EVENT.AUTH_PASSWORD_RESET_REQUESTED,
      message: 'Password reset requested',
    });
    // 009-auth-abuse-resistance (ZT-006) — enforced as the FIRST statement,
    // before tenant resolution, the account lookup, token generation, the
    // row write and dispatch (FR-061a). Subject is the normalized email plus
    // the RAW submitted tenant qualifier (not a DB-resolved id) when one is
    // supplied: the qualifier is already a stable per-tenant identifier on
    // its own, so incorporating it into the key needs no database round-trip
    // — keeping the limiter check itself free of any DB read, matching
    // "before resolveTenantId" literally as well as in spirit.
    const forgotSubject = this.abuseSubjectDigest(
      dto.tenantSlug
        ? `${this.normalizeEmail(dto.email)}:${dto.tenantSlug.trim().toLowerCase()}`
        : this.normalizeEmail(dto.email),
    );
    // No NODE_ENV==='test' relaxation on this bound (unlike
    // PUBLIC_WEBHOOK_THROTTLE / the app-wide default) — precedent is
    // LoginProtectionService, whose threshold is likewise never
    // environment-relaxed: this endpoint's OWN dedicated e2e suite exists
    // specifically to exercise real threshold/degraded behaviour, exactly
    // like login-protection.e2e-spec.ts does, via an env-setup file that
    // overrides AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW/_WINDOW_SECONDS to fast
    // test values (see test/utils/auth-abuse-forgot-password-env.setup.ts).
    // FR-021's "existing suites continue to pass" is satisfied empirically:
    // no other e2e spec calls this endpoint at all (grep confirmed), so
    // there is nothing for a relaxation to protect here.
    const forgotDecision = await this.limiter.consume(
      AUTH_ABUSE_LIMITER_SCOPE.FORGOT,
      forgotSubject,
      this.config.get<number>('AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW', 5),
      this.config.get<number>('AUTH_FORGOT_PASSWORD_WINDOW_SECONDS', 900),
    );
    if (!forgotDecision.allowed) {
      if (forgotDecision.degraded) {
        // Degraded mode: silently suppress rather than refuse (FR-062,
        // FR-062a) — nothing in status, body, headers or wording may
        // distinguish this from an ordinary below-threshold success.
        this.metrics.recordAuthAbuseLimiterEvent(
          AUTH_ABUSE_LIMITER_SCOPE.FORGOT,
          'suppressed',
        );
        return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
      }
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many requests. Please try again later.',
      });
    }

    // ZT-010 — resolve the qualifier ONLY when one was supplied. The old
    // `.catch(() => null)` swallowed BOTH "no slug given" and "slug given
    // but unresolvable" into the same `null`, which — once the unscoped
    // lookup below stops being restricted to `tenant IS NULL` — would
    // silently WIDEN an unresolvable qualifier into an all-scope search.
    // A supplied-but-unresolvable qualifier must return the uniform
    // response with no reset instead (FR-003).
    let tenantId: string | null = null;
    if (dto.tenantSlug) {
      try {
        tenantId = await this.resolveTenantId(dto.tenantSlug);
      } catch {
        return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
      }
    }
    const email = this.normalizeEmail(dto.email);

    // ZT-010 — with NO qualifier, resolve by normalized email across every
    // scope (platform + all tenants), mirroring `validateCredentials`
    // (:391-444) instead of the old `tenant IS NULL` restriction, which
    // could only ever match platform super-admins. `find` rather than
    // `findOne` so a multiplicity violation is DETECTED rather than
    // silently resolved by picking the first row — `uq_user_email_global`
    // (GlobalUserEmailUniqueness migration) guarantees at most one live
    // match, so this is a defensive branch, not an expected path (FR-005).
    const candidates = await this.users.find({
      where: tenantId ? { email, tenant: { id: tenantId } } : { email },
    });

    if (candidates.length === 0) {
      return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
    }
    if (candidates.length > 1) {
      // The global uniqueness invariant has been lost. Never select
      // arbitrarily and never send a reset to any of the matched rows —
      // record a safe, identity-free observability signal instead.
      this.metrics.recordAuthRecoveryEvent('multiplicity_violation');
      return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
    }
    const user = candidates[0];

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
    const resetUrl = this.passwordSetupUrl(rawToken);
    await this.email.sendPasswordReset({
      to: dto.email,
      name: user.full_name ?? undefined,
      resetUrl,
      token: rawToken,
      tenantId: tenantId ?? undefined,
      // FR-H014/T156 gap-closure: the user row is already loaded here, so
      // honoring their recorded locale (M-08) is a free, no-risk win — falls
      // back to EMAIL_DEFAULT_LOCALE exactly as before when unset.
      locale: user.preferred_locale ?? undefined,
    });

    // Local-development-only fallback for a developer with no mail transport
    // configured: logs the token (never returns it). Requires BOTH the
    // explicit opt-in flag AND a non-production environment — production
    // cannot reach this branch at all (env.validation.ts refuses to boot
    // with the flag on in production), so this is not a runtime risk.
    if (
      this.config.get<string>('AUTH_EXPOSE_RESET_TOKEN') === 'true' &&
      this.config.get<string>('NODE_ENV') !== 'production'
    ) {
      this.logger.warn(
        `AUTH_EXPOSE_RESET_TOKEN is enabled — reset token for user ${user.id}: ${rawToken} (development only, never logged in production)`,
      );
    }

    return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
  }

  /**
   * Issues a single-use "set your password" token for an EXISTING user and
   * returns the raw token so the caller can deliver it (e.g. the staff
   * dashboard-access invitation email).
   *
   * Deliberately reuses the exact `password_resets` table, hashing and TTL
   * mechanics as {@link forgotPassword} — and therefore the same
   * `POST /auth/reset-password` consumption path — so there is only ever ONE
   * credential-setup mechanism in the system. Only the raw token is returned;
   * it is never persisted in plaintext and never logged.
   *
   * Unlike `forgotPassword` this takes a resolved user id (the caller has
   * already proven tenant ownership), so it does not need enumeration
   * protection.
   */
  async issuePasswordSetupToken(
    userId: string,
    ttlMinutes?: number,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const ttl =
      ttlMinutes ??
      this.config.get<number>('STAFF_INVITATION_TTL_MIN', 60 * 24 * 7); // 7 days

    await this.passwordResets.save(
      this.passwordResets.create({
        user: { id: userId } as User,
        token_hash: this.hashToken(rawToken),
        expires_at: new Date(Date.now() + ttl * 60_000),
      }),
    );

    return rawToken;
  }

  /**
   * Marks every unused set-password / reset token of a user as used, so only
   * the link issued next (or none) can still be redeemed. One set-based UPDATE.
   */
  async invalidatePasswordSetupTokens(
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource.manager)
      .createQueryBuilder()
      .update(PasswordReset)
      .set({ used_at: new Date() })
      .where('"userId" = :userId AND used_at IS NULL', { userId })
      .execute();
  }

  /** Absolute URL of the set-password / reset-password screen for a raw token. */
  passwordSetupUrl(rawToken: string): string {
    return `${this.appUrl()}/auth/reset-password?token=${rawToken}`;
  }

  /** Absolute URL of the sign-in screen — the CTA for a delivered temporary password. */
  loginUrl(): string {
    return `${this.appUrl()}/auth/login`;
  }

  /** Consumes a reset token, sets the new password and kills all sessions. */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    // 009-auth-abuse-resistance (ZT-006) — coarse failure-only ceiling,
    // READ (never incremented here) before the token lookup (FR-064). A
    // random-token flood cannot be bounded by a per-token key — a fresh
    // token produces a fresh key every attempt — so this is deliberately a
    // single endpoint-wide counter (AUTH_ABUSE_ENDPOINT_WIDE_SUBJECT),
    // completely separate from the account-target layer below (FR-069).
    const resetWindowSeconds = this.config.get<number>(
      'AUTH_RESET_PASSWORD_WINDOW_SECONDS',
      900,
    );
    const invalidCeilingLimit = this.config.get<number>(
      'AUTH_RESET_PASSWORD_INVALID_CEILING',
      100,
    );
    const invalidCeilingPeek = await this.limiter.peek(
      AUTH_ABUSE_LIMITER_SCOPE.RESET_INVALID,
      AUTH_ABUSE_ENDPOINT_WIDE_SUBJECT,
      invalidCeilingLimit,
      resetWindowSeconds,
    );
    if (!invalidCeilingPeek.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many requests. Please try again later.',
      });
    }

    const reset = await this.passwordResets.findOne({
      where: { token_hash: this.hashToken(dto.token), used_at: IsNull() },
      relations: { user: true },
    });

    if (!reset || reset.expires_at.getTime() < Date.now() || !reset.user) {
      // FR-064 — increment the failure-only ceiling. Never logs `dto.token`
      // (FR-065a) — nothing below ever touches the raw value; `hashToken`
      // above already only ever produced a SHA-256 digest for the DB query.
      //
      // The earlier peek() is a fast, mostly-accurate PRE-filter (skips the
      // DB lookup entirely once clearly over budget) but is not itself a
      // reservation: concurrent requests can all read the same
      // pre-increment count and all pass it together (proved by
      // auth-abuse-reset-password.e2e-spec.ts's T093 racing 6 concurrent
      // invalid attempts at the last remaining slot before this check
      // existed). The atomic INCR inside consume() is what actually
      // serializes concurrent attempts, so its OWN result — not a blanket
      // 400 — is what decides the response here (FR-017).
      const invalidConsume = await this.limiter.consume(
        AUTH_ABUSE_LIMITER_SCOPE.RESET_INVALID,
        AUTH_ABUSE_ENDPOINT_WIDE_SUBJECT,
        invalidCeilingLimit,
        resetWindowSeconds,
      );
      if (!invalidConsume.allowed) {
        throw new AppError(ErrorCode.RATE_LIMITED, {
          message: 'Too many requests. Please try again later.',
        });
      }
      throw new AppError(ErrorCode.INVALID_RESET_TOKEN);
    }

    // FR-063/FR-011c — account-target bound keyed on the user id the lookup
    // above already resolved. No additional database lookup is introduced.
    // A successful reset never reaches the RESET_INVALID branch above, so it
    // structurally cannot consume the failure-only ceiling (FR-064).
    const accountDecision = await this.limiter.consume(
      AUTH_ABUSE_LIMITER_SCOPE.RESET_ACCOUNT,
      this.abuseSubjectDigest(reset.user.id),
      this.config.get<number>('AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT', 10),
      resetWindowSeconds,
    );
    if (!accountDecision.allowed) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many requests. Please try again later.',
      });
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.dataSource.transaction(async (manager) => {
      // Claim the token FIRST, conditionally: of two simultaneous submissions of
      // the same token exactly one gets `affected = 1`; the other rolls back here
      // without having touched the password.
      const claimed = await manager.update(
        PasswordReset,
        { id: reset.id, used_at: IsNull() },
        { used_at: new Date() },
      );
      if (!claimed.affected) {
        throw new AppError(ErrorCode.INVALID_RESET_TOKEN);
      }
      await manager.update(
        User,
        { id: reset.user.id },
        { password_hash: passwordHash },
      );
      // Any other outstanding invitation / reset link would let a stale email
      // set the password again after this one, so they die with it.
      await this.invalidatePasswordSetupTokens(reset.user.id, manager);
    });

    await this.revokeAllForUser(reset.user.id);
    this.logger.log({
      event: LOG_EVENT.AUTH_PASSWORD_RESET_COMPLETED,
      message: 'Password reset completed; all sessions revoked',
      user_id: reset.user.id,
    });
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

    const matches = await bcrypt.compare(
      dto.currentPassword,
      user.password_hash,
    );
    if (!matches) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Current password is incorrect',
      });
    }

    user.password_hash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.users.save(user);
    await this.revokeAllForUser(userId);
    this.logger.log({
      event: LOG_EVENT.AUTH_PASSWORD_CHANGED,
      message: 'Password changed; all sessions revoked',
      user_id: userId,
    });
  }

  // ----------------------------------------------------------------------- //
  // Principal resolution (used by JwtStrategy)
  // ----------------------------------------------------------------------- //

  /**
   * Loads a user with its roles and the permissions granted through them, and
   * flattens everything into the principal that guards consume.
   */
  async buildAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
    const { principal } = await this.loadPrincipal(userId);
    return principal;
  }

  /**
   * Same resolution as `buildAuthenticatedUser`, additionally returning the
   * `Tenant` row this same lookup already loaded (PERF-BE-003). HTTP-only:
   * `JwtStrategy` uses this to hand the already-loaded tenant to
   * `ActiveTenantGuard`, which otherwise re-queries the identical tenant by
   * id a second time (confirmed via live query-log capture, T146/T147). The
   * tenant is returned as a second value, never merged into the
   * `AuthenticatedUser` principal itself, so it can never leak through
   * `GET /auth/me` or anywhere else that returns the principal as-is.
   */
  async buildAuthenticatedUserWithTenant(
    userId: string,
  ): Promise<{ principal: AuthenticatedUser; tenant: Tenant | null }> {
    const { tenant, principal } = await this.loadPrincipal(userId);
    return { principal, tenant };
  }

  private async loadPrincipal(
    userId: string,
  ): Promise<{ tenant: Tenant | null; principal: AuthenticatedUser }> {
    type PrincipalRow = {
      userId: string;
      userIsActive: boolean;
      userEmail: string | null;
      userFullName: string | null;
      tenantId: string | null;
      tenantName: string | null;
      tenantSlug: string | null;
      tenantLogoUrl: string | null;
      tenantCommercialRegistrationNumber: string | null;
      tenantLegalName: string | null;
      tenantContactEmail: string | null;
      tenantContactPhone: string | null;
      tenantCountryId: number | null;
      tenantDefaultCurrency: string | null;
      tenantDefaultTimezone: string | null;
      tenantApprovalStatus: Tenant['approval_status'] | null;
      tenantIsActive: boolean | null;
      tenantCreatedAt: Date | null;
      tenantUpdatedAt: Date | null;
      tenantDeletedAt: Date | null;
      roleSlug: string | null;
      permissionSlug: string | null;
    };

    // ONE query, explicit narrow columns, no `take`/`skip` — a plain
    // `Repository.findOne`/`findOneBy` unconditionally sets `take: 1`, which
    // (combined with these joins) forces TypeORM's DISTINCT-id-then-hydrate
    // branch: 2 round trips (research.md R-01/R-10). A query builder that
    // never sets take/skip/limit/offset stays in the single-query path, and
    // filtering on the primary key already bounds the result to one user.
    const rows = await this.users
      .createQueryBuilder('u')
      .leftJoin('u.tenant', 't')
      .leftJoin('u.userRoles', 'ur')
      .leftJoin('ur.role', 'r')
      .leftJoin('r.rolePermissions', 'rp')
      .leftJoin('rp.permission', 'p')
      .select('u.id', 'userId')
      .addSelect('u.is_active', 'userIsActive')
      .addSelect('u.email', 'userEmail')
      .addSelect('u.full_name', 'userFullName')
      .addSelect('t.id', 'tenantId')
      .addSelect('t.name', 'tenantName')
      .addSelect('t.slug', 'tenantSlug')
      .addSelect('t.logo_url', 'tenantLogoUrl')
      .addSelect(
        't.commercial_registration_number',
        'tenantCommercialRegistrationNumber',
      )
      .addSelect('t.legal_name', 'tenantLegalName')
      .addSelect('t.contact_email', 'tenantContactEmail')
      .addSelect('t.contact_phone', 'tenantContactPhone')
      .addSelect('t.country_id', 'tenantCountryId')
      .addSelect('t.default_currency', 'tenantDefaultCurrency')
      .addSelect('t.default_timezone', 'tenantDefaultTimezone')
      .addSelect('t.approval_status', 'tenantApprovalStatus')
      .addSelect('t.is_active', 'tenantIsActive')
      .addSelect('t.created_at', 'tenantCreatedAt')
      .addSelect('t.updated_at', 'tenantUpdatedAt')
      .addSelect('t.deleted_at', 'tenantDeletedAt')
      .addSelect('r.slug', 'roleSlug')
      .addSelect('p.slug', 'permissionSlug')
      .where('u.id = :id', { id: userId })
      .getRawMany<PrincipalRow>();

    const first = rows[0];
    if (!first || !first.userIsActive) {
      throw new AppError(ErrorCode.USER_INACTIVE);
    }

    const roleSlugs = new Set<string>();
    const permissionSlugs = new Set<string>();
    for (const row of rows) {
      if (row.roleSlug) roleSlugs.add(row.roleSlug);
      if (row.permissionSlug) permissionSlugs.add(row.permissionSlug);
    }

    // Folded from the same row set as the principal, never a second query —
    // and returned separately (never merged into `principal`) so it can never
    // leak through GET /auth/me or anywhere else that serializes the
    // principal as-is.
    const tenant: Tenant | null = first.tenantId
      ? ({
          id: first.tenantId,
          name: first.tenantName,
          slug: first.tenantSlug,
          logo_url: first.tenantLogoUrl ?? undefined,
          commercial_registration_number:
            first.tenantCommercialRegistrationNumber ?? undefined,
          legal_name: first.tenantLegalName ?? undefined,
          contact_email: first.tenantContactEmail ?? undefined,
          contact_phone: first.tenantContactPhone ?? undefined,
          country_id: first.tenantCountryId ?? undefined,
          default_currency: first.tenantDefaultCurrency as string,
          default_timezone: first.tenantDefaultTimezone as string,
          approval_status:
            first.tenantApprovalStatus as Tenant['approval_status'],
          is_active: !!first.tenantIsActive,
          created_at: first.tenantCreatedAt as Date,
          updated_at: first.tenantUpdatedAt as Date,
          deleted_at: first.tenantDeletedAt as Date,
        } as Tenant)
      : null;

    return {
      tenant,
      principal: {
        id: first.userId,
        tenantId: tenant?.id ?? null,
        email: first.userEmail ?? null,
        fullName: first.userFullName ?? null,
        roles: [...roleSlugs],
        permissions: [...permissionSlugs],
      },
    };
  }

  // ----------------------------------------------------------------------- //
  // Internal helpers
  // ----------------------------------------------------------------------- //

  /**
   * Resolves a seeded SYSTEM role (tenant IS NULL) inside a transaction.
   * Throws if the role isn't seeded, so a user is never left without a role.
   * Used by registerOwner (always `owner`) and createTenantUser
   * (manager/receptionist only) — both need strictly the shared system role,
   * never a tenant's own custom role that happens to share the slug.
   */
  private async resolveSystemRole(
    manager: EntityManager,
    slug: RoleSlug,
  ): Promise<Role> {
    const role = await manager.findOne(Role, {
      where: { slug, tenant: IsNull() },
    });
    if (!role) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND, {
        message: `System role "${slug}" is not seeded`,
      });
    }
    return role;
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
    lineage?: RefreshLineage,
  ): Promise<AuthResult> {
    const principal = await this.buildAuthenticatedUser(userId);
    const tokens = await this.issueTokens(
      userId,
      principal.tenantId,
      context,
      lineage,
    );
    return {
      ...tokens,
      user: {
        id: principal.id,
        tenantId: principal.tenantId,
        email: principal.email,
        fullName: principal.fullName,
        roles: principal.roles,
        permissions: principal.permissions,
      },
    };
  }

  /**
   * Signs an access token and a persisted, rotating refresh token.
   *
   * `lineage` is supplied ONLY by {@link refresh}, which has already reserved
   * the child's id and knows the family to continue. Every other caller (login,
   * owner registration, patient registration) omits it and therefore starts a
   * NEW family rooted at its own id — one login, one device chain, which is
   * exactly the scope reuse detection revokes.
   */
  private async issueTokens(
    userId: string,
    tenantId: string | null,
    context?: TokenContext,
    lineage?: RefreshLineage,
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL', '7d');

    // P1.2 (MS-008) — ±10% jitter on the ACCESS token's actual lifetime only
    // (never the refresh token, already naturally staggered by per-login
    // rotation). A population of clients that authenticated together —
    // normal traffic, or every session invalidated at once by a deploy or a
    // Redis flush — otherwise expires together too, producing exactly the
    // synchronized mass-reauth burst MS-008 measured: 400 simultaneous
    // logins serialized bcrypt work into minutes of blocked event loop.
    // Freshly randomized on EVERY issuance (not derived from the user id),
    // because the goal is de-synchronizing a COHORT's expiry moments, not
    // giving one user a stable-but-different TTL. `accessTtlSeconds` is
    // used for BOTH the actual JWT `exp` claim and the `expiresIn` the
    // client is told, so they can never disagree.
    //
    // A base of 0 (JWT_ACCESS_TTL unparseable by `ttlToMs`'s defensive
    // no-match branch) is left as exactly 0, not jittered up to 1 — that is
    // a pre-existing, deliberately-tested fallback (a misconfigured TTL
    // fails toward an immediately-expired token, not a token that silently
    // lives for ~1 second), and jitter must never change what a
    // misconfiguration produces.
    const baseAccessTtlMs = this.ttlToMs(accessTtl);
    const accessTtlSeconds =
      baseAccessTtlMs === 0
        ? 0
        : Math.max(
            1,
            Math.round(
              (baseAccessTtlMs * (1 + (Math.random() * 0.2 - 0.1))) / 1000,
            ),
          );

    // Reserve the refresh-token row id so it can be embedded as the jti. On a
    // rotation the id was already reserved by `refresh()` and written into the
    // parent's `replaced_by_id` — reuse it rather than minting a second one.
    const jti = lineage?.jti ?? randomUUID();
    // A login roots its own family at its own id; a rotation continues its
    // parent's. This is the whole basis of family-scoped revocation — and the
    // access token names the same family as its session (`sid`), so revoking
    // the family ends the access token too (SEC-02).
    const familyId = lineage?.familyId ?? jti;

    const accessPayload: JwtPayload = {
      sub: userId,
      tenantId,
      type: 'access',
      sid: familyId,
    };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessTtlSeconds,
    });

    const refreshPayload: RefreshTokenPayload = {
      sub: userId,
      tenantId,
      jti,
      type: 'refresh',
    };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshTtl as JwtSignOptions['expiresIn'],
    });

    await this.refreshTokens.save(
      this.refreshTokens.create({
        id: jti,
        user: { id: userId } as User,
        token_hash: this.hashToken(refreshToken),
        family_id: familyId,
        parent_id: lineage?.parentId ?? null,
        device_info: context?.deviceInfo,
        ip_address: context?.ipAddress,
        expires_at: new Date(Date.now() + this.ttlToMs(refreshTtl)),
      }),
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: accessTtlSeconds,
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

  /**
   * Shared digest for every abuse-limiter subject in this service
   * (009-auth-abuse-resistance) — a cryptographic hash of an already
   * server-normalized value. Raw email/token values never reach
   * `FixedWindowLimiterService` or the Redis key it builds (FR-013b).
   */
  private abuseSubjectDigest(subject: string): string {
    return createHash('sha256').update(subject).digest('hex');
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

/**
 * Rotation lineage for a refresh token that CONTINUES an existing session
 * chain. Supplied only by {@link AuthService.refresh}; omitting it starts a new
 * family (see `issueTokens`).
 */
interface RefreshLineage {
  /** Id reserved before the atomic claim and already recorded as the parent's `replaced_by_id`. */
  jti: string;
  /** The family this rotation continues — inherited, never regenerated. */
  familyId: string;
  /** The row rotated from. */
  parentId: string;
}
