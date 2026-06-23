import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import {
  CampaignLifecycle,
  CampaignExecution,
  RecipientProcessing,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { QUEUE, JOB } from '../../queue/queue.constants';
import { CampaignRunService } from './campaign-run.service';
import { ScheduleCampaignDto } from './dto/schedule-campaign.dto';
import { LaunchCampaignDto } from './dto/launch-campaign.dto';
import { CancelCampaignDto } from './dto/cancel-campaign.dto';
import { LIFECYCLE_TRANSITIONS, TERMINAL_LIFECYCLES } from './campaign.constants';

/**
 * Campaign lifecycle (operator intent) + the produce side of execution.
 *
 * Lifecycle transitions are validated here (the API boundary). Launching does
 * NOT enqueue directly: it writes the run state change + an OutboxJob in ONE
 * transaction, and the OutboxRelay (worker) publishes the launch job. This is
 * what guarantees no lost/phantom jobs. Per-recipient sending and execution
 * state transitions are owned by the worker (CampaignDispatchService /
 * CampaignFanoutService), never here.
 */
@Injectable()
export class CampaignExecutionService {
  private readonly logger = new Logger('CampaignExecutionService');

  constructor(
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
    private readonly runs: CampaignRunService,
    private readonly dataSource: DataSource,
  ) {}

  async schedule(
    tenantId: string,
    id: string,
    dto: ScheduleCampaignDto,
  ): Promise<Campaign> {
    const campaign = await this.loadOwned(tenantId, id);
    this.assertLifecycle(campaign.lifecycle, CampaignLifecycle.SCHEDULED);

    const when = new Date(dto.scheduledAt);
    if (when.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'scheduledAt must be in the future',
      });
    }
    campaign.lifecycle = CampaignLifecycle.SCHEDULED;
    campaign.scheduled_at = when;
    await this.campaigns.save(campaign);
    return this.loadOwned(tenantId, id);
  }

  /**
   * Launch immediately. In one DB transaction: flip lifecycle → ACTIVE, take the
   * current IDLE run to ENQUEUEING with a frozen audience size, and write the
   * launch OutboxJob. The relay publishes it to the launch queue.
   */
  async launch(
    tenantId: string,
    id: string,
    dto: LaunchCampaignDto,
  ): Promise<Campaign> {
    await this.dataSource.transaction(async (mgr) => {
      const campaign = await mgr.findOne(Campaign, {
        where: { id, tenant: { id: tenantId }, deleted_at: IsNull() },
      });
      if (!campaign) {
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Campaign not found' });
      }
      this.assertLifecycle(campaign.lifecycle, CampaignLifecycle.ACTIVE);

      const run = await this.runs.currentEditable(tenantId, id, mgr);
      const total = await mgr.count(CampaignRecipient, {
        where: { run: { id: run.id }, processing: RecipientProcessing.PENDING },
      });
      if (total === 0 && !dto.force) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message:
            'Campaign run has no pending recipients. Add recipients or launch with force=true.',
        });
      }

      campaign.lifecycle = CampaignLifecycle.ACTIVE;
      if (!campaign.scheduled_at) campaign.scheduled_at = new Date();
      await mgr.save(campaign);

      run.execution = CampaignExecution.ENQUEUEING;
      run.total_recipients = total;
      run.queued = total;
      run.started_at = new Date();
      await mgr.save(run);

      await mgr.save(
        mgr.create(OutboxJob, {
          queue: QUEUE.CAMPAIGNS_LAUNCH,
          job_name: JOB.CAMPAIGNS_LAUNCH,
          dedupe_key: `campaign-launch:${run.id}`,
          payload: {
            tenantId,
            campaignId: id,
            runId: run.id,
            idempotencyKey: run.idempotency_key,
          },
        }),
      );
      this.logger.log(
        `Campaign ${id} launched (run=${run.id}, total=${total}) — outbox queued`,
      );
    });
    return this.loadOwned(tenantId, id);
  }

  async pause(tenantId: string, id: string): Promise<Campaign> {
    await this.dataSource.transaction(async (mgr) => {
      const campaign = await this.loadOwnedTx(mgr, tenantId, id);
      this.assertLifecycle(campaign.lifecycle, CampaignLifecycle.PAUSED);
      campaign.lifecycle = CampaignLifecycle.PAUSED;
      await mgr.save(campaign);

      // Move an in-flight run to DRAINING — the dispatch claim guard then makes
      // not-yet-started recipients exit as SKIPPED while in-flight ones finish.
      const run = await this.runs.latest(tenantId, id, mgr);
      if (run && run.execution === CampaignExecution.PROCESSING) {
        run.execution = CampaignExecution.DRAINING;
        await mgr.save(run);
      }
    });
    return this.loadOwned(tenantId, id);
  }

  async resume(tenantId: string, id: string): Promise<Campaign> {
    await this.dataSource.transaction(async (mgr) => {
      const campaign = await this.loadOwnedTx(mgr, tenantId, id);
      this.assertLifecycle(campaign.lifecycle, CampaignLifecycle.ACTIVE);
      campaign.lifecycle = CampaignLifecycle.ACTIVE;
      await mgr.save(campaign);

      const run = await this.runs.latest(tenantId, id, mgr);
      if (run && run.execution === CampaignExecution.DRAINING) {
        run.execution = CampaignExecution.PROCESSING;
        await mgr.save(run);
        // Re-fan-out any still-PENDING recipients from the start cursor.
        await mgr.save(
          mgr.create(OutboxJob, {
            queue: QUEUE.CAMPAIGNS_FANOUT,
            job_name: JOB.CAMPAIGNS_FANOUT_CHUNK,
            dedupe_key: `campaign-fanout:${run.id}:resume:${Date.now()}`,
            payload: { tenantId, campaignId: id, runId: run.id, cursor: null },
          }),
        );
      }
    });
    return this.loadOwned(tenantId, id);
  }

  async cancel(
    tenantId: string,
    id: string,
    _dto: CancelCampaignDto,
  ): Promise<Campaign> {
    await this.dataSource.transaction(async (mgr) => {
      const campaign = await this.loadOwnedTx(mgr, tenantId, id);
      this.assertLifecycle(campaign.lifecycle, CampaignLifecycle.ARCHIVED);
      campaign.lifecycle = CampaignLifecycle.ARCHIVED;
      campaign.deleted_at = new Date();
      await mgr.save(campaign);

      const run = await this.runs.latest(tenantId, id, mgr);
      if (
        run &&
        (run.execution === CampaignExecution.PROCESSING ||
          run.execution === CampaignExecution.ENQUEUEING)
      ) {
        run.execution = CampaignExecution.FAILED;
        run.finished_at = new Date();
        await mgr.save(run);
      }
    });
    return this.loadOwned(tenantId, id);
  }

  /**
   * Re-runs a campaign's FAILED recipients in a NEW run. Copies the failed
   * recipients of the latest run as PENDING into a fresh run, then enqueues a
   * launch via the outbox. No synchronous mass-send.
   */
  async retryFailed(tenantId: string, id: string) {
    return this.dataSource.transaction(async (mgr) => {
      const campaign = await this.loadOwnedTx(mgr, tenantId, id);
      const prev = await this.runs.latest(tenantId, id, mgr);
      if (!prev) return { requeued: 0, runId: null };

      const failed = await mgr.find(CampaignRecipient, {
        where: { run: { id: prev.id }, processing: RecipientProcessing.FAILED },
        relations: { customer: true },
        select: { id: true, customer: { id: true } },
      });
      if (failed.length === 0) return { requeued: 0, runId: null };

      const run = await this.runs.create(tenantId, id, mgr);
      await mgr
        .createQueryBuilder()
        .insert()
        .into(CampaignRecipient)
        .values(
          failed.map((r) => ({
            run: { id: run.id } as CampaignRun,
            campaign: { id } as Campaign,
            customer: { id: r.customer.id },
            processing: RecipientProcessing.PENDING,
          })),
        )
        .orIgnore()
        .execute();

      run.execution = CampaignExecution.ENQUEUEING;
      run.total_recipients = failed.length;
      run.queued = failed.length;
      run.started_at = new Date();
      await mgr.save(run);

      if (campaign.lifecycle !== CampaignLifecycle.ACTIVE) {
        campaign.lifecycle = CampaignLifecycle.ACTIVE;
        await mgr.save(campaign);
      }

      await mgr.save(
        mgr.create(OutboxJob, {
          queue: QUEUE.CAMPAIGNS_LAUNCH,
          job_name: JOB.CAMPAIGNS_LAUNCH,
          dedupe_key: `campaign-launch:${run.id}`,
          payload: {
            tenantId,
            campaignId: id,
            runId: run.id,
            idempotencyKey: run.idempotency_key,
          },
        }),
      );
      return { requeued: failed.length, runId: run.id };
    });
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async loadOwned(tenantId: string, id: string): Promise<Campaign> {
    const campaign = await this.campaigns.findOne({
      where: { id, tenant: { id: tenantId }, deleted_at: IsNull() },
      relations: { template: true },
    });
    if (!campaign) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Campaign not found' });
    }
    return campaign;
  }

  private async loadOwnedTx(
    mgr: DataSource['manager'],
    tenantId: string,
    id: string,
  ): Promise<Campaign> {
    const campaign = await mgr.findOne(Campaign, {
      where: { id, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!campaign) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Campaign not found' });
    }
    return campaign;
  }

  private assertLifecycle(from: CampaignLifecycle, to: CampaignLifecycle): void {
    if (from === to) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Campaign is already in lifecycle "${to}"`,
      });
    }
    if (TERMINAL_LIFECYCLES.includes(from)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A "${from}" campaign is terminal and cannot transition`,
      });
    }
    if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Illegal campaign lifecycle transition: ${from} → ${to}`,
        context: { allowed: LIFECYCLE_TRANSITIONS[from] },
      });
    }
  }
}
