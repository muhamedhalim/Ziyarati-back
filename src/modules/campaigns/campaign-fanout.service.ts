import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignExecution, RecipientProcessing } from '../../entities/enums';

import { QueueService } from '../../queue/queue.service';
import { CustomerSegmentService } from '../crm/customer-segment.service';
import { FANOUT_BATCH_SIZE } from './campaign.constants';

/**
 * Worker-side fan-out. Scales to millions of recipients by NEVER loading the
 * full audience into memory:
 *  - `handleLaunch` flips the run to PROCESSING and kicks off the first chunk.
 *  - `handleChunk` reads ONE keyset window (id > cursor, LIMIT 5000), bulk-
 *    enqueues a send job per recipient in a single Redis round-trip, then
 *    enqueues the NEXT chunk job with the new cursor — so fan-out parallelizes
 *    across workers instead of one job streaming everything.
 */
@Injectable()
export class CampaignFanoutService {
  private readonly logger = new Logger('CampaignFanoutService');

  constructor(
    @InjectRepository(CampaignRun)
    private readonly runs: Repository<CampaignRun>,
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    private readonly queue: QueueService,
    private readonly segments: CustomerSegmentService,
  ) {}

  /** campaigns.launch handler — idempotent kick-off of the fan-out. */
  async handleLaunch(
    tenantId: string,
    campaignId: string,
    runId: string,
    correlationId?: string,
  ): Promise<{ started: boolean }> {
    const run = await this.runs.findOne({
      where: { id: runId, tenant: { id: tenantId } },
    });
    if (!run) return { started: false };
    if (
      run.execution !== CampaignExecution.ENQUEUEING &&
      run.execution !== CampaignExecution.PROCESSING
    ) {
      // Cancelled/failed/completed before the relay published — do nothing.
      return { started: false };
    }
    if (run.execution === CampaignExecution.ENQUEUEING) {
      await this.runs.update(
        { id: runId, execution: CampaignExecution.ENQUEUEING },
        { execution: CampaignExecution.PROCESSING },
      );
    }
    await this.queue.enqueueCampaignFanoutChunk({
      tenantId,
      campaignId,
      runId,
      cursor: null,
      correlationId,
    });
    return { started: true };
  }

  /** campaigns.fanoutChunk handler — one keyset window → addBulk → next chunk. */
  async handleChunk(
    tenantId: string,
    campaignId: string,
    runId: string,
    cursor: string | null,
    correlationId?: string,
  ): Promise<{ enqueued: number; nextCursor: string | null }> {
    const run = await this.runs.findOne({
      where: { id: runId, tenant: { id: tenantId } },
      select: { id: true, execution: true },
    });
    if (!run || run.execution !== CampaignExecution.PROCESSING) {
      return { enqueued: 0, nextCursor: null };
    }

    const campaign = await this.campaigns.findOne({
      where: { id: campaignId },
      relations: { audience_segment: true },
      select: { id: true, audience_segment: { id: true } },
    });

    return campaign?.audience_segment
      ? this.handleSegmentChunk(
          tenantId,
          campaignId,
          runId,
          campaign.audience_segment.id,
          cursor,
          correlationId,
        )
      : this.handleExplicitChunk(
          tenantId,
          campaignId,
          runId,
          cursor,
          correlationId,
        );
  }

  /** The pre-existing path: recipient rows were already materialised before launch. */
  private async handleExplicitChunk(
    tenantId: string,
    campaignId: string,
    runId: string,
    cursor: string | null,
    correlationId?: string,
  ): Promise<{ enqueued: number; nextCursor: string | null }> {
    const qb = this.recipients
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .where('r."runId" = :runId', { runId })
      .andWhere('r.processing = :pending', {
        pending: RecipientProcessing.PENDING,
      })
      .orderBy('r.id', 'ASC')
      .limit(FANOUT_BATCH_SIZE);
    if (cursor) qb.andWhere('r.id > :cursor', { cursor });

    const rows = await qb.getRawMany<{ id: string }>();
    if (rows.length === 0) {
      // No more PENDING recipients in this run — settle completion (covers the
      // empty/forced-launch case and the final window).
      await this.settleIfCountsMatch(runId);
      return { enqueued: 0, nextCursor: null };
    }

    return this.enqueueAndAdvance(
      tenantId,
      campaignId,
      runId,
      rows.map((r) => r.id),
      cursor,
      rows.length === FANOUT_BATCH_SIZE,
      correlationId,
    );
  }

