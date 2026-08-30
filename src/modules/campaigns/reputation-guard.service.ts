import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';

import { EmailSuppression } from '../../entities/System/EmailSuppression';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { AppError, ErrorCode } from '../../common/errors';

/** Rolling window over which bounce/complaint rate is computed. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Below this many sends, a rate is too noisy to act on (a single bounce in
 *  3 sends is not "5%", it's an outlier — avoid suspending a tiny/new list). */
const MIN_SAMPLE_SIZE = 20;
/** FR-E019 thresholds — deliberately conservative; a shared sending identity
 *  degrades for every clinic if any one tenant's list goes bad. */
const BOUNCE_RATE_THRESHOLD = 0.1; // 10%
const COMPLAINT_RATE_THRESHOLD = 0.05; // 5%

export interface ReputationSnapshot {
  sent: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  suspended: boolean;
  reason?: string;
}

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T135, FR-E019).
 *
 * Sender reputation is SHARED across every clinic on the platform's single
 * configured sending identity (FR-E018) — one tenant's bad list degrades
 * deliverability for everyone. This service computes each tenant's rolling
 * bounce/complaint rate LIVE from the same tables T136's webhook writes
 * (`email_suppressions` for the numerator, `campaign_recipients` for the
 * denominator) — no separate suspension-state column, so there is nothing
 * that can drift out of sync with the underlying delivery data.
 *
 * `assertNotSuspended` is a REPORTING-ONLY-style read/throw check, called
 * from the email dispatch path — it blocks the marketing send it guards but
 * never touches transactional mail (which never calls it).
 */
@Injectable()
export class ReputationGuardService {
  private readonly logger = new Logger(ReputationGuardService.name);

  constructor(
    @InjectRepository(EmailSuppression)
    private readonly suppressions: Repository<EmailSuppression>,
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
  ) {}

  async snapshot(tenantId: string): Promise<ReputationSnapshot> {
    const since = new Date(Date.now() - WINDOW_MS);

    const [sent, bounced, complained] = await Promise.all([
      this.recipients
        .createQueryBuilder('r')
        .innerJoin('r.run', 'run')
        .where('run."tenantId" = :tenantId', { tenantId })
        .andWhere('r.dispatched_at > :since', { since })
        .getCount(),
      this.suppressions.count({
        where: {
          tenant: { id: tenantId },
          reason: 'BOUNCE',
          created_at: MoreThan(since),
        },
      }),
      this.suppressions.count({
        where: {
          tenant: { id: tenantId },
          reason: 'COMPLAINT',
          created_at: MoreThan(since),
        },
      }),
    ]);

    const bounceRate = sent > 0 ? bounced / sent : 0;
    const complaintRate = sent > 0 ? complained / sent : 0;
    const sampleLargeEnough = sent >= MIN_SAMPLE_SIZE;

    let suspended = false;
    let reason: string | undefined;
    if (sampleLargeEnough && bounceRate >= BOUNCE_RATE_THRESHOLD) {
      suspended = true;
      reason = `bounce rate ${(bounceRate * 100).toFixed(1)}% over the last 24h (${bounced}/${sent})`;
    } else if (sampleLargeEnough && complaintRate >= COMPLAINT_RATE_THRESHOLD) {
      suspended = true;
      reason = `complaint rate ${(complaintRate * 100).toFixed(1)}% over the last 24h (${complained}/${sent})`;
    }

    return {
      sent,
      bounced,
      complained,
      bounceRate,
      complaintRate,
      suspended,
      reason,
    };
  }

  /**
   * Throws (422) when this tenant's marketing sending is currently
   * suspended. Call ONLY from the marketing dispatch path — never from
   * transactional mail (FR-E019's "blocks dispatch but not transactional
   * mail" requirement).
   */
  async assertNotSuspended(tenantId: string): Promise<void> {
    const snap = await this.snapshot(tenantId);
    if (!snap.suspended) return;

    // "alert the platform" (T135) — a clear, greppable operator-facing signal.
    // No dedicated platform-alerting integration is wired here (out of scope
    // for this task); this is the same posture existing best-effort audit/
    // security logging in this codebase uses.
    this.logger.error(
      `ALERT: tenant ${tenantId} marketing email sending SUSPENDED (reputation guard, FR-E019): ${snap.reason}`,
    );

    throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
      message:
        'Marketing email sending is suspended for this clinic due to a high bounce/complaint rate.',
      publicContext: { reason: snap.reason },
    });
  }
}
