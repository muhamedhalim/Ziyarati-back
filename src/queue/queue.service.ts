import { Injectable, Logger } from '@nestjs/common';
import { Job, JobsOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';

import { TenantContextService } from '../core/tenant-context/tenant-context.service';
import { ProducerQueues } from './producer-queues';
import { ALL_QUEUES, BACKOFF_EXPO_JITTER, JOB, QUEUE, QueueName } from './queue.constants';
import {
  AiExecuteJob,
  AnalyticsAggregateJob,
  AnalyticsCleanupJob,
  AnalyticsGenerateReportJob,
  BaseJobData,
  CampaignDlqJob,
  CampaignFanoutChunkJob,
  CampaignLaunchJob,
  CampaignProcessRecipientJob,
  EmailSendJob,
  NotificationDispatchJob,
  NotificationDlqJob,
  RefundsReapJob,
  PaymentsReconcileJob,
  SettlementsProcessJob,
  SubscriptionsRenewalCheckJob,
  UsageReportRunJob,
  WhatsappSendJob,
  WhatsappWebhookProcessJob,
  WhatsappMediaDownloadJob,
  WhatsappDlqJob,
  WebhookDeliverJob,
  WebhookDlqJob,
  WorkflowActionJob,
  WorkflowRunJob,
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
    private readonly producers: ProducerQueues,
    private readonly ctx: TenantContextService,
  ) {
    // All enqueues go through the dedicated PRODUCER-profile Queue instances.
    this.queues = producers.record();
  }

  // ── Typed producers ─────────────────────────────────────────────────────

  enqueueNotificationDispatch(data: NotificationDispatchJob, opts?: JobsOptions) {
    return this.add(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_DISPATCH, data, {
      jobId: `notification-${data.notificationId}`, // idempotent (1 job per notification)
      ...opts,
    });
  }

  /** Manual retry: unique job id so it re-runs even if the prior job lingers. */
  retryNotificationDispatch(data: NotificationDispatchJob, opts?: JobsOptions) {
    return this.add(QUEUE.NOTIFICATIONS, JOB.NOTIFICATIONS_DISPATCH, data, {
      jobId: `notification-${data.notificationId}-retry-${Date.now()}`,
      ...opts,
    });
  }

  /** Best-effort removal of a scheduled (delayed) notification job. */
  async removeNotificationDispatch(notificationId: string): Promise<void> {
    const job = await this.queues[QUEUE.NOTIFICATIONS].getJob(`notification-${notificationId}`);
    if (job) await job.remove().catch(() => undefined);
  }

  /** Bulk-enqueue dispatch jobs (used by the maintenance sweep). Idempotent ids. */
  enqueueNotificationDispatchBulk(items: NotificationDispatchJob[]) {
    if (items.length === 0) return Promise.resolve([] as Job[]);
    return this.queues[QUEUE.NOTIFICATIONS].addBulk(
      items.map((data) => ({
        name: JOB.NOTIFICATIONS_DISPATCH,
        data: this.stamp(data),
        opts: { jobId: `notification-${data.notificationId}` },
      })),
    );
  }

  /** Park an exhausted notification dispatch in the DLQ (never auto-processed). */
  enqueueNotificationDlq(data: NotificationDlqJob, opts?: JobsOptions) {
    return this.add(QUEUE.NOTIFICATIONS_DLQ, JOB.NOTIFICATIONS_DLQ, data, {
      jobId: `notif-dlq-${data.notificationId}-${Date.now()}`,
      ...opts,
    });
  }

  enqueueWhatsappSend(data: WhatsappSendJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP_OUTBOUND, JOB.WHATSAPP_SEND, data, opts);
  }

  enqueueWhatsappRetry(data: WhatsappSendJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP_OUTBOUND, JOB.WHATSAPP_RETRY, data, opts);
  }

  /**
   * Process a persisted inbound webhook event.
   *
   * The jobId is the event id, so Meta redelivering the same event (or a manual
   * retry) collapses onto one job instead of processing a patient's message
   * twice. Ingestion already de-duplicates on the `wamid`; this is the second,
   * queue-level floor.
   */
  enqueueWhatsappWebhook(data: WhatsappWebhookProcessJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP_WEBHOOK, JOB.WHATSAPP_WEBHOOK_PROCESS, data, {
      jobId: `wa-webhook-${data.webhookEventId}`,
      ...opts,
    });
  }

  /**
   * Download one inbound media object. Deduped per (message, media) so a
   * retried webhook cannot attach the same file twice.
   */
  enqueueWhatsappMediaDownload(data: WhatsappMediaDownloadJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP_MEDIA, JOB.WHATSAPP_MEDIA_DOWNLOAD, data, {
      jobId: `wa-media-${data.messageId}-${data.mediaId}`,
      ...opts,
    });
  }

  /**
   * Park an exhausted whatsapp-webhook/whatsapp-media job (never
   * auto-processed; inspected/replayed by admin tooling, same pattern as
   * `enqueueCampaignDlq`).
   */
  enqueueWhatsappDlq(data: WhatsappDlqJob, opts?: JobsOptions) {
    return this.add(QUEUE.WHATSAPP_DLQ, JOB.WHATSAPP_DLQ, data, {
      jobId: `dlq-${data.sourceQueue}-${data.originalJobId ?? Date.now()}`,
      ...opts,
    });
  }

  // ── Campaign pipeline ────────────────────────────────────────────────────

  /** Launch fan-out kick-off. Idempotent per run. */
  enqueueCampaignLaunch(data: CampaignLaunchJob, opts?: JobsOptions) {
    return this.add(QUEUE.CAMPAIGNS_LAUNCH, JOB.CAMPAIGNS_LAUNCH, data, {
      jobId: `campaign-launch-${data.runId}`,
      ...opts,
    });
  }

  /** One keyset window of a run's audience. Idempotent per (run, cursor). */
  enqueueCampaignFanoutChunk(data: CampaignFanoutChunkJob, opts?: JobsOptions) {
    return this.add(QUEUE.CAMPAIGNS_FANOUT, JOB.CAMPAIGNS_FANOUT_CHUNK, data, {
      jobId: `campaign-fanout-${data.runId}-${data.cursor ?? 'start'}`,
      ...opts,
    });
  }

  /** Single recipient send. Idempotent per (run, recipient). */
  enqueueCampaignRecipient(data: CampaignProcessRecipientJob, opts?: JobsOptions) {
    return this.add(QUEUE.CAMPAIGNS_PROCESS, JOB.CAMPAIGNS_PROCESS_RECIPIENT, data, {
      jobId: `campaign-recipient-${data.runId}-${data.recipientId}`,
      ...opts,
    });
  }

  /**
   * Bulk-enqueue recipient send jobs in ONE Redis round-trip. The fan-out uses
   * this so millions of recipients become thousands of `addBulk` calls, not
   * millions of sequential `add`s.
   */
  enqueueCampaignRecipientsBulk(
    items: { data: CampaignProcessRecipientJob; opts?: JobsOptions }[],
  ) {
    if (items.length === 0) return Promise.resolve([] as Job[]);
    return this.queues[QUEUE.CAMPAIGNS_PROCESS].addBulk(
      items.map((it) => ({
        name: JOB.CAMPAIGNS_PROCESS_RECIPIENT,
        data: this.stamp(it.data),
        opts: {
          jobId: `campaign-recipient-${it.data.runId}-${it.data.recipientId}`,
          backoff: { type: BACKOFF_EXPO_JITTER },
          ...it.opts,
        },
      })),
    );
  }

  /** Park a dead-letter job (never auto-processed; replayed by admin tooling). */
  enqueueCampaignDlq(data: CampaignDlqJob, opts?: JobsOptions) {
    return this.add(QUEUE.CAMPAIGNS_DLQ, JOB.CAMPAIGNS_DLQ, data, {
      jobId: `dlq-${data.sourceQueue}-${data.originalJobId ?? Date.now()}`,
      ...opts,
    });
  }

  enqueueAiExecute(data: AiExecuteJob, opts?: JobsOptions) {
    return this.add(QUEUE.AI, JOB.AI_EXECUTE, data, {
      jobId: `ai-${createHash('sha256').update(`${data.tenantId}:${data.idempotencyKey}`).digest('hex')}`,
      // Provider retries are owned by the provider adapter. BullMQ must never
      // replay a possibly-paid request or a completed tool side effect.
      attempts: 1,
      ...opts,
    });
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

  enqueuePaymentsReconcile(data: PaymentsReconcileJob, opts?: JobsOptions) {
    return this.add(QUEUE.PAYMENTS, JOB.PAYMENTS_RECONCILE, data, opts);
  }

  /**
   * Enqueue a transactional email. The `idempotencyKey` becomes the jobId so a
   * duplicate enqueue is a no-op at the queue layer (and again at the email-log
   * layer in the delivery service).
   */
  enqueueEmail(data: EmailSendJob, opts?: JobsOptions) {
    return this.add(QUEUE.EMAIL, JOB.EMAIL_SEND, data, {
      ...(data.idempotencyKey ? { jobId: `email-${data.idempotencyKey}` } : {}),
      ...opts,
    });
  }

  /** Enqueue a single scheduled-report run. Idempotent per (schedule, minute). */
  enqueueUsageReportRun(data: UsageReportRunJob, opts?: JobsOptions) {
    const minute = Math.floor(Date.now() / 60_000);
    return this.add(QUEUE.USAGE_REPORT, JOB.USAGE_REPORT_RUN, data, {
      jobId: `usage-report-${data.scheduleId}-${minute}`,
      ...opts,
    });
  }

  // ── Workflow engine ──────────────────────────────────────────────────────
  //
  // Every job id in this file uses DASHES only (never `:`) — BullMQ's
  // custom-id validator rejects any id containing `:` unless it splits into
  // EXACTLY 3 parts (a legacy compatibility rule for its own repeatable-job
  // ids; see node_modules/bullmq/dist/cjs/classes/job.js `validateOptions`).
  // The 2- and 4-part colon ids that used to live throughout this file threw
  // "Custom Id cannot contain :" on every real (non-mocked) enqueue call —
  // caught and swallowed by each caller's try/catch, so webhook/notification/
  // campaign-launch/email jobs were silently never queued against real Redis.
  // Found by an HTTP e2e test that actually boots the app against real
  // Postgres + Redis; unit tests mock QueueService entirely and can't catch
  // this class of runtime-only failure — same as the workflow-engine
  // discovery below.

  /** Kick off a workflow run. Idempotent per run (one fan-out job per run). */
  enqueueWorkflowRun(data: WorkflowRunJob, opts?: JobsOptions) {
    return this.add(QUEUE.WORKFLOW, JOB.WORKFLOW_RUN, data, {
      jobId: `wf-run-${data.runId}`,
      ...opts,
    });
  }

  /**
   * Execute one action of a run. Idempotent per (run, action); `delay` carries
   * the action's configured delay and the default job options add retry/backoff.
   */
  enqueueWorkflowAction(data: WorkflowActionJob, opts?: JobsOptions) {
    return this.add(QUEUE.WORKFLOW, JOB.WORKFLOW_ACTION, data, {
      jobId: `wf-action-${data.runId}-${data.actionIndex}`,
      ...opts,
    });
  }

  /**
   * Manual retry of one FAILED action. Unique job id (unlike
   * `enqueueWorkflowAction`) so it re-runs even though the original attempt's
   * job still exists in BullMQ's failed set (`removeOnFail: false`).
   */
  retryWorkflowAction(data: WorkflowActionJob, opts?: JobsOptions) {
    return this.add(QUEUE.WORKFLOW, JOB.WORKFLOW_ACTION, data, {
      jobId: `wf-action-${data.runId}-${data.actionIndex}-retry-${Date.now()}`,
      ...opts,
    });
  }

  // ── Outbound webhooks (Phase 2 — Integration platform) ──────────────────

  /**
   * Deliver one webhook delivery attempt. Idempotent per delivery row: the
   * deterministic jobId means a domain event that races an existing enqueue
   * (or a duplicate `@OnEvent` fan-out) collapses onto one job.
   */
  enqueueWebhookDeliver(data: WebhookDeliverJob, opts?: JobsOptions) {
    return this.add(QUEUE.WEBHOOKS_DELIVER, JOB.WEBHOOKS_DELIVER, data, {
      jobId: `webhook-delivery-${data.webhookDeliveryId}`,
      ...opts,
    });
  }

  /**
   * Manual replay from the dashboard. Unique job id (unlike
   * `enqueueWebhookDeliver`) so it re-runs even though the original attempt's
   * job still exists in BullMQ's retained failed/completed set.
   */
  retryWebhookDeliver(data: WebhookDeliverJob, opts?: JobsOptions) {
    return this.add(QUEUE.WEBHOOKS_DELIVER, JOB.WEBHOOKS_DELIVER, data, {
      jobId: `webhook-delivery-${data.webhookDeliveryId}-retry-${Date.now()}`,
      ...opts,
    });
  }

  /**
   * Park an exhausted webhook delivery (never auto-processed; platform
   * ops-depth visibility only — the tenant-facing replay flow operates on the
   * `webhook_deliveries` row directly, never on this queue, so a tenant can
   * never read or replay another tenant's parked job by guessing a jobId).
   */
  enqueueWebhookDlq(data: WebhookDlqJob, opts?: JobsOptions) {
    return this.add(QUEUE.WEBHOOKS_DLQ, JOB.WEBHOOKS_DLQ, data, {
      jobId: `webhook-dlq-${data.originalJobId ?? Date.now()}`,
      ...opts,
    });
  }

  // ── Generic / relay primitives ───────────────────────────────────────────

  /**
   * Low-level publish used by the OUTBOX RELAY. `dedupeKey` becomes the jobId so
   * an at-least-once relay is idempotent at the queue layer.
   */
  publish(
    queue: QueueName,
    name: string,
    data: BaseJobData,
    dedupeKey: string,
    opts?: JobsOptions,
  ): Promise<Job> {
    return this.add(queue, name, data, { jobId: dedupeKey, ...opts });
  }

  // ── Repeatable (scheduled) jobs ──────────────────────────────────────────

  /** Idempotent: BullMQ dedups repeatables by their {name, repeat} key. */
  addRepeatable(queue: QueueName, name: string, data: BaseJobData, cronPattern: string) {
    return this.queues[queue].add(name, this.stamp(data), {
      repeat: { pattern: cronPattern },
    });
  }

  // ── Health helpers (used by HealthController) ────────────────────────────

  async kvSet(key: string, value: string, ttlSec?: number): Promise<void> {
    const client = (await this.queues[QUEUE.NOTIFICATIONS].client) as unknown as Redis;
    if (ttlSec) await client.set(key, value, 'EX', ttlSec);
    else await client.set(key, value);
  }

  async kvGet(key: string): Promise<string | null> {
    const client = (await this.queues[QUEUE.NOTIFICATIONS].client) as unknown as Redis;
    return client.get(key);
  }

  /** Shared ioredis client (used by the per-tenant rate limiter Lua script). */
  async client(): Promise<Redis> {
    return (await this.queues[QUEUE.NOTIFICATIONS].client) as unknown as Redis;
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

  /** Current DLQ depth (waiting + delayed) — surfaced by monitoring/alerting. */
  async dlqDepth(queue: QueueName = QUEUE.CAMPAIGNS_DLQ): Promise<number> {
    const counts = await this.queues[queue].getJobCounts('waiting', 'delayed');
    return (counts.waiting ?? 0) + (counts.delayed ?? 0);
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