  /**
   * T125 (FR-S007) — a segment-audience campaign has no pre-materialised
   * recipient rows: this chunk resolves ONE keyset window of matching
   * CUSTOMER ids live (never the whole audience at once), materialises them
   * as PENDING recipient rows (`orIgnore` — idempotent against a retried
   * chunk), then feeds the SAME enqueue/throttle/cap machinery as the
   * explicit-list path. Cursor is over `customers.id`, resolved fresh every
   * call, so a newly-qualifying customer is picked up and a no-longer-
   * qualifying one drops out between chunks — never frozen at launch.
   */
  private async handleSegmentChunk(
    tenantId: string,
    campaignId: string,
    runId: string,
    segmentId: string,
    cursor: string | null,
    correlationId?: string,
  ): Promise<{ enqueued: number; nextCursor: string | null }> {
    const page = await this.segments.resolve(
      tenantId,
      segmentId,
      cursor,
      FANOUT_BATCH_SIZE,
    );
    if (page.customerIds.length === 0) {
      // Segment audiences are an ESTIMATE at launch (CampaignExecutionService)
      // — actual resolved membership can differ, so completion here is
      // unconditional on cursor exhaustion, never gated on matching
      // total_recipients exactly.
      await this.runs
        .createQueryBuilder()
        .update(CampaignRun)
        .set({
          execution: CampaignExecution.COMPLETED,
          finished_at: () => 'now()',
        })
        .where('id = :runId', { runId })
        .andWhere('execution = :proc', { proc: CampaignExecution.PROCESSING })
        .execute();
      return { enqueued: 0, nextCursor: null };
    }

    await this.recipients
      .createQueryBuilder()
      .insert()
      .into(CampaignRecipient)
      .values(
        page.customerIds.map((customerId) => ({
          run: { id: runId } as CampaignRun,
          campaign: { id: campaignId } as Campaign,
          customer: { id: customerId },
          processing: RecipientProcessing.PENDING,
        })),
      )
      .orIgnore()
      .execute();

    // Re-select the PENDING recipient rows for exactly this window — never
    // trust the insert result directly: a retried chunk hits `orIgnore` for
    // rows already inserted (and possibly already dispatched), so only a
    // still-PENDING row for this window's customers is safe to enqueue.
    const pending = await this.recipients
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .where('r."runId" = :runId', { runId })
      .andWhere('r."customerId" IN (:...customerIds)', {
        customerIds: page.customerIds,
      })
      .andWhere('r.processing = :pending', {
        pending: RecipientProcessing.PENDING,
      })
      .getRawMany<{ id: string }>();

    return this.enqueueAndAdvance(
      tenantId,
      campaignId,
      runId,
      pending.map((r) => r.id),
      cursor,
      page.nextCursor !== null,
      correlationId,
      page.nextCursor,
    );
  }

  private async settleIfCountsMatch(runId: string): Promise<void> {
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

  private async enqueueAndAdvance(
    tenantId: string,
    campaignId: string,
    runId: string,
    recipientIds: string[],
    cursor: string | null,
    hasMore: boolean,
    correlationId?: string,
    explicitNextCursor?: string | null,
  ): Promise<{ enqueued: number; nextCursor: string | null }> {
    if (recipientIds.length > 0) {
      await this.queue.enqueueCampaignRecipientsBulk(
        recipientIds.map((id) => ({
          data: { tenantId, campaignId, runId, recipientId: id, correlationId },
        })),
      );
    }

    const nextCursor =
      explicitNextCursor !== undefined
        ? explicitNextCursor
        : recipientIds[recipientIds.length - 1];
    if (hasMore) {
      await this.queue.enqueueCampaignFanoutChunk({
        tenantId,
        campaignId,
        runId,
        cursor: nextCursor,
        correlationId,
      });
    }
    this.logger.log(
      `run=${runId} fanned out ${recipientIds.length} recipient job(s) (cursor>${cursor ?? 'start'})`,
    );
    return {
      enqueued: recipientIds.length,
      nextCursor: hasMore ? (nextCursor ?? null) : null,
    };
  }
}
