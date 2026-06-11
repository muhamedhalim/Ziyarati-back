import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignStatus, RecipientStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { QueueService } from '../../queue/queue.service';
import { CampaignDeliveryFactory } from './delivery/campaign-delivery.factory';
import { ScheduleCampaignDto } from './dto/schedule-campaign.dto';
import { LaunchCampaignDto } from './dto/launch-campaign.dto';
import { CancelCampaignDto } from './dto/cancel-campaign.dto';
import {
  CAMPAIGN_CHANNEL,
  CAMPAIGN_STATUS_TRANSITIONS,
  TERMINAL_CAMPAIGN_STATUSES,
} from './campaign.constants';

/**
 * Campaign lifecycle + execution. This is the QUEUE-READY seam:
 *  - schedule/launch set the campaign status (the "produce" step). A future
 *    BullMQ producer would, in the same call, enqueue a (delayed) job whose
 *    consumer calls `dispatchRecipient` for each QUEUED recipient.
 *  - `dispatchRecipient` is the single per-recipient send seam — it resolves a
 *    provider via the factory (loosely coupled) and updates recipient status.
 *  - `retryFailed` re-queues FAILED recipients (no synchronous mass-send) so a
 *    worker/backoff policy can re-attempt them.
 *
 * Tenant isolation: campaigns are loaded with `tenant: { id: tenantId }`;
 * recipients are scoped through their campaign id.
 */
@Injectable()
export class CampaignExecutionService {
  private readonly logger = new Logger('CampaignExecutionService');

  constructor(
    @InjectRepository(Campaign)
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient)
    private readonly recipients: Repository<CampaignRecipient>,
    private readonly delivery: CampaignDeliveryFactory,
    private readonly queue: QueueService,
  ) {}

  async schedule(
    tenantId: string,
    id: string,
    dto: ScheduleCampaignDto,
  ): Promise<Campaign> {
    const campaign = await this.loadOwned(tenantId, id);
    this.assertTransition(campaign.status, CampaignStatus.SCHEDULED);

    const when = new Date(dto.scheduledAt);
    if (when.getTime() <= Date.now()) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'scheduledAt must be in the future',
      });
    }
    campaign.status = CampaignStatus.SCHEDULED;
    campaign.scheduled_at = when;
    await this.campaigns.save(campaign);
    return this.loadOwned(tenantId, id);
  }

  async launch(
    tenantId: string,
    id: string,
    dto: LaunchCampaignDto,
  ): Promise<Campaign> {
    const campaign = await this.loadOwned(tenantId, id);
    this.assertTransition(campaign.status, CampaignStatus.RUNNING);

    if (!dto.force) {
      const recipientCount = await this.recipients.count({
        where: { campaign: { id } },
      });
      if (recipientCount === 0) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: 'Campaign has no recipients. Add recipients or launch with force=true.',
        });
      }
    }

    campaign.status = CampaignStatus.RUNNING;
    if (!campaign.scheduled_at) campaign.scheduled_at = new Date();
    await this.campaigns.save(campaign);

    // Produce the fan-out job; the campaigns worker enqueues one
    // processRecipient job per QUEUED recipient (each retried independently).
    await this.queue.enqueueCampaignLaunch({ tenantId, campaignId: id });
    this.logger.log(`Campaign ${id} launched (RUNNING) — fan-out enqueued`);
    return this.loadOwned(tenantId, id);
  }

  async pause(tenantId: string, id: string): Promise<Campaign> {
    const campaign = await this.loadOwned(tenantId, id);
    this.assertTransition(campaign.status, CampaignStatus.PAUSED);
    campaign.status = CampaignStatus.PAUSED;
    await this.campaigns.save(campaign);
    return this.loadOwned(tenantId, id);
  }

  async resume(tenantId: string, id: string): Promise<Campaign> {
    const campaign = await this.loadOwned(tenantId, id);
    this.assertTransition(campaign.status, CampaignStatus.RUNNING);
    campaign.status = CampaignStatus.RUNNING;
    await this.campaigns.save(campaign);
    return this.loadOwned(tenantId, id);
  }

  async cancel(
    tenantId: string,
    id: string,
    _dto: CancelCampaignDto,
  ): Promise<Campaign> {
    const campaign = await this.loadOwned(tenantId, id);
    this.assertTransition(campaign.status, CampaignStatus.CANCELLED);
    campaign.status = CampaignStatus.CANCELLED;
    await this.campaigns.save(campaign);
    return this.loadOwned(tenantId, id);
  }

  /** Re-queues a campaign's FAILED recipients and enqueues a delivery job each. */
  async retryFailed(tenantId: string, id: string) {
    await this.loadOwned(tenantId, id);
    const failed = await this.recipients.find({
      where: { campaign: { id }, status: RecipientStatus.FAILED },
      select: { id: true },
    });
    if (failed.length === 0) return { requeued: 0 };

    const ids = failed.map((r) => r.id);
    await this.recipients.update({ id: In(ids) }, { status: RecipientStatus.QUEUED });
    for (const recipientId of ids) {
      await this.queue.enqueueCampaignRecipient({ tenantId, recipientId });
    }
    return { requeued: ids.length };
  }

  /** QUEUED recipient ids for a campaign (tenant-scoped) — used by the launch fan-out. */
  async queuedRecipientIds(tenantId: string, campaignId: string): Promise<string[]> {
    await this.loadOwned(tenantId, campaignId);
    const rows = await this.recipients.find({
      where: { campaign: { id: campaignId }, status: RecipientStatus.QUEUED },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Per-recipient delivery seam — the method a queue worker calls. Resolves the
   * channel provider via the factory and updates the recipient status. Not a
   * REST endpoint; exported for the future worker / scheduled processor.
   */
  async dispatchRecipient(tenantId: string, recipientId: string) {
    const recipient = await this.recipients.findOne({
      where: { id: recipientId, campaign: { tenant: { id: tenantId } } },
      relations: { campaign: { template: true }, customer: true },
    });
    if (!recipient) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Recipient not found' });
    }

    const channel = CAMPAIGN_CHANNEL.WHATSAPP; // campaign template is WhatsApp
    const provider = this.delivery.resolve(channel);

    let result;
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
      this.logger.error(`Provider "${provider.name}" threw during send`, err as Error);
      result = { success: false, error: (err as Error)?.message ?? 'provider error' };
    }

    recipient.status = result.success ? RecipientStatus.SENT : RecipientStatus.FAILED;
    if (result.success) recipient.sent_at = new Date();
    await this.recipients.save(recipient);

    return { recipient, result };
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

  private assertTransition(from: CampaignStatus, to: CampaignStatus): void {
    if (from === to) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Campaign is already in status "${to}"`,
      });
    }
    if (TERMINAL_CAMPAIGN_STATUSES.includes(from)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A "${from}" campaign is terminal and cannot transition`,
      });
    }
    if (!CAMPAIGN_STATUS_TRANSITIONS[from].includes(to)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Illegal campaign transition: ${from} → ${to}`,
        context: { allowed: CAMPAIGN_STATUS_TRANSITIONS[from] },
      });
    }
  }
}
