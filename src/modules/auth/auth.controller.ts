import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthService, TokenContext } from './auth.service';
import { PatientService } from './patient.service';
import { RegisterOwnerDto } from './dto/register-owner.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { RegisterPatientDto } from './dto/register-patient.dto';
import { LoginDto } from './dto/login.dto';
import { CookieService } from './cookie.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

import { Public } from './decorators/public.decorator';
import { SkipCsrf } from './decorators/skip-csrf.decorator';
import { RequirePermissions } from './decorators/permissions.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { PERMISSION } from '../../rbac/rbac.constants';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AppError } from 'src/common/errors/app-error';
import { ErrorCode } from 'src/common/errors/error-code';

// ─── Reusable inline response schema fragments ────────────────────────────────

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: 400 },
    errorCode: { type: 'string', example: 'VALIDATION_ERROR' },
    message: { type: 'string', example: 'Validation failed' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const S_PERMISSION_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string', example: 'users.manage' },
    name: { type: 'string', example: 'Manage Users' },
  },
};

const S_ROLE_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string', example: 'owner' },
    name: { type: 'string', example: 'Clinic Owner' },
    permissions: { type: 'array', items: S_PERMISSION_ITEM },
  },
};

const S_AUTH_USER = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', example: 'a1b2c3d4-0000-0000-0000-000000000001' },
    email: { type: 'string', format: 'email', example: 'owner@al-noor.com' },
    fullName: { type: 'string', example: 'Dr. Ahmed Hassan' },
    phone: { type: 'string', example: '+966501234567', nullable: true },
    tenantId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description: 'null only for super-admin accounts',
    },
    roles: { type: 'array', items: S_ROLE_ITEM },
  },
};

const S_TENANT_SUMMARY = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Al-Noor Clinic' },
    slug: { type: 'string', example: 'al-noor-clinic' },
    approvalStatus: {
      type: 'string',
      enum: ['pending', 'approved', 'rejected', 'suspended'],
      example: 'pending',
    },
    isActive: { type: 'boolean', example: false },
  },
};

