import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import {
  CampaignExecution,
  FailureClass,
  RecipientDelivery,
  RecipientProcessing,
} from '../../entities/enums';

import { CampaignDeliveryFactory } from './delivery/campaign-delivery.factory';
import { CampaignDeliveryResult } from './delivery/campaign-delivery.provider.interface';
import { TenantRateLimiterService } from '../../queue/tenant-rate-limiter.service';
import { CAMPAIGN_CHANNEL } from './campaign.constants';
import {
  PermanentDispatchError,
  TransientDispatchError,
} from './dispatch/dispatch-errors';

export type DispatchOutcome =
  | { status: 'dispatched'; providerRef: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed_permanent'; reason: string }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'deferred'; retryAfterMs: number }
  | { status: 'noop'; reason: string };

/** How long a paused (DRAINING) recipient waits before re-checking the run. */
const PAUSE_RECHECK_MS = 30_000;

/**
 * The single per-recipient send seam, split into ordered single-responsibility
 * steps so the only non-transactional part is the provider IO:
 *
 *   1. CLAIM      — atomic guard (PENDING → DISPATCHING). 0 rows ⇒ idempotent
 *                   no-op (already claimed/sent or run stopped).
 *   2. GATE       — run still PROCESSING? per-tenant rate limit / caps?
 *   3. SEND       — provider IO (never throws for expected failures).
 *   4. CLASSIFY   — TRANSIENT (throw → retry/DLQ) vs PERMANENT (record, no retry)
 *                   vs success.
 *   5. PERSIST    — recipient status + atomic CampaignRun counters + completion,
 *                   all in one transaction.
 *
 * Idempotency floors: the deterministic jobId (queue), the CLAIM guard (no
 * double-claim), and the UNIQUE `provider_ref` (no double-send survives commit).
 */
@Injectable()
export class CampaignDispatchService {
  private readonly logger = new Logger('CampaignDispatchService');

  constructor(
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
    @InjectRepository(CampaignRun)
    private readonly runs: Repository<CampaignRun>,
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    private readonly delivery: CampaignDeliveryFactory,
    private readonly rateLimiter: TenantRateLimiterService,
    private readonly dataSource: DataSource,
  ) {}

  async dispatch(
    tenantId: string,
    runId: string,
    recipientId: string,
  ): Promise<DispatchOutcome> {
    // 1. CLAIM — only PENDING/DISPATCHING (and not already sent) proceed.
    const claim = await this.recipients
      .createQueryBuilder()
      .update(CampaignRecipient)
      .set({
        processing: RecipientProcessing.DISPATCHING,
        attempts: () => 'attempts + 1',
      })
      .where('id = :recipientId', { recipientId })
      .andWhere('"runId" = :runId', { runId })
      .andWhere('processing IN (:...claimable)', {
        claimable: [RecipientProcessing.PENDING, RecipientProcessing.DISPATCHING],
      })
      .andWhere('provider_ref IS NULL')
      .execute();
    if ((claim.affected ?? 0) === 0) {
      return { status: 'noop', reason: 'already-claimed-or-sent' };
    }

    // 2a. Run still wants work?
    const run = await this.runs.findOne({
      where: { id: runId, tenant: { id: tenantId } },
      select: { id: true, execution: true },
    });
    if (!run) {
      await this.markSkipped(runId, recipientId, 'run-missing');
      return { status: 'skipped', reason: 'run-missing' };
    }
    if (run.execution === CampaignExecution.DRAINING) {
      // PAUSED: defer without dropping. Release the claim back to PENDING so the
      // recipient stays in the audience; the delayed re-run (or resume re-fanout)
      // sends it once the run is PROCESSING again. NEVER skip on pause.
      await this.releaseClaim(recipientId);
      return { status: 'deferred', retryAfterMs: PAUSE_RECHECK_MS };
    }
    if (run.execution !== CampaignExecution.PROCESSING) {
      // CANCELLED / FAILED / COMPLETED → genuinely terminal: skip and count.
      await this.markSkipped(runId, recipientId, 'run-stopped');
      return { status: 'skipped', reason: 'run-stopped' };
    }

    // Load the send context (no mutation here).
    const recipient = await this.recipients.findOne({
      where: { id: recipientId },
      relations: { campaign: { template: true }, customer: true },
    });
    if (!recipient) return { status: 'noop', reason: 'recipient-vanished' };

    // 2b. Per-tenant rate limit + daily/monthly caps.
    const campaign = await this.campaigns.findOne({
      where: { id: recipient.campaign.id },
      select: {
        id: true,
        throttle_per_minute: true,
        daily_cap: true,
        monthly_cap: true,
      },
    });
    const decision = await this.rateLimiter.consume(tenantId, recipient.campaign.id, {
      ratePerMinute: campaign?.throttle_per_minute ?? 30,
      dailyCap: campaign?.daily_cap ?? null,
      monthlyCap: campaign?.monthly_cap ?? null,
    });
    if (!decision.allowed) {
      if (decision.reason === 'RATE') {
        // Release the claim so the delayed re-run can pick it up again.
        await this.releaseClaim(recipientId);
        return { status: 'rate_limited', retryAfterMs: decision.retryAfterMs };
      }
      const reason = decision.reason === 'DAILY_CAP' ? 'daily-cap' : 'monthly-cap';
      await this.markSkipped(runId, recipientId, reason);
      return { status: 'skipped', reason };
    }

    // 3. SEND (the only IO).
    const channel = CAMPAIGN_CHANNEL.WHATSAPP;
    const provider = this.delivery.resolve(channel);
    let result: CampaignDeliveryResult;
    try {
      result = await provider.send({
        tenantId,
        campaignId: recipient.campaign.id,
        channel,
        recipientId: recipient.id,
        customerId: recipient.customer.id,
        templateId: recipient.campaign.template?.id,
      });
    } catch (err) {
      // Unexpected throw from the provider → treat as transient.
      result = {
        success: false,
        error: (err as Error)?.message ?? 'provider error',
        transient: true,
      };
    }

    // 4 + 5. CLASSIFY & PERSIST.
    if (result.success && result.providerRef) {
      await this.markDispatched(runId, recipientId, result.providerRef);
      await this.checkCompletion(runId);
      return { status: 'dispatched', providerRef: result.providerRef };
    }

    const transient = this.isTransient(result);
    const reason = result.error ?? 'provider rejected';
    if (transient) {
      // Reset to PENDING so the BullMQ retry re-claims it cleanly.
      await this.recipients.update(
        { id: recipientId },
        {
          processing: RecipientProcessing.PENDING,
          failure_class: FailureClass.TRANSIENT,
          failure_reason: reason,
        },
      );
      throw new TransientDispatchError(reason);
    }

    // Permanent: record FAILED, do NOT retry, job completes (no DLQ).
    await this.markFailed(runId, recipientId, reason);
    await this.checkCompletion(runId);
    return { status: 'failed_permanent', reason };
  }

  /**
   * Reconcile a poison (transient-exhausted / dead-lettered) recipient into a
   * terminal FAILED state and the run counters. Called by the dispatch processor
   * when a job is routed to the DLQ — WITHOUT this the run can never complete
   * (its counters would never sum to total_recipients). Idempotent via the
   * claimable-state guard so a re-fire doesn't double-count.
   */
  async markDeadLettered(
    runId: string,
    recipientId: string,
    reason: string,
  ): Promise<void> {
    await this.markTerminalFailed(runId, recipientId, FailureClass.TRANSIENT, reason);
    await this.checkCompletion(runId);
  }

  // ──────────────────────────── persistence steps ─────────────────────────── //

  private async markDispatched(
    runId: string,
    recipientId: string,
    providerRef: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      let res;
      try {
        res = await mgr.update(
          CampaignRecipient,
          {
            id: recipientId,
            processing: In([RecipientProcessing.PENDING, RecipientProcessing.DISPATCHING]),
          },
          {
            processing: RecipientProcessing.DISPATCHED,
            delivery: RecipientDelivery.ACCEPTED,
            provider_ref: providerRef,
            dispatched_at: new Date(),
            failure_class: null,
            failure_reason: null,
          },
        );
      } catch (err) {
        // UNIQUE(provider_ref) collision = this message was already sent. Still
        // settle the recipient as DISPATCHED (without the duplicate ref) and
        // count it once, so the run can complete rather than getting stuck.
        this.logger.warn(
          `provider_ref collision for recipient=${recipientId} (reconciling as sent): ${(err as Error)?.message}`,
        );
        res = await mgr.update(
          CampaignRecipient,
          {
            id: recipientId,
            processing: In([RecipientProcessing.PENDING, RecipientProcessing.DISPATCHING]),
          },
          {
            processing: RecipientProcessing.DISPATCHED,
            delivery: RecipientDelivery.ACCEPTED,
            dispatched_at: new Date(),
            failure_class: null,
            failure_reason: null,
          },
        );
      }
      // Only move counters when this call actually transitioned the row.
      if ((res?.affected ?? 0) > 0) {
        await this.incrRun(mgr, runId, 'sent');
      }
    });
  }

  private markFailed(runId: string, recipientId: string, reason: string): Promise<void> {
    return this.markTerminalFailed(runId, recipientId, FailureClass.PERMANENT, reason);
  }

  /** Shared FAILED transition + counter, guarded against double-count. */
  private async markTerminalFailed(
    runId: string,
    recipientId: string,
    failureClass: FailureClass,
    reason: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const res = await mgr.update(
        CampaignRecipient,
        {
          id: recipientId,
          processing: In([RecipientProcessing.PENDING, RecipientProcessing.DISPATCHING]),
        },
        {
          processing: RecipientProcessing.FAILED,
          failure_class: failureClass,
          failure_reason: reason,
        },
      );
      if ((res.affected ?? 0) > 0) {
        await this.incrRun(mgr, runId, 'failed');
      }
    });
  }

  private async markSkipped(
    runId: string,
    recipientId: string,
    reason: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const res = await mgr.update(
        CampaignRecipient,
        { id: recipientId, processing: In([RecipientProcessing.PENDING, RecipientProcessing.DISPATCHING]) },
        { processing: RecipientProcessing.SKIPPED, failure_reason: reason },
      );
      if ((res.affected ?? 0) > 0) {
        await this.incrRun(mgr, runId, 'skipped');
      }
    });
    await this.checkCompletion(runId);
  }

  /** Atomically increment a run outcome counter and decrement `queued`. */
  private incrRun(
    mgr: DataSource['manager'],
    runId: string,
    field: 'sent' | 'failed' | 'skipped',
  ) {
    return mgr
      .createQueryBuilder()
      .update(CampaignRun)
      .set({ [field]: () => `${field} + 1`, queued: () => 'GREATEST(queued - 1, 0)' })
      .where('id = :runId', { runId })
      .execute();
  }

  /** Returns a claimed recipient to PENDING without counting it (rate-limit / pause path). */
  private async releaseClaim(recipientId: string): Promise<void> {
    await this.recipients.update(
      { id: recipientId, processing: RecipientProcessing.DISPATCHING },
      { processing: RecipientProcessing.PENDING },
    );
  }

  /** Atomic completion check — flips the run to COMPLETED when all are terminal. */
  private async checkCompletion(runId: string): Promise<void> {
    await this.runs
      .createQueryBuilder()
      .update(CampaignRun)
      .set({ execution: CampaignExecution.COMPLETED, finished_at: () => 'now()' })
      .where('id = :runId', { runId })
      .andWhere('execution = :proc', { proc: CampaignExecution.PROCESSING })
      .andWhere('(sent + failed + skipped) >= total_recipients')
      .execute();
  }

  private isTransient(result: { transient?: boolean; error?: string }): boolean {
    if (typeof result.transient === 'boolean') return result.transient;
    const msg = (result.error ?? '').toLowerCase();
    // Heuristic classification when the provider didn't tag the failure.
    return (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('rate') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('unavailable')
    );
  }
}
