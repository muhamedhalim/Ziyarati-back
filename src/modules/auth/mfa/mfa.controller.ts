import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { getClientAddress } from '../../../config/trust-proxy';
import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import { AuthService, TokenContext } from '../auth.service';
import { CookieService } from '../cookie.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { RolesGuard } from '../guards/roles.guard';
import { NoEntitlementRequired } from '../../subscription-billing/decorators/no-entitlement-required.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';
import { ROLE } from '../../../rbac/rbac.constants';
import { SkipCsrf } from '../decorators/skip-csrf.decorator';
import {
  MfaChallengeDto,
  MfaCodeDto,
  MfaConfirmEnrollDto,
  MfaVerifyDto,
} from './mfa.dto';
import { MfaService } from './mfa.service';

/**
 * P0.5 / TSF-03 — second-factor endpoints.
 *
 * Login-time routes are `@Public()` (no session exists yet) and authenticate
 * with the short-lived challenge token minted after the password was proven.
 * `setup/*` and `disable` are ordinary authenticated routes (CSRF applies).
 */
@ApiTags('Auth — MFA')
// A user's own sign-in security is never gated by the clinic's billing state.
@NoEntitlementRequired(FeatureKey.CORE_WORKSPACE)
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
  ) {}

  private ctx(req: Request): TokenContext {
    return {
      ipAddress: getClientAddress(req),
      deviceInfo: req.headers['user-agent'],
    };
  }

  private async login(userId: string, req: Request, res: Response) {
    const result = await this.auth.finishLogin(userId, this.ctx(req));
    this.cookies.setAuthCookies(res, result);
    this.cookies.setCsrfCookie(res);
    return result.user;
  }

  // ── login-time ─────────────────────────────────────────────────────────

  @Public()
  @SkipCsrf()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Body() dto: MfaVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!dto.code && !dto.recoveryCode) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'A verification code or recovery code is required.',
      });
    }
    const userId = await this.mfa.parseChallenge(
      dto.challengeToken,
      'mfa_verify',
    );
    await this.mfa.verify(userId, {
      code: dto.code,
      recoveryCode: dto.recoveryCode,
    });
    return { user: await this.login(userId, req, res) };
  }

  @Public()
  @SkipCsrf()
  @Post('enroll/start')
  @HttpCode(HttpStatus.OK)
  async enrollStart(@Body() dto: MfaChallengeDto) {
    const userId = await this.mfa.parseChallenge(
      dto.challengeToken,
      'mfa_enroll',
    );
    const principal = await this.auth.buildAuthenticatedUser(userId);
    return this.mfa.startSetup(userId, principal.email ?? userId);
  }

  @Public()
  @SkipCsrf()
  @Post('enroll/confirm')
  @HttpCode(HttpStatus.OK)
  async enrollConfirm(
    @Body() dto: MfaConfirmEnrollDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const userId = await this.mfa.parseChallenge(
      dto.challengeToken,
      'mfa_enroll',
    );
    const recoveryCodes = await this.mfa.confirmSetup(userId, dto.code);
    return { user: await this.login(userId, req, res), recoveryCodes };
  }

  // ── authenticated self-service ─────────────────────────────────────────

  @ApiBearerAuth('JWT-auth')
  @Post('setup/start')
  @HttpCode(HttpStatus.OK)
  async setupStart(@CurrentUser('id') userId: string) {
    const principal = await this.auth.buildAuthenticatedUser(userId);
    return this.mfa.startSetup(userId, principal.email ?? userId);
  }

  @ApiBearerAuth('JWT-auth')
  @Post('setup/confirm')
  @HttpCode(HttpStatus.OK)
  async setupConfirm(
    @CurrentUser('id') userId: string,
    @Body() dto: MfaCodeDto,
  ) {
    return { recoveryCodes: await this.mfa.confirmSetup(userId, dto.code) };
  }

  @ApiBearerAuth('JWT-auth')
  @Post('disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disable(@CurrentUser('id') userId: string, @Body() dto: MfaCodeDto) {
    // A user whose tier is under enforcement cannot remove the factor: they would only
    // be forced to re-enrol at the next login, and a stolen session could strip it.
    const principal = await this.auth.buildAuthenticatedUser(userId);
    if (this.mfa.isMandatory(principal)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message:
          'Two-factor authentication is required for your role and cannot be disabled.',
      });
    }
    await this.mfa.disable(userId, dto.code);
  }

  /**
   * Admin-initiated reset for a user who lost their device and recovery codes.
   * Super-admin only; cannot target yourself (a DIFFERENT super-admin must do
   * it), so a single stolen session cannot silently strip its own second
   * factor. Audited as `platform_admin.mfa.reset`.
   */
  @ApiBearerAuth('JWT-auth')
  @UseGuards(RolesGuard)
  @Roles(ROLE.SUPER_ADMIN)
  @Post('admin-reset/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async adminReset(
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @CurrentUser('id') actorId: string,
  ) {
    await this.mfa.adminReset(targetUserId, actorId);
  }
}
