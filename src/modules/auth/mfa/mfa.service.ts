import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';

import { AppError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-code';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { AuditLog } from '../../../entities/Auth&RBAC/AuditLog';
import { User } from '../../../entities/Auth&RBAC/User';
import { UserMfa } from '../../../entities/Auth&RBAC/UserMfa';
import { UserMfaRecoveryCode } from '../../../entities/Auth&RBAC/UserMfaRecoveryCode';
import { generateSecret, matchStep, otpauthUri } from './totp';

export type MfaChallengePurpose = 'mfa_verify' | 'mfa_enroll';

const CHALLENGE_TTL_SECONDS = 300;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = 'ZiyaraTech';

/**
 * P0.5 / TSF-03 — TOTP second factor.
 *
 * Policy: users with an ENABLED factor must present a code at login. PLATFORM
 * users (tenantId null) become mandatory once `MFA_ENFORCE_FROM` (ISO date) has
 * passed; before that, enrolment is optional so the rollout cannot lock the
 * only platform admin out. Unset = never enforced.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @InjectRepository(UserMfa) private readonly mfa: Repository<UserMfa>,
    @InjectRepository(UserMfaRecoveryCode)
    private readonly recovery: Repository<UserMfaRecoveryCode>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    private readonly crypto: EncryptionService,
    private readonly jwt: JwtService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.mfa.findOne({
      where: { user_id: userId },
      select: { id: true, enabled: true },
    });
    return !!row?.enabled;
  }

  /** True when this principal must have a factor and has none (enforcement date passed). */
  async enrolmentRequired(
    userId: string,
    tenantId: string | null,
  ): Promise<boolean> {
    if (tenantId !== null) return false;
    const from = this.config?.get<string>('MFA_ENFORCE_FROM');
    if (!from) return false;
    const at = Date.parse(from);
    if (Number.isNaN(at) || Date.now() < at) return false;
    return !(await this.isEnabled(userId));
  }

  // ── challenge tokens (not sessions; rejected by the access-token strategy) ──

  private challengeSecret(): string {
    return `${this.config?.getOrThrow<string>('JWT_ACCESS_SECRET')}:mfa-challenge`;
  }

  async issueChallenge(
    userId: string,
    purpose: MfaChallengePurpose,
  ): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, type: purpose },
      { secret: this.challengeSecret(), expiresIn: CHALLENGE_TTL_SECONDS },
    );
  }

  async parseChallenge(
    token: string,
    purpose: MfaChallengePurpose,
  ): Promise<string> {
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; type: string }>(
        token,
        { secret: this.challengeSecret() },
      );
      if (p.type !== purpose || !p.sub) throw new Error('wrong type');
      return p.sub;
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'The verification step expired. Please sign in again.',
      });
    }
  }

  // ── enrolment ────────────────────────────────────────────────────────────

  async startSetup(userId: string, account: string) {
    const existing = await this.mfa.findOne({ where: { user_id: userId } });
    if (existing?.enabled) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Two-factor authentication is already enabled.',
      });
    }
    const secret = generateSecret();
    const secret_enc = this.crypto.encrypt(secret);
    if (existing) {
      await this.mfa.update(
        { id: existing.id },
        { secret_enc, last_used_step: null },
      );
    } else {
      await this.mfa.save(
        this.mfa.create({ user_id: userId, secret_enc, enabled: false }),
      );
    }
    return { secret, otpauthUri: otpauthUri(secret, account, ISSUER) };
  }

  /** Confirms the first code, enables the factor, returns the one-time recovery codes. */
  async confirmSetup(userId: string, code: string): Promise<string[]> {
    const row = await this.mfa.findOne({ where: { user_id: userId } });
    if (!row || row.enabled) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'No pending two-factor setup.',
      });
    }
    const step = matchStep(this.crypto.decrypt(row.secret_enc), code);
    if (step === null) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Invalid verification code.',
      });
    }
    await this.mfa.update(
      { id: row.id },
      {
        enabled: true,
        enrolled_at: new Date(),
        last_used_step: String(step),
        failed_attempts: 0,
      },
    );
    const codes = await this.regenerateRecoveryCodes(userId);
    this.logger.log({ event: 'auth.mfa.enrolled', user_id: userId });
    return codes;
  }

  private async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    await this.recovery.delete({ user_id: userId });
    const plain: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = randomBytes(5).toString('hex'); // 40 bits, shown as xxxxx-xxxxx
      plain.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
    }
    for (const c of plain) {
      await this.recovery.save(
        this.recovery.create({
          user_id: userId,
          code_hash: await bcrypt.hash(c, 10),
        }),
      );
    }
    return plain;
  }

  // ── verification ─────────────────────────────────────────────────────────

  /** Accepts a TOTP code or an unused recovery code. Throws on failure; counts and locks. */
  async verify(
    userId: string,
    input: { code?: string; recoveryCode?: string },
  ): Promise<void> {
    const row = await this.mfa.findOne({ where: { user_id: userId } });
    if (!row?.enabled) {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Verification failed.',
      });
    }
    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'Too many failed attempts. Please try again later.',
      });
    }

    let ok = false;
    if (input.code) {
      const step = matchStep(this.crypto.decrypt(row.secret_enc), input.code);
      const last =
        row.last_used_step === null ? -1 : Number(row.last_used_step);
      if (step !== null && step > last) {
        // atomic claim of the step: a concurrent replay of the same code loses
        const res = await this.mfa
          .createQueryBuilder()
          .update(UserMfa)
          .set({ last_used_step: String(step) })
          .where(
            'id = :id AND (last_used_step IS NULL OR last_used_step < :step)',
            { id: row.id, step },
          )
          .execute();
        ok = (res.affected ?? 0) === 1;
      }
    } else if (input.recoveryCode) {
      ok = await this.consumeRecoveryCode(
        userId,
        input.recoveryCode.trim().toLowerCase(),
      );
    }

    if (!ok) {
      const failed = row.failed_attempts + 1;
      const lock = failed >= MAX_FAILED_ATTEMPTS;
      await this.mfa.update(
        { id: row.id },
        {
          failed_attempts: lock ? 0 : failed,
          locked_until: lock
            ? new Date(Date.now() + LOCK_MINUTES * 60_000)
            : null,
        },
      );
      this.logger.warn({ event: 'auth.mfa.failed', user_id: userId, locked: lock });
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Invalid verification code.',
      });
    }
    await this.mfa.update(
      { id: row.id },
      { failed_attempts: 0, locked_until: null },
    );
  }

  private async consumeRecoveryCode(
    userId: string,
    code: string,
  ): Promise<boolean> {
    const rows = await this.recovery.find({ where: { user_id: userId } });
    for (const r of rows) {
      if (r.used_at) continue;
      if (await bcrypt.compare(code, r.code_hash)) {
        const res = await this.recovery
          .createQueryBuilder()
          .update(UserMfaRecoveryCode)
          .set({ used_at: new Date() })
          .where('id = :id AND used_at IS NULL', { id: r.id })
          .execute();
        if ((res.affected ?? 0) === 1) {
          this.logger.warn({
            event: 'auth.mfa.recovery_code_used',
            user_id: userId,
          });
          return true;
        }
      }
    }
    return false;
  }

  // ── removal ──────────────────────────────────────────────────────────────

  /** Self-service disable: requires a valid current code. */
  async disable(userId: string, code: string): Promise<void> {
    await this.verify(userId, { code });
    await this.clear(userId);
  }

  /** Admin-initiated reset by ANOTHER super-admin; audited. No self-bypass path. */
  async adminReset(targetUserId: string, actorUserId: string): Promise<void> {
    if (targetUserId === actorUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'You cannot reset your own two-factor authentication.',
      });
    }
    await this.clear(targetUserId);
    await this.audit.save(
      this.audit.create({
        user: { id: actorUserId } as User,
        action: 'platform_admin.mfa.reset',
        entity_type: 'UserMfa',
        entity_id: targetUserId,
      }),
    );
  }

  private async clear(userId: string): Promise<void> {
    await this.recovery.delete({ user_id: userId });
    await this.mfa.delete({ user_id: userId });
    this.logger.log({ event: 'auth.mfa.removed', user_id: userId });
  }
}
