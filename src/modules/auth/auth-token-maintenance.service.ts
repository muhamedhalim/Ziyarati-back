import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RefreshToken } from '../../entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';

/**
 * AUTH-005 remediation — retention for the authentication token tables.
 *
 * Before this existed, `refresh_tokens` and `password_resets` were never
 * deleted by anything: a row was inserted on every login AND every rotation,
 * marked `revoked_at`/`used_at` on the way out, and then kept forever. The only
 * reclamation was `ON DELETE CASCADE` from `users`. Measured at audit time:
 * 822 rows in a *development* database, 83% expired, accumulating 48/day
 * (docs/AUTH_CONCURRENCY_GC_AUDIT.md §9).
 *
 * Run by the existing `platform` maintenance queue (`platform.authTokenCleanup`)
 * — deliberately NOT a new scheduler. BullMQ repeatable jobs dedup by repeat
 * key, so registration is idempotent across worker replicas; an in-process cron
 * would fire once per replica under `API_CLUSTER_WORKERS > 1`.
 *
 * ── WHY THIS CANNOT RACE REFRESH / ROTATION / LOGOUT ────────────────────────
 *
 * 1. EXPIRY-ONLY PREDICATE. Only rows already past `expires_at` are eligible.
 *    `AuthService.claimRefreshRow` — the single gate every rotation goes
 *    through — requires `expires_at > now()`, so a row this sweep can delete is
 *    one no refresh could ever have succeeded on. Deleting it cannot turn a
 *    would-be success into a failure.
 *
 * 2. RETENTION MARGIN. `AUTH_TOKEN_RETENTION_DAYS` (default 7) is subtracted on
 *    top, so a row is removed a week after it stopped being usable — far
 *    outside any in-flight request, clock skew between instances, or the
 *    seconds-wide retry window.
 *
 * 3. REVOKED-BUT-UNEXPIRED ROWS ARE KEPT. Deliberately: those are exactly the
 *    rows reuse detection needs. Delete a revoked row early and a replay of it
 *    stops being "revoked token → detect theft, revoke family" and silently
 *    degrades to "unknown jti → 401, do nothing" — quietly WEAKENING the
 *    control this audit just strengthened.
 *
 * 4. SELF-CONTAINED PREDICATE. The DELETE re-evaluates its own condition at
 *    execution time. It never SELECTs ids in one statement and deletes them in
 *    another, which would act on state that may have changed in between.
 *
 * Batches are bounded (`AUTH_TOKEN_CLEANUP_BATCH`, default 1000) and the number
 * of batches per pass is capped, so one sweep can never hold a long write lock
 * or run unbounded against a large backlog — it simply resumes next tick.
 */
@Injectable()
export class AuthTokenMaintenanceService {
  private readonly logger = new Logger('AuthTokenMaintenance');

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(PasswordReset)
    private readonly passwordResets: Repository<PasswordReset>,
    private readonly config: ConfigService,
  ) {}

  /** Days a row is kept AFTER it has already expired. See margin rationale above. */
  private retentionDays(): number {
    return this.config.get<number>('AUTH_TOKEN_RETENTION_DAYS', 7);
  }

  private batchSize(): number {
    return this.config.get<number>('AUTH_TOKEN_CLEANUP_BATCH', 1000);
  }

  /** Hard cap on batches per pass, so one tick cannot run unbounded. */
  private maxBatches(): number {
    return this.config.get<number>('AUTH_TOKEN_CLEANUP_MAX_BATCHES', 20);
  }

  async purgeExpiredTokens(): Promise<{
    refreshTokens: number;
    passwordResets: number;
    truncated: boolean;
  }> {
    const cutoff = new Date(
      Date.now() - this.retentionDays() * 24 * 3600 * 1000,
    );

    const refresh = await this.purge(
      this.refreshTokens,
      'refresh_tokens',
      cutoff,
    );
    const resets = await this.purge(
      this.passwordResets,
      'password_resets',
      cutoff,
    );

    if (refresh.deleted || resets.deleted) {
      this.logger.log(
        `auth token retention purge: refresh_tokens=${refresh.deleted} ` +
          `password_resets=${resets.deleted} cutoff=${cutoff.toISOString()}` +
          (refresh.truncated || resets.truncated
            ? ' (batch cap reached — resumes next tick)'
            : ''),
      );
    }

    return {
      refreshTokens: refresh.deleted,
      passwordResets: resets.deleted,
      truncated: refresh.truncated || resets.truncated,
    };
  }

  /**
   * Bounded batch delete. `id IN (SELECT ... LIMIT n)` keeps each statement
   * small and lets the `expires_at` index (AUTH-006, `AuthTokenIndexes`
   * migration) drive it — the same shape `PlatformMaintenanceService.purge`
   * already uses for the log tables.
   */
  private async purge(
    repo: Repository<RefreshToken | PasswordReset>,
    table: string,
    cutoff: Date,
  ): Promise<{ deleted: number; truncated: boolean }> {
    const batch = this.batchSize();
    const maxBatches = this.maxBatches();
    let deleted = 0;

    for (let pass = 0; pass < maxBatches; pass += 1) {
      const res = await repo
        .createQueryBuilder()
        .delete()
        .where(
          `id IN (SELECT id FROM ${table} WHERE expires_at < :cutoff ORDER BY expires_at ASC LIMIT :batch)`,
        )
        .setParameters({ cutoff, batch })
        .execute();

      const affected = res.affected ?? 0;
      deleted += affected;
      // A short batch means the backlog is drained.
      if (affected < batch) {
        return { deleted, truncated: false };
      }
    }

    return { deleted, truncated: true };
  }
}
