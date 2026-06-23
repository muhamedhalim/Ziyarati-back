import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignExecution, RecipientProcessing } from '../../entities/enums';

import { QueueService } from '../../queue/queue.service';
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
    private readonly queue: QueueService,
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

    const qb = this.recipients
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .where('r."runId" = :runId', { runId })
      .andWhere('r.processing = :pending', { pending: RecipientProcessing.PENDING })
      .orderBy('r.id', 'ASC')
      .limit(FANOUT_BATCH_SIZE);
    if (cursor) qb.andWhere('r.id > :cursor', { cursor });

    const rows = await qb.getRawMany<{ id: string }>();
    if (rows.length === 0) {
      // No more PENDING recipients in this run — settle completion (covers the
      // empty/forced-launch case and the final window).
      await this.runs
        .createQueryBuilder()
        .update(CampaignRun)
        .set({ execution: CampaignExecution.COMPLETED, finished_at: () => 'now()' })
        .where('id = :runId', { runId })
        .andWhere('execution = :proc', { proc: CampaignExecution.PROCESSING })
        .andWhere('(sent + failed + skipped) >= total_recipients')
        .execute();
      return { enqueued: 0, nextCursor: null };
    }

    await this.queue.enqueueCampaignRecipientsBulk(
      rows.map((row) => ({
        data: { tenantId, campaignId, runId, recipientId: row.id, correlationId },
      })),
    );

    const nextCursor = rows[rows.length - 1].id;
    if (rows.length === FANOUT_BATCH_SIZE) {
      await this.queue.enqueueCampaignFanoutChunk({
        tenantId,
        campaignId,
        runId,
        cursor: nextCursor,
        correlationId,
      });
    }
    this.logger.log(
      `run=${runId} fanned out ${rows.length} recipient job(s) (cursor>${cursor ?? 'start'})`,
    );
    return { enqueued: rows.length, nextCursor };
  }
}
