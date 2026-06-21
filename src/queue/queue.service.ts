import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, JobsOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { TenantContextService } from '../core/tenant-context/tenant-context.service';
import { ALL_QUEUES, JOB, QUEUE, QueueName } from './queue.constants';
import {
  AiExecuteJob,
  AnalyticsAggregateJob,
  AnalyticsCleanupJob,
  AnalyticsGenerateReportJob,
  BaseJobData,
  CampaignLaunchJob,
  CampaignProcessRecipientJob,
  NotificationDispatchJob,
  RefundsReapJob,
  SettlementsProcessJob,
  SubscriptionsRenewalCheckJob,
  WhatsappSendJob,
} from './job-data.interface';

/**
 * The single producer facade for the whole platform.
 *
 * Domain services inject this (one global provider) instead of BullMQ tokens, so
 * they stay decoupled from the queue plumbing. Every enqueue is stamped with the
 * current tenant context (correlationId + actorId from TenantContextService), and
 * retry-sensitive jobs get DETERMINISTIC job ids so a retry/duplicate enqueue is
 * idempotent at the queue layer.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger('QueueService');
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    @InjectQueue(QUEUE.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(QUEUE.WHATSAPP) whatsapp: Queue,
    @InjectQueue(QUEUE.CAMPAIGNS) campaigns: Queue,
    @InjectQueue(QUEUE.AI) ai: Queue,
    @InjectQueue(QUEUE.ANALYTICS) analytics: Queue,
    @InjectQueue(QUEUE.SETTLEMENTS) settlements: Queue,
    @InjectQueue(QUEUE.SUBSCRIPTIONS) subscriptions: Queue,
    @InjectQueue(QUEUE.REFUNDS) refunds: Queue,
    private readonly ctx: TenantContextService,
  ) {
    this.queues = {
      [QUEUE.NOTIFICATIONS]: notifications,
      [QUEUE.WHATSAPP]: whatsapp,
      [QUEUE.CAMPAIGNS]: campaigns,
      [QUEUE.AI]: ai,
      [QUEUE.ANALYTICS]: analytics,
      [QUEUE.SETTLEMENTS]: settlements,
      [QUEUE.SUBSCRIPTIONS]: subscriptions,
      [QUEUE.REFUNDS]: refunds,
    };
  }

  // ── Typed producers ─────────────────────────────────────────────────────

  enqueueNotificationDispatch(data: NotificationDispatchJob, opts?: JobsOptions) {
    return this.add(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_DISPATCH, data, {
      jobId: `notification:${data.notificationId}`, // idempotent (1 job per notification)
      ...opts,
    });
  }

  /** Manual retry: unique job id so it re-runs even if the prior job lingers. */
  retryNotificationDispatch(data: NotificationDispatchJob, opts?: JobsOptions) {
    return this.add(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_DISPATCH, data, {
      jobId: `notification:${data.notificationId}:retry:${Date.now()}`,
      ...opts,
    });
  }

  /** Best-effort removal of a scheduled (delayed) notification job. */
  async removeNotificationDispatch(notificationId: string): Promise<void> {
    const job = await this.queues[QUEUE.NOTIFICATIONS].getJob(`notification:${notificationId}`);
    if (job) await job.remove().catch(() => undefined);
  }

  enqueueWhatsappSend(data: WhatsappSendJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP, JOB.WHATSAPP_SEND, data, opts);
  }

  enqueueWhatsappRetry(data: WhatsappSendJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP, JOB.WHATSAPP_RETRY, data, opts);
  }

  enqueueCampaignLaunch(data: CampaignLaunchJob, opts?: JobsOptions) {
    return this.add(QUEUE.CAMPAIGNS, JOB.CAMPAIGNS_LAUNCH, data, {
      jobId: `campaign-launch:${data.campaignId}`,
      ...opts,
    });
  }

  enqueueCampaignRecipient(data: CampaignProcessRecipientJob, opts?: JobsOptions) {
    return this.add(QUEUE.CAMPAIGNS, JOB.CAMPAIGNS_PROCESS_RECIPIENT, data, {
      jobId: `campaign-recipient:${data.recipientId}`, // idempotent per recipient
      ...opts,
    });
  }

  enqueueAiExecute(data: AiExecuteJob, opts?: JobsOptions) {
    return this.add(QUEUE.AI, JOB.AI_EXECUTE, data, opts);
  }

  enqueueAnalyticsAggregate(data: AnalyticsAggregateJob, opts?: JobsOptions) {
    return this.add(QUEUE.ANALYTICS, JOB.ANALYTICS_AGGREGATE, data, opts);
  }

  enqueueAnalyticsReport(data: AnalyticsGenerateReportJob, opts?: JobsOptions) {
    return this.add(QUEUE.ANALYTICS, JOB.ANALYTICS_GENERATE_REPORT, data, opts);
  }

  enqueueAnalyticsCleanup(data: AnalyticsCleanupJob, opts?: JobsOptions) {
    return this.add(QUEUE.ANALYTICS, JOB.ANALYTICS_CLEANUP, data, opts);
  }

  enqueueSettlementsProcess(data: SettlementsProcessJob, opts?: JobsOptions) {
    return this.add(QUEUE.SETTLEMENTS, JOB.SETTLEMENTS_PROCESS, data, opts);
  }

  enqueueSubscriptionsRenewalCheck(data: SubscriptionsRenewalCheckJob, opts?: JobsOptions) {
    return this.add(QUEUE.SUBSCRIPTIONS, JOB.SUBSCRIPTIONS_RENEWAL_CHECK, data, opts);
  }

  enqueueRefundsReap(data: RefundsReapJob, opts?: JobsOptions) {
    return this.add(QUEUE.REFUNDS, JOB.REFUNDS_REAP, data, opts);
  }

  // ── Repeatable (scheduled) jobs ──────────────────────────────────────────

  /** Idempotent: BullMQ dedups repeatables by their {name, repeat} key. */
  addRepeatable(queue: QueueName, name: string, data: BaseJobData, cronPattern: string) {
    return this.queues[queue].add(name, this.stamp(data), {
      repeat: { pattern: cronPattern },
    });
  }

  // ── Health helpers (used by HealthController) ────────────────────────────

  /** Small shared-Redis KV used for cross-process operational signals (e.g. the
   *  reaper heartbeat read by the API's metrics endpoint). */
  async kvSet(key: string, value: string, ttlSec?: number): Promise<void> {
    const client = (await this.queues[QUEUE.NOTIFICATIONS].client) as unknown as Redis;
    if (ttlSec) await client.set(key, value, 'EX', ttlSec);
    else await client.set(key, value);
  }

  async kvGet(key: string): Promise<string | null> {
    const client = (await this.queues[QUEUE.NOTIFICATIONS].client) as unknown as Redis;
    return client.get(key);
  }

  async redisPing(): Promise<number> {
    const client = (await this.queues[QUEUE.NOTIFICATIONS].client) as unknown as Redis;
    const started = Date.now();
    await client.ping();
    return Date.now() - started;
  }

  async queueCounts(): Promise<Record<string, Record<string, number>>> {
    const entries = await Promise.all(
      ALL_QUEUES.map(
        async (name) =>
          [name, await this.queues[name].getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  queue(name: QueueName): Queue {
    return this.queues[name];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async add<T extends BaseJobData>(
    queue: QueueName,
    name: string,
    data: T,
    opts?: JobsOptions,
  ): Promise<Job> {
    const stamped = this.stamp(data);
    const job = await this.queues[queue].add(name, stamped, opts);
    this.logger.log(
      `enqueued ${name} job=${job.id} tenant=${stamped.tenantId ?? '-'} cid=${stamped.correlationId ?? '-'}`,
    );
    return job;
  }

  /** Stamp tenant context (correlationId + actorId) onto the payload when absent. */
  private stamp<T extends BaseJobData>(data: T): T {
    return {
      ...data,
      correlationId: data.correlationId ?? this.ctx.getCorrelationId() ?? undefined,
      actorId: data.actorId ?? this.ctx.getUser()?.id,
    };
  }
}
