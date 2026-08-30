import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThan, Repository } from 'typeorm';

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
import { QueueService } from '../../queue/queue.service';
import { JOB, QUEUE } from '../../queue/queue.constants';
import { CAMPAIGN_CHANNEL } from './campaign.constants';
import { TransientDispatchError } from './dispatch/dispatch-errors';
import { EmailSuppressionService } from '../email/email-suppression.service';
import { ReputationGuardService } from './reputation-guard.service';
import { AppError } from '../../common/errors';

/** Caller-supplied context for recording a dead-lettered recipient's DLQ entry (FND-020). */
export interface DlqRecoveryContext {
  tenantId: string | null;
  correlationId?: string;
  attemptsMade?: number;
}

/**
 * How long a dead-lettered recipient must sit with `dlq_recorded_at IS NULL`
 * before the recovery sweep re-attempts its DLQ write — comfortably above
 * how long the LIVE path's own enqueue takes, so the sweep never races (and
 * duplicate-enqueues, though harmlessly, against) an attempt still in flight.
 */
const DLQ_RECOVERY_GRACE_MS = 60_000;
/** Bounds one sweep pass — a system-wide sweep must never be an unbounded scan. */
const DLQ_RECOVERY_BATCH_SIZE = 500;

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
    private readonly queue: QueueService,
    private readonly dataSource: DataSource,
    private readonly emailSuppression: EmailSuppressionService,
    private readonly reputationGuard: ReputationGuardService,
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
        claimable: [
          RecipientProcessing.PENDING,
          RecipientProcessing.DISPATCHING,
        ],
      })
      .andWhere('provider_ref IS NULL')
      .execute();
    if ((claim.affected ?? 0) === 0) {
      return { status: 'noop', reason: 'already-claimed-or-sent' };
    }

    // 2a. Run still wants work?
    const run = await this.runs.findOne({
      where: { id: runId, tenant: { id: tenantId } },
      select: {
        id: true,
        execution: true,
        tenant: { id: true, contact_email: true },
      },
      relations: { tenant: true },
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

    // Campaign row (channel + content + rate/cap config) — fetched ONCE,
    // ahead of consent, since Phase 11 (US7) consent now depends on the
    // channel (email requires an address, WhatsApp requires a phone).
    const campaign = await this.campaigns.findOne({
      where: { id: recipient.campaign.id },
      select: {
        id: true,
        channel: true,
        email_subject: true,
        email_body: true,
        throttle_per_minute: true,
        daily_cap: true,
        monthly_cap: true,
      },
      // The number this campaign sends from — validated at launch, honoured here.
      relations: { whatsapp_account: true },
    });
    const channel = campaign?.channel ?? CAMPAIGN_CHANNEL.WHATSAPP;

    // 2b. CONSENT — checked here, immediately before the send, not (only) when
    // the audience was built. A customer who opts out after launch must not
    // receive the message still sitting in the queue, and marketing rules
    // (WhatsApp business-initiated sends, and FR-E005/E008 for email) make
    // sending anyway a compliance problem, not just a UX one.
    const consent = this.checkConsent(recipient.customer, channel);
    if (!consent.allowed) {
      await this.markSkipped(runId, recipientId, consent.reason);
      return { status: 'skipped', reason: consent.reason };
    }

    // 2b'. EMAIL-only gates (Phase 11, US7, T133/T135) — suppression list,
    // in-run dedupe by lowercased address, and the reputation-guard
    // suspension. Never consulted for WhatsApp, and NEVER for transactional
    // mail (which never calls this method at all — FR-E009).
    if (channel === CAMPAIGN_CHANNEL.EMAIL) {
      const email = recipient.customer.email;
      const suppressed = await this.emailSuppression.isSuppressed(
        tenantId,
        email,
      );
      if (suppressed) {
        await this.markSkipped(runId, recipientId, 'email-suppressed');
        return { status: 'skipped', reason: 'email-suppressed' };
      }
      const duplicate = await this.hasEmailAlreadyDispatchedInRun(
        runId,
        recipientId,
        email,
      );
      if (duplicate) {
        await this.markSkipped(runId, recipientId, 'duplicate-email-in-run');
        return { status: 'skipped', reason: 'duplicate-email-in-run' };
      }
      try {
        await this.reputationGuard.assertNotSuspended(tenantId);
      } catch (err) {
        const reason =
          err instanceof AppError
            ? 'marketing-sending-suspended'
            : 'reputation-guard-error';
        await this.markSkipped(runId, recipientId, reason);
        return { status: 'skipped', reason };
      }
    }

    // 2c. Per-tenant rate limit + daily/monthly caps (T137 — the SAME caps
    // for every channel; no per-channel or per-metric enforcement is added).
    const decision = await this.rateLimiter.consume(
      tenantId,
      recipient.campaign.id,
      {
        ratePerMinute: campaign?.throttle_per_minute ?? 30,
        dailyCap: campaign?.daily_cap ?? null,
        monthlyCap: campaign?.monthly_cap ?? null,
      },
    );
    if (!decision.allowed) {
      if (decision.reason === 'RATE') {
        // Release the claim so the delayed re-run can pick it up again.
        await this.releaseClaim(recipientId);
        return { status: 'rate_limited', retryAfterMs: decision.retryAfterMs };
      }
      const reason =
        decision.reason === 'DAILY_CAP' ? 'daily-cap' : 'monthly-cap';
      await this.markSkipped(runId, recipientId, reason);
      return { status: 'skipped', reason };
    }

    // 3. SEND (the only IO).
    const provider = this.delivery.resolve(channel);

    // Phase 11 (US7, T131) — FAIL LOUD rather than silently no-op. Unlike
    // the pre-existing WhatsApp path (which always resolves a real provider
    // under correct configuration, so a noop there is a rare
    // misconfiguration merely LOGGED — see the `provider.name === 'noop'`
    // branch below), a non-default channel resolving to noop means NO real
    // delivery integration exists for it at all. Recording that as a
    // "dispatched" success would corrupt the consent/suppression audit
    // trail — skipped recipients would read as delivered. Fails the whole
    // run, not just this recipient: every other queued recipient has the
    // identical problem.
    if (provider.name === 'noop' && channel !== CAMPAIGN_CHANNEL.WHATSAPP) {
      const reason = `no delivery provider registered for channel "${channel}"`;
      this.logger.error(
        `Campaign recipient ${recipientId} (run ${runId}): ${reason} — refusing to report a simulated send as successful. Failing the run.`,
      );
      await this.markTerminalFailed(
        runId,
        recipientId,
        FailureClass.PERMANENT,
        reason,
      );
      await this.failRun(runId, reason);
      return { status: 'failed_permanent', reason };
    }

    const resolvedEmail =
      channel === CAMPAIGN_CHANNEL.EMAIL ? recipient.customer.email : undefined;
    let result: CampaignDeliveryResult;
    try {
      result = await provider.send({
        tenantId,
        campaignId: recipient.campaign.id,
        channel,
        recipientId: recipient.id,
        customerId: recipient.customer.id,
        templateId: recipient.campaign.template?.id,
        accountId: campaign?.whatsapp_account?.id,
        email: resolvedEmail,
        emailSubject: campaign?.email_subject ?? undefined,
        emailBody: campaign?.email_body ?? undefined,
        // FR-E018 — the clinic's own contact address, not the platform sender.
        replyTo: run.tenant?.contact_email ?? undefined,
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
      // FND-025 — under correct configuration this is unreachable (the real
      // WhatsApp/email providers unconditionally support their own hardcoded
      // channel), so noop here signals a genuine misconfiguration. The
      // recipient still settles — a run must still be able to complete in
      // dev/test, where noop is the legitimate, expected path (the WhatsApp
      // default channel only) — but a simulated send completing a
      // PRODUCTION run must never look identical to a real one.
      if (provider.name === 'noop') {
        this.logger.error(
          `Campaign recipient ${recipientId} (run ${runId}) dispatched via the NOOP delivery provider — NO REAL MESSAGE WAS SENT. Verify CAMPAIGN_DELIVERY_PROVIDERS registration for this channel.`,
        );
      }
      await this.markDispatched(
        runId,
        recipientId,
        result.providerRef,
        resolvedEmail,
      );
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
   *
   * FND-020: when `dlqContext` is supplied, this ALSO attempts the DLQ write
   * itself and stamps `dlq_recorded_at` on success — folding what used to be
   * two independent, unlinked operations (this reconcile, and a separate
   * `queue.enqueueCampaignDlq` call in the processor's `onFailed` handler)
   * into one durable-then-best-effort sequence: the Postgres reconcile always
   * lands first (so the run can always complete regardless of what happens
   * next), and the queue write's success is now RECORDED rather than merely
   * attempted-and-forgotten, which is what makes `recoverDeadLetters` below
   * possible at all. A caller with no DLQ context (there is currently none —
   * every call site has one) simply skips the queue write.
   */
  async markDeadLettered(
    runId: string,
    recipientId: string,
    reason: string,
    dlqContext?: DlqRecoveryContext,
  ): Promise<void> {
    await this.markTerminalFailed(
      runId,
      recipientId,
      FailureClass.TRANSIENT,
      reason,
    );
    await this.checkCompletion(runId);
    if (dlqContext) {
      await this.recordDlqEntry(recipientId, runId, reason, dlqContext);
    }
  }

  /**
   * Attempts the DLQ write for one recipient; records success via
   * `dlq_recorded_at`. Never throws — a queue outage here must not crash the
   * live dispatch path (matching the processor's previous `.catch()`) nor
   * abort the recovery sweep's loop over the rest of its batch.
   *
   * `originalJobId: recipientId` (rather than the ephemeral BullMQ job id the
   * processor used to pass) is deliberate: it is a STABLE identifier both the
   * live path and every future recovery attempt can reconstruct identically,
   * which is what makes the DLQ enqueue's deterministic jobId
   * (`dlq-${sourceQueue}-${originalJobId}`, see QueueService.enqueueCampaignDlq)
   * safe to retry any number of times — a redundant enqueue for an
   * already-confirmed entry collapses onto the same BullMQ job, a harmless no-op.
   */
  private async recordDlqEntry(
    recipientId: string,
    runId: string,
    reason: string,
    ctx: DlqRecoveryContext,
  ): Promise<boolean> {
    try {
      await this.queue.enqueueCampaignDlq({
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        sourceQueue: QUEUE.CAMPAIGNS_PROCESS,
        sourceJobName: JOB.CAMPAIGNS_PROCESS_RECIPIENT,
        originalJobId: recipientId,
        originalData: { tenantId: ctx.tenantId, runId, recipientId },
        failedReason: reason,
        attemptsMade: ctx.attemptsMade ?? 0,
        diedAt: new Date().toISOString(),
      });
      await this.recipients.update(recipientId, {
        dlq_recorded_at: new Date(),
      });
      return true;
    } catch (err) {
      this.logger.error(
        `DLQ enqueue failed for recipient=${recipientId}: ${(err as Error)?.message}`,
      );
      return false;
    }
  }

  /**
   * Recovery sweep (FND-020) — mirrors OutboxRelayService.runRecovery()'s
   * concept (a periodic sweep that finds work stuck in an unconfirmed
   * intermediate state and safely retries it), adapted to what's actually
   * durable here: `campaign_recipients` rows already ARE the outbox — a row
   * with `failure_class = TRANSIENT` (dead-lettered) and
   * `dlq_recorded_at IS NULL` (DLQ write never confirmed) is exactly a
   * "stuck" row. `DLQ_RECOVERY_GRACE_MS` avoids racing the live path's own
   * first attempt; batch-bounded so a system-wide sweep is never an
   * unbounded scan.
   */
  async recoverDeadLetters(): Promise<{
    recovered: number;
    attempted: number;
  }> {
    const cutoff = new Date(Date.now() - DLQ_RECOVERY_GRACE_MS);
    const stranded = await this.recipients.find({
      where: {
        failure_class: FailureClass.TRANSIENT,
        dlq_recorded_at: IsNull(),
        created_at: LessThan(cutoff),
      },
      relations: { run: { tenant: true } },
      take: DLQ_RECOVERY_BATCH_SIZE,
    });

    let recovered = 0;
    for (const r of stranded) {
      const ok = await this.recordDlqEntry(
        r.id,
        r.run.id,
        r.failure_reason ?? 'exhausted',
        {
          tenantId: r.run.tenant?.id ?? null,
          attemptsMade: r.attempts,
        },
      );
      if (ok) recovered++;
    }
    if (stranded.length > 0) {
      this.logger.log(
        `dead-letter recovery sweep: ${recovered}/${stranded.length} DLQ write(s) recovered`,
      );
    }
    return { recovered, attempted: stranded.length };
  }

  /**
   * Whether this customer may receive a campaign message right now.
   *
   * Campaigns are business-INITIATED marketing, so WhatsApp's rules (and basic
   * decency) require prior opt-in. Skipping is deliberately a terminal SKIPPED
   * outcome rather than a failure: not-consenting is a correct, expected result
   * that should complete the run, not retry against it.
   *
   * A missing phone is treated the same way — there is nothing to send to, and
   * retrying cannot conjure a number.
   *
   * FND-024: `opted_out_at` is checked IN ADDITION to `marketing_opt_in` — a
   * customer who opted in at signup keeps `marketing_opt_in=true` forever
   * (nothing flips it), so an inbound "STOP" is recorded separately via
   * `opted_out_at`/`opt_out_source` (M-05) and must be consulted here too, or
   * a customer who opted out after their original opt-in would still receive
   * campaign sends. This is the primary SKIP gate for campaigns (with its own
   * counted reason); `WhatsappExecutionService.sendTemplateMessage` enforces
   * the same signal as a backstop for every send path, including this one.
   */
  private checkConsent(
    customer:
      | {
          marketing_opt_in?: boolean;
          is_active?: boolean;
          phone?: string;
          email?: string;
          opted_out_at?: Date | null;
        }
      | undefined,
    channel: string,
  ): { allowed: true } | { allowed: false; reason: string } {
    if (!customer) return { allowed: false, reason: 'customer-missing' };
    if (customer.marketing_opt_in !== true) {
      return { allowed: false, reason: 'no-marketing-consent' };
    }
    if (customer.opted_out_at) return { allowed: false, reason: 'opted-out' };
    if (customer.is_active === false)
      return { allowed: false, reason: 'customer-inactive' };
    // Phase 11 (US7) — the "nothing to send to" check is channel-specific:
    // WhatsApp needs a phone, EMAIL needs an address. Neither can be
    // conjured by retrying.
    if (channel === CAMPAIGN_CHANNEL.EMAIL) {
      if (!customer.email)
        return { allowed: false, reason: 'customer-has-no-email' };
    } else if (!customer.phone) {
      return { allowed: false, reason: 'customer-has-no-phone' };
    }
    return { allowed: true };
  }

  /**
   * Phase 11 (US7, FR-E013) — dedupe by lowercased address WITHIN a run: two
   * different `Customer` rows that happen to share an email must not both
   * receive the same campaign. Checked against recipients already settled
   * as DISPATCHED for this run (their resolved `email` snapshot — see the
   * `CampaignRecipient.email` column docblock).
   *
   * KNOWN LIMITATION: this is a best-effort pre-send check, not an atomic
   * database guard (no unique index backs it) — two recipients for the same
   * duplicate address claimed and sent in the same narrow window could both
   * still go through. Acceptable here because the CLAIM step already
   * guarantees each recipient ROW sends at most once; this only guards
   * against the same real inbox receiving the campaign twice via two
   * DIFFERENT customer rows, a data-quality edge case, not a security or
   * idempotency boundary.
   */
  private async hasEmailAlreadyDispatchedInRun(
    runId: string,
    recipientId: string,
    email: string,
  ): Promise<boolean> {
    const existing = await this.recipients
      .createQueryBuilder('r')
      .where('r."runId" = :runId', { runId })
      .andWhere('r.id != :recipientId', { recipientId })
      .andWhere('LOWER(r.email) = :email', { email: email.toLowerCase() })
      .andWhere('r.processing = :dispatched', {
        dispatched: RecipientProcessing.DISPATCHED,
      })
      .getCount();
    return existing > 0;
  }

  /**
   * Phase 11 (US7, T131) — the FAIL-LOUD companion to the noop guard above:
   * flips the whole run to FAILED (never COMPLETED) so a channel with no
   * real delivery integration can never look like a finished, successful
   * campaign. Guarded exactly like every other run-execution transition in
   * this codebase (`checkCompletion`) — only a run still PROCESSING moves,
   * so this is a safe no-op if the run already reached a terminal state.
   */
  private async failRun(runId: string, reason: string): Promise<void> {
    await this.runs
      .createQueryBuilder()
      .update(CampaignRun)
      .set({ execution: CampaignExecution.FAILED, finished_at: () => 'now()' })
      .where('id = :runId', { runId })
      .andWhere('execution = :proc', { proc: CampaignExecution.PROCESSING })
      .execute();
    this.logger.error(`Campaign run ${runId} FAILED: ${reason}`);
  }

  // ──────────────────────────── persistence steps ─────────────────────────── //

  private async markDispatched(
    runId: string,
    recipientId: string,
    providerRef: string,
    email?: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      let res;
      try {
        res = await mgr.update(
          CampaignRecipient,
          {
            id: recipientId,
            processing: In([
              RecipientProcessing.PENDING,
              RecipientProcessing.DISPATCHING,
            ]),
          },
          {
            processing: RecipientProcessing.DISPATCHED,
            delivery: RecipientDelivery.ACCEPTED,
            provider_ref: providerRef,
            email,
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
            processing: In([
              RecipientProcessing.PENDING,
              RecipientProcessing.DISPATCHING,
            ]),
          },
          {
            processing: RecipientProcessing.DISPATCHED,
            delivery: RecipientDelivery.ACCEPTED,
            email,
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

  private markFailed(
    runId: string,
    recipientId: string,
    reason: string,
  ): Promise<void> {
    return this.markTerminalFailed(
      runId,
      recipientId,
      FailureClass.PERMANENT,
      reason,
    );
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
          processing: In([
            RecipientProcessing.PENDING,
            RecipientProcessing.DISPATCHING,
          ]),
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
        {
          id: recipientId,
          processing: In([
            RecipientProcessing.PENDING,
            RecipientProcessing.DISPATCHING,
          ]),
        },
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
      .set({
        [field]: () => `${field} + 1`,
        queued: () => 'GREATEST(queued - 1, 0)',
      })
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
      .set({
        execution: CampaignExecution.COMPLETED,
        finished_at: () => 'now()',
      })
      .where('id = :runId', { runId })
      .andWhere('execution = :proc', { proc: CampaignExecution.PROCESSING })
      .andWhere('(sent + failed + skipped) >= total_recipients')
      .execute();
  }

  private isTransient(result: {
    transient?: boolean;
    error?: string;
  }): boolean {
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
