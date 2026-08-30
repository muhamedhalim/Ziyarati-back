import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';
import { AppError, ErrorCode } from '../../common/errors';

import { UnsubscribeService } from './unsubscribe.service';
import {
  UNSUBSCRIBE_CONFIRM_THROTTLE,
  UNSUBSCRIBE_RESOLVE_THROTTLE,
} from './unsubscribe.constants';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T134),
 * `contracts/public-surfaces.md` §D.
 *
 * `@Public()`: authorised by the token itself (a signed (tenant, email)
 * pair — see `UnsubscribeTokenService`), never a tenant principal or a
 * signed-in session (FR-E006 — must work without signing in).
 *
 * T026A entitlement decision: PLATFORM_AND_PUBLIC_SURFACES — carries NEITHER
 * `@RequireFeature` nor `@NoEntitlementRequired`. A recipient must be able to
 * unsubscribe regardless of the clinic's billing/subscription state, exactly
 * like `public-booking.controller.ts` — see
 * `controller-entitlement-coverage.spec.ts`.
 */
@ApiTags('Public — Unsubscribe')
@Controller('public/unsubscribe')
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Public()
  @Throttle(UNSUBSCRIBE_RESOLVE_THROTTLE)
  @Get(':token')
  async resolve(@Param('token') token: string) {
    const view = await this.unsubscribe.resolve(token);
    if (!view) this.throwNotFound();
    return view;
  }

  @Public()
  @SkipCsrf()
  @Throttle(UNSUBSCRIBE_CONFIRM_THROTTLE)
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  async confirm(@Param('token') token: string) {
    const result = await this.unsubscribe.confirm(token);
    if (!result) this.throwNotFound();
    return result;
  }

  private throwNotFound(): never {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: 'This link is invalid or no longer active.',
    });
  }
}
