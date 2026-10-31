import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

import { AppError, ErrorCode } from '../../../common/errors';
import { MfaService } from '../mfa/mfa.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/** Header carrying a fresh TOTP (or recovery) code for the action being confirmed. */
export const MFA_STEP_UP_HEADER = 'x-mfa-code';

/**
 * PAY-012 — step-up confirmation for platform actions that move or waive money
 * (subscription-invoice refunds, merchant payout-account approval, billing mode,
 * reconciliation edits). A stolen or left-open super-admin session alone is then not
 * enough to do them: the caller must also present a fresh second-factor code.
 *
 *  - OFF unless `MFA_STEP_UP_ENABLED=true`, so shipping the guard changes nothing until
 *    the admin UI can collect the code.
 *  - Applies only to a user who has an ENABLED factor. Someone with none cannot be asked
 *    for one; platform enrolment is made mandatory by `MFA_ENFORCE_FROM` at login instead.
 *  - A missing code answers 403 with `publicContext.mfaStepUp = true` so a client can
 *    prompt and resend; a wrong code is counted and locked by `MfaService.verify`.
 *  - TOTP steps are single-use: the code that signed the user in cannot be replayed here,
 *    the next one (≤ 30 s later) is needed.
 *
 * `MfaService` is resolved lazily through `ModuleRef` so any module can use this guard
 * without importing `AuthModule`.
 */
@Injectable()
export class MfaStepUpGuard implements CanActivate {
  private readonly logger = new Logger(MfaStepUpGuard.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled()) return true;

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user?.id) throw new AppError(ErrorCode.PERMISSION_DENIED);

    const mfa = this.moduleRef.get(MfaService, { strict: false });
    if (!(await mfa.isEnabled(user.id))) {
      // Fail closed: someone whose role must hold a factor but has none (a session that
      // slipped past enforcement) cannot confirm a money-moving action.
      if (mfa.isMandatory(user)) {
        throw new AppError(ErrorCode.FORBIDDEN, {
          message:
            'Two-factor authentication must be set up before this action.',
        });
      }
      return true;
    }

    const raw = request.headers?.[MFA_STEP_UP_HEADER];
    const code = (Array.isArray(raw) ? raw[0] : raw)?.toString().trim();
    if (!code) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'A verification code is required to confirm this action.',
        publicContext: { mfaStepUp: true },
      });
    }

    // A 6-digit TOTP code, otherwise treated as a recovery code.
    await mfa.verify(
      user.id,
      /^\d{6}$/.test(code) ? { code } : { recoveryCode: code },
    );
    this.logger.log({ event: 'auth.mfa.step_up', user_id: user.id });
    return true;
  }

  private enabled(): boolean {
    const raw = this.config.get<string | boolean>('MFA_STEP_UP_ENABLED');
    return (
      raw === true ||
      String(raw ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }
}