const S_TOKEN_PAIR = {
  accessToken: {
    type: 'string',
    description:
      'Short-lived JWT access token (~15 min). Send as `Authorization: Bearer <token>` on every protected request.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  },
  refreshToken: {
    type: 'string',
    description:
      'Long-lived JWT refresh token (~7 days). Use ONLY at POST /auth/refresh to rotate the pair. Never send it as a bearer token.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  },
};

// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('Authentication')
@Controller('auth')
@ApiBearerAuth('JWT-auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly patientService: PatientService,
    private readonly cookies: CookieService,
  ) {}

  // ────────────────────────── Clinic onboarding ──────────────────────────── //

  @ApiOperation({
    summary: 'Register a new clinic (tenant onboarding)',
    description: `
**Public endpoint — no authentication required.**

Creates a new Clinic (Tenant) and its first user atomically in a single
database transaction:

1. Creates the Tenant with \`approvalStatus = pending\`
2. Creates the Owner user and assigns the system \`owner\` role
3. Creates default TenantSettings
4. Records the initial \`pending\` approval event
5. Issues an access + refresh token pair

**Important:** The clinic is **not yet active** after registration.
A super-admin must approve it via \`POST /tenants/:id/approve\` before
staff can access tenant-protected routes (ActiveTenantGuard will return 403
until the tenant is approved and active).

**Business rules:**
- The \`slug\` uniquely identifies the clinic platform-wide and is used
  at login (the \`tenantSlug\` field). It is **immutable** after creation.
- \`commercialRegistrationNumber\` is mandatory for compliance.
- Both email and slug must be globally unique.

**Who can call this:** Anyone (unauthenticated). Intended for the
public clinic sign-up page.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Clinic and owner user created. Tenant approval is pending.',
    schema: {
      type: 'object',
      properties: {
        user: S_AUTH_USER,
        tenant: S_TENANT_SUMMARY,
        ...S_TOKEN_PAIR,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed — missing required fields, invalid email, weak password (< 8 chars), or invalid slug format (must be lowercase alphanumeric with dashes).',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Email address or clinic slug is already registered.',
    schema: S_ERROR,
  })
  @Public()
  @SkipCsrf()
  @Post('register-owner')
  async registerOwner(
    @Body() dto: RegisterOwnerDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Owner onboarding auto-logs-in → same cookie treatment as login.
    // Tokens are set as HttpOnly cookies, never returned in the JSON body.
    const result = await this.authService.registerOwner(
      dto,
      this.tokenContext(req),
    );
    this.cookies.setAuthCookies(res, result);
    this.cookies.setCsrfCookie(res);
    return { user: result.user };
  }

  // ────────────────────────── Staff creation ─────────────────────────────── //

  @ApiOperation({
    summary: 'Create a staff member in the caller\'s clinic',
    description: `
**Protected — requires \`users.manage\` permission.**

Creates a new staff user inside the **caller's own tenant**. The tenant
context is taken exclusively from the authenticated JWT principal — it
cannot be overridden via the request body or URL parameters.

**Allowed \`roleSlug\` values:** \`manager\`, \`receptionist\` only.
Privileged roles (\`owner\`, \`super_admin\`) are blocked at both DTO
validation and the service layer to prevent privilege escalation. Omitting
\`roleSlug\` defaults to \`receptionist\`.

**Side effects:**
- The new user receives the specified role immediately.
- No email invitation is sent by this endpoint alone (notification
  can be layered on top via events).

**Who can call this:** Clinic Owner or Manager holding the \`users.manage\`
permission.

**Tenant scoping:** The new user is always bound to the caller's tenant.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Staff member created and role assigned.',
    schema: {
      type: 'object',
      properties: { user: S_AUTH_USER },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed, or \`roleSlug\` is not an assignable staff role (only `manager`/`receptionist` are allowed).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description:
      'Caller lacks the \`users.manage\` permission, attempted to assign a privileged role, or the caller has no tenant context (super-admin cannot create clinic staff this way).',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Email address already exists within this clinic.',
    schema: S_ERROR,
  })
  @Post('register-user')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(PERMISSION.USERS_MANAGE)
  registerUser(
    @Body() dto: RegisterUserDto,
    @CurrentUser('tenantId') tenantId: string | null,
  ) {
    if (!tenantId) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Tenant context is required',
      });
    }

    return this.authService.createTenantUser(dto, tenantId);
  }

  // ────────────────────────── Patient signup ─────────────────────────────── //

  @ApiOperation({
    summary: 'Register as a patient (B2C)',
    description: `
**Public endpoint — no authentication required.**

Creates a standalone patient account with **no tenant affiliation and no
RBAC roles**. Patients are completely isolated from the clinic staff/owner
model — they live in a separate \`patients\` table.

The returned tokens carry \`type: "patient"\` in the JWT payload and are
**automatically rejected by all tenant/staff endpoints** (JwtStrategy
rejects any token whose \`type !== "access"\`). Patient tokens can only be
used with patient-specific routes (e.g. appointment booking portal).

**Who can call this:** Anyone (unauthenticated). Intended for the
patient-facing mobile app or booking portal.
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Patient account created. Returns a patient-scoped token pair.',
    schema: {
      type: 'object',
      properties: {
        patient: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email', example: 'patient@example.com' },
            fullName: { type: 'string', example: 'Sara Al-Amin' },
            phone: { type: 'string', example: '+966509876543', nullable: true },
          },
        },
        ...S_TOKEN_PAIR,
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiConflictResponse({
    description: 'Email address is already registered as a patient.',
    schema: S_ERROR,
  })
  @Public()
  @SkipCsrf()
  @Post('register-patient')
  registerPatient(@Body() dto: RegisterPatientDto) {
    return this.patientService.registerPatient(dto);
  }

  // ───────────────────────────── Login ───────────────────────────────────── //

  @ApiOperation({
    summary: 'Log in',
    description: `
**Public endpoint — no authentication required.**

Validates credentials and issues an access + refresh token pair.

**Staff / Owner login:** Provide \`tenantSlug\` to identify the clinic.
Email uniqueness is scoped per-tenant, so the same email address can
exist in multiple clinics; \`tenantSlug\` disambiguates which account
is meant.

**Super-admin login:** Omit \`tenantSlug\` entirely. The system looks
for a user with \`tenant_id IS NULL\`. Super-admin accounts are created
only via the seeder.

**Token lifetimes (configurable):**
- Access token: ~15 min (\`JWT_EXPIRES_IN\`)
- Refresh token: ~7 days (\`JWT_REFRESH_EXPIRES_IN\`)

The \`User-Agent\` header and client IP are recorded on the refresh
token row for security audit purposes.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Login successful. Returns the authenticated user principal and token pair.',
    schema: {
      type: 'object',
      properties: {
        user: S_AUTH_USER,
        ...S_TOKEN_PAIR,
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description:
      'Invalid email/password, account not found, account is inactive, or \`tenantSlug\` does not match the account.',
    schema: S_ERROR,
  })
  @Public()
  @SkipCsrf()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, this.tokenContext(req));
    // Set HttpOnly auth cookies + the readable CSRF token. Tokens are NEVER
    // returned in the JSON body.
    this.cookies.setAuthCookies(res, result);
    this.cookies.setCsrfCookie(res);
    return { user: result.user };
  }

  // ──────────────────────────── Token refresh ────────────────────────────── //

  @ApiOperation({
    summary: 'Refresh the access token',
    description: `
**Public endpoint — uses the refresh token directly (not a bearer token).**

Rotates the token pair: the provided refresh token is cryptographically
verified, then revoked, and a fresh access + refresh pair is issued.
This is **one-time-use** (replay prevention) — using the same refresh
token twice will return 401.

**Recommended client flow:**
1. Access token expires → receive \`401\` from a protected endpoint.
2. Call \`POST /auth/refresh\` with the stored refresh token.
3. Persist the new pair; discard the old refresh token immediately.
4. Retry the original request with the new access token.

Do **not** send the refresh token as an \`Authorization: Bearer\` header
on other endpoints — it will be rejected (\`type !== "access"\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Token pair rotated. Old refresh token is now invalid.',
    schema: {
      type: 'object',
      properties: {
        user: S_AUTH_USER,
        ...S_TOKEN_PAIR,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'The value provided is not a valid JWT string.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Refresh token is expired, revoked, not found, or has already been used (replay).',
    schema: S_ERROR,
  })
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Refresh token comes from the HttpOnly cookie — never the request body.
    const token = req.cookies?.[CookieService.REFRESH_COOKIE] as
      | string
      | undefined;
    if (!token) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const result = await this.authService.refresh(
      token,
      this.tokenContext(req),
    );
    this.cookies.setAuthCookies(res, result);
    this.cookies.setCsrfCookie(res);
    return { user: result.user };
  }

  // ───────────────────────────── Logout ──────────────────────────────────── //

  @ApiOperation({
    summary: 'Log out (revoke current session)',
    description: `
**Public endpoint — identifies the session via the refresh token.**

Revokes the supplied refresh token so it can no longer be used to obtain
new access tokens. The current access token remains technically valid
until its natural expiry (there is no server-side access token revocation
list — keep \`JWT_EXPIRES_IN\` short in production, e.g. 15 minutes).

To invalidate **all sessions** across all devices, use
\`POST /auth/logout-all\` (requires a valid access token).
    `.trim(),
  })
  @ApiNoContentResponse({ description: 'Session revoked. The refresh token is now invalid.' })
  @ApiBadRequestResponse({ description: 'The value is not a valid JWT string.', schema: S_ERROR })
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.[CookieService.REFRESH_COOKIE] as
      | string
      | undefined;
    // Revoke the refresh token server-side (if present), then clear all cookies.
    if (token) {
      await this.authService.logout(token);
    }
    this.cookies.clearAuthCookies(res);
  }

  // ──────────────────────── Password recovery ────────────────────────────── //

  @ApiOperation({
    summary: 'Request a password-reset link',
    description: `
**Public endpoint — no authentication required.**

Triggers the password-reset flow for the given email address. If the
account exists, a short-lived one-time-use reset token is sent via an
out-of-band channel (email / WhatsApp — configured in the notification
module).

**Security:** The response is intentionally identical whether or not
the email exists, preventing user enumeration attacks.

For staff/owner accounts, provide \`tenantSlug\` to scope the lookup
(the same email address can exist in multiple clinics).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Request accepted. A reset link will be sent if the email is registered.',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'If that email is registered, a reset link has been sent.',
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid email format.', schema: S_ERROR })
  @Public()
  @SkipCsrf()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @ApiOperation({
    summary: 'Reset password using a reset token',
    description: `
**Public endpoint — uses the one-time token from the forgot-password flow.**

Validates the reset token (signature + expiry), then updates the user's
password. The token is consumed on use — calling this endpoint twice
with the same token will fail on the second call.

**Side effects:**
- All existing refresh tokens for the user are revoked, forcing
  re-authentication on all devices.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Password updated. All existing sessions have been revoked.',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Password has been reset successfully.',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Token is invalid, expired, or already used; or the new password does not meet requirements (min 8 chars, max 72).',
    schema: S_ERROR,
  })
  @Public()
  @SkipCsrf()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // ──────────────────────── Authenticated password change ────────────────── //

  @ApiOperation({
    summary: 'Change password (while logged in)',
    description: `
**Protected — requires a valid access token.**

Changes the password for the currently authenticated user. The caller
must supply their current password for re-authentication (prevents
password changes by someone who grabbed an unattended session).

**Side effects:**
- All refresh tokens for the user are revoked after the change —
  other devices will need to log in again.

**Who can call this:** Any authenticated user (staff, owner,
super-admin). Patients use a separate endpoint.
    `.trim(),
  })
  @ApiNoContentResponse({ description: 'Password changed. All sessions revoked.' })
  @ApiBadRequestResponse({
    description:
      '`currentPassword` is incorrect, or `newPassword` is too short (< 8 chars) or too long (> 72 chars).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }

  // ─────────────────────────── Current user ──────────────────────────────── //

  @ApiOperation({
    summary: 'Get the current authenticated user',
    description: `
**Protected — requires a valid access token.**

Returns the live principal resolved from the access token: user identity,
tenant association, assigned roles, and effective permissions.

Roles and permissions are **re-fetched from the database on every call**,
so this always reflects the current RBAC state even if roles were modified
after the token was issued.

Useful for the frontend to bootstrap UI permissions without storing
them in local state across reloads.

**Who can call this:** Any authenticated user.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Current user principal with live roles and permissions.',
    schema: S_AUTH_USER,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  // ──────────────────────────── Global logout ────────────────────────────── //

  @ApiOperation({
    summary: 'Log out of all sessions (global logout)',
    description: `
**Protected — requires a valid access token.**

Revokes **every** active refresh token belonging to the current user across
all devices and sessions. Useful after a suspected account compromise or
when the user wants a clean slate.

The current access token remains technically valid until its natural expiry
(no server-side revocation list for access tokens). Shorten
\`JWT_EXPIRES_IN\` in production if immediate access token invalidation
is required.

**Who can call this:** Any authenticated user.
    `.trim(),
  })
  @ApiNoContentResponse({ description: 'All sessions revoked across all devices.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  logoutAll(@CurrentUser('id') userId: string) {
    return this.authService.revokeAllForUser(userId);
  }

  // ─────────────────────────── Private helpers ───────────────────────────── //

  private tokenContext(req: Request): TokenContext {
    return {
      ipAddress: req.ip,
      deviceInfo: req.headers['user-agent'],
    };
  }
}
