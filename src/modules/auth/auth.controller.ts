import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthService, TokenContext } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

import { Public } from './decorators/public.decorator';
import { RequirePermissions } from './decorators/permissions.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { PermissionsGuard } from './guards/permissions.guard';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { PERMISSION } from '../../rbac/rbac.constants';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Creates a user. Protected: requires `users.manage`. A tenant admin may only
   * create users inside their own tenant; only a super-admin (tenantId null)
   * may target another tenant or provision another super-admin.
   *
   * NOTE: this is an administrative endpoint, NOT public self-signup. The first
   * platform super-admin is provisioned by the seeder (`npm run seed`), so no
   * public bootstrap route is needed. If end-user self-registration is required
   * later, add a separate @Public() endpoint that hard-codes the `customer`
   * role and forbids `tenantId`/super-admin creation.
   */
  @Post('register')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(PERMISSION.USERS_MANAGE)
  register(@Body() dto: RegisterDto, @CurrentUser() actor: AuthenticatedUser) {
    if (actor.tenantId !== null) {
      // Non-super-admins are pinned to their own tenant.
      dto.tenantId = actor.tenantId;
    }
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, this.tokenContext(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, this.tokenContext(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }

  /** Returns the current principal (id, tenant, roles, permissions). */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  /** Revokes every active session for the current user (global logout). */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  logoutAll(@CurrentUser('id') userId: string) {
    return this.authService.revokeAllForUser(userId);
  }

  private tokenContext(req: Request): TokenContext {
    return {
      ipAddress: req.ip,
      deviceInfo: req.headers['user-agent'],
    };
  }
}
