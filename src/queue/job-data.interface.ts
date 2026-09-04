/**
 * Every job carries the multi-tenant context so the worker can restore it before
 * executing domain logic. `tenantId` is null only for platform-level sweeps.
 */
export interface BaseJobData {
  tenantId: string | null;
  /** Correlation id for tracing a logical request across API → queue → worker. */
  correlationId?: string;
  /** The user who triggered the work, when known. */
  actorId?: string;
  /**
   * Payload schema version (gap-closure — see docs/CACHING_QUEUES_AUDIT.md
   * M2). Optional/absent means "version 1," the only shape that has ever
   * existed — nothing branches on this yet since no job payload has changed
   * shape since this field was added. Reserved so a FUTURE breaking payload
   * change has a place to signal it (old-shape jobs already in Redis during
   * a rolling deploy would omit it and be treated as v1 by definition, never
   * silently mis-parsed as the new shape).
   */
  v?: number;
}

// ── Refunds (R2 reaper sweep — platform-level, tenantId null) ───────────────
export type RefundsReapJob = BaseJobData;

// ── Payments (reconciliation sweep — platform-level, tenantId null) ─────────
export type PaymentsReconcileJob = BaseJobData;

// ── Email (transactional send) ─────────────────────────────────────────────
export interface EmailSendJob extends BaseJobData {
  /** Recipient address(es). */
  to: string | string[];
  /** Template key (see EMAIL_TEMPLATES). */
  template: string;
  /** Template variables (no secrets). */
  variables?: Record<string, unknown>;
  locale?: string;
  /** Idempotency key — dedupes at the queue AND the email-log level. */
  idempotencyKey?: string;
  replyTo?: string;
}

// ── Usage reports (scheduled) ──────────────────────────────────────────────
/** Tick sweep (tenantId null) — evaluates + runs due schedules. */
export type UsageReportTickJob = BaseJobData;
/** Run one schedule now. */
export interface UsageReportRunJob extends BaseJobData {
  scheduleId: string;
}

// ── Notifications ──────────────────────────────────────────────────────────
export interface NotificationDispatchJob extends BaseJobData {
  tenantId: string;
  notificationId: string;
}
/** P1.5 (MS-007) — outbox-driven, durable reminder scheduling for one
 *  newly-created appointment. See `queue.constants.ts`'s `REMINDERS_SCHEDULE`
 *  docstring for why this exists instead of a listener-only path. */
export interface RemindersScheduleJob extends BaseJobData {
  tenantId: string;
  appointmentId: string;
}
/** Maintenance sweep: re-enqueue due-but-unsent + reclaim stale PROCESSING. */
export type NotificationReapJob = BaseJobData;
/** Dead-letter envelope for an exhausted transient dispatch. */
export interface NotificationDlqJob extends BaseJobData {
  notificationId: string;
  sourceQueue: string;
  sourceJobName: string;
  originalJobId?: string;
  failedReason: string;
  attemptsMade: number;
  diedAt: string;
  /** FND-037 — ISO deadline for the retention sweep; absent = parked before the fix (left alone). */
  expiresAt?: string;
}

// ── WhatsApp ───────────────────────────────────────────────────────────────
export interface WhatsappSendJob extends BaseJobData {
  tenantId: string;
  templateId: string;
  payload: {
    accountId?: string;
    branchId?: string;
    contactId?: string;
    customerId?: string;
    toWaId?: string;
    variables?: Record<string, unknown>;
    scheduledAt?: string;
  };
  /**
   * The QUEUED `NotificationLog` row created at schedule time (gap-closure
   * pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.11). Lets the worker claim
   * this SAME row atomically (QUEUED -> SENDING) before sending, so a
   * redelivered/duplicated job — this queue previously had NO jobId at all —
   * cannot double-send. Absent for any caller that hasn't been updated to the
   * new claim path (defensive; there is currently only one producer,
   * `WhatsappExecutionService.scheduleMessage`).
   */
  logId?: string;
}

/**
 * Process one persisted inbound Meta webhook event.
 *
 * Carries only the event's id — never the payload. The row is the source of
 * truth (and can be replayed/inspected), the payload can be large, and Redis is
 * not where patient message content should live.
 *
 * `tenantId` is nullable (matching BaseJobData): an event whose phone_number_id
 * matches no live account is still stored for diagnostics, and the worker must
 * be able to recognise and skip it rather than guess an owner.
 */
export interface WhatsappWebhookProcessJob extends BaseJobData {
  webhookEventId: string;
  tenantId: string | null;
}

/**
 * Download one inbound media object from Meta and attach it to a message.
 *
 * Meta's media URLs expire within minutes, so the job stores the media ID and
 * re-resolves the URL at run time — persisting a URL would guarantee a dead
 * link by the time a retry fires.
 */
export interface WhatsappMediaDownloadJob extends BaseJobData {
  tenantId: string;
  accountId: string;
  messageId: string;
  mediaId: string;
  mediaType: string;
  filename?: string;
  mimeType?: string;
}

/**
 * Dead-letter envelope for the inbound `whatsapp-webhook`/`whatsapp-media`
 * queues, once a job exhausts its retries. Same shape as `CampaignDlqJob` —
 * unlike campaign dispatch there are no counters to reconcile, so replay here
 * is just "re-enqueue `originalData` onto `sourceQueue`".
 */
export interface WhatsappDlqJob extends BaseJobData {
  sourceQueue: string;
  sourceJobName: string;
  originalJobId?: string;
  originalData: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  diedAt: string;
  /** FND-037 — ISO deadline for the retention sweep; absent = parked before the fix (left alone). */
  expiresAt?: string;
}

// ── Campaigns ──────────────────────────────────────────────────────────────
export interface CampaignLaunchJob extends BaseJobData {
  tenantId: string;
  campaignId: string;
  runId: string;
  idempotencyKey: string;
}
/** A single keyset window of a run's audience, fanned out independently. */
export interface CampaignFanoutChunkJob extends BaseJobData {
  tenantId: string;
  campaignId: string;
  runId: string;
  /** Exclusive lower bound (recipient id) for keyset pagination; null = start. */
  cursor: string | null;
}
export interface CampaignProcessRecipientJob extends BaseJobData {
  tenantId: string;
  campaignId: string;
  runId: string;
  recipientId: string;
}
/** Dead-letter envelope: the original payload plus failure forensics. */
export interface CampaignDlqJob extends BaseJobData {
  sourceQueue: string;
  sourceJobName: string;
  originalJobId?: string;
  originalData: Record<string, unknown>;
  failedReason: string;
  attemptsMade: number;
  diedAt: string;
  /** FND-037 — ISO deadline for the retention sweep; absent = parked before the fix (left alone). */
  expiresAt?: string;
}

// ── AI ─────────────────────────────────────────────────────────────────────
/**
 * `enqueueAiExecute`/`ai.execute` currently has NO live caller anywhere in
 * `src/` (confirmed by repo-wide grep, 2026-07-30) — this job type and its
 * processor exist as scaffolding for a future async AI workflow, the
 * interactive chat endpoint stays synchronous. `content` is the raw
 * user/patient message text — flagged as PII in Redis job payloads (M1,
 * docs/CACHING_QUEUES_AUDIT.md). A future caller should follow the pattern
 * every OTHER job type in this file already uses: persist the message first
 * (the `ai_conversations`/`ai_executions` tables already exist) and pass the
 * row id instead of the raw text — NOT wire a caller that passes `content`
 * directly. `removeOnFail` is already shortened defensively (see
 * `PII_REMOVE_ON_FAIL_SECONDS` in `queue.constants.ts`) in case a caller is
 * added before this field is ever removed.
 */
export interface AiExecuteJob extends BaseJobData {
  tenantId: string;
  aiConversationId: string;
  content: string;
  /** Stable across every enqueue/retry of the same logical paid request. */
  idempotencyKey: string;
}

// ── Analytics ──────────────────────────────────────────────────────────────
/** tenantId null = scheduled sweep that fans out per-tenant jobs. */
export type AnalyticsAggregateJob = BaseJobData;
export interface AnalyticsGenerateReportJob extends BaseJobData {
  kind?: 'daily' | 'monthly';
  date?: string; // YYYY-MM-DD (daily)
  month?: string; // YYYY-MM (monthly)
  branchId?: string;
}
/** Platform-level retention sweep (tenantId null) — purges old analytics_events. */
export type AnalyticsCleanupJob = BaseJobData;
/**
 * T095 (spec 014, US12) — async invoice PDF rendering. `documentVersion` is
 * the version this render is FOR (bumped by `finalize()`/regenerate) — the
 * idempotency key is `(invoiceId, documentVersion)`: a redelivered job for a
 * version already rendered is a no-op, never a second render.
 */
export interface AnalyticsInvoiceDocumentJob extends BaseJobData {
  tenantId: string;
  invoiceId: string;
  documentVersion: number;
}

/**
 * T183 (spec 014, US13) — `analytics.exportGenerate`, on the existing
 * `ANALYTICS` queue. Carries only the durable `export_jobs` row id — that
 * row (with its FROZEN `filters`/`branch_scope`, captured at request time
 * by `ReportExportService.requestExport`) is the source of truth, never a
 * second copy of the request in Redis.
 */
export interface AnalyticsExportGenerateJob extends BaseJobData {
  tenantId: string;
  exportJobId: string;
}

// ── Settlements ────────────────────────────────────────────────────────────
export interface SettlementsProcessJob extends BaseJobData {
  periodStart?: string;
  periodEnd?: string;
  branchId?: string;
  feePercent?: number;
  currency?: string;
}

// ── Subscriptions ──────────────────────────────────────────────────────────
export type SubscriptionsRenewalCheckJob = BaseJobData;
/** T082 (spec 014, US5) — `subscriptions.renewalBill`, same queue, already
 *  scheduled by T024; no distinct payload of its own. */
export type SubscriptionsRenewalBillJob = BaseJobData;

// ── Workflow engine ─────────────────────────────────────────────────────────
/** Kick off a workflow run: fan the run's actions out into delayed action jobs. */
export interface WorkflowRunJob extends BaseJobData {
  tenantId: string;
  runId: string;
}
/** Execute ONE action of a workflow run (delay + retry handled at the queue). */
export interface WorkflowActionJob extends BaseJobData {
  tenantId: string;
  runId: string;
  /** Index of the action within the workflow's action list. */
  actionIndex: number;
}

// ── Outbound webhooks (Phase 2 — Integration platform) ─────────────────────
/**
 * Deliver one webhook delivery attempt.
 *
 * Carries only the delivery row's id — never the payload/secret. The
 * `webhook_deliveries` row is the source of truth (updated in place across
 * attempts, replayable/inspectable from the dashboard); Redis is not where a
 * tenant's business-event payload should live.
 */
export interface WebhookDeliverJob extends BaseJobData {
  tenantId: string;
  webhookDeliveryId: string;
}

/** Dead-letter envelope for an exhausted `webhooks.deliver` job. */
export interface WebhookDlqJob extends BaseJobData {
  webhookDeliveryId: string;
  sourceQueue: string;
  sourceJobName: string;
  originalJobId?: string;
  failedReason: string;
  attemptsMade: number;
  diedAt: string;
  /** FND-037 — ISO deadline for the retention sweep; absent = parked before the fix (left alone). */
  expiresAt?: string;
}

/**
 * Async import processing (Phase 4). Carries only the durable job-row id — the
 * `integration_import_jobs` row (with its server-only staged payload) is the
 * source of truth, never Redis.
 */
export interface IntegrationImportJobData extends BaseJobData {
  importJobId: string;
}

/** Synchronization run (Phase 4). Carries only the `integration_sync_jobs` row id. */
export interface IntegrationSyncJobData extends BaseJobData {
  syncJobId: string;
}

/**
 * Inbound integration webhook processing (Phase 4). Carries only the persisted
 * inbound-event row id — the verified payload lives on that row, never in Redis.
 */
export interface IntegrationInboundJobData extends BaseJobData {
  inboundEventId: string;
}

// ── Waitlist (Spec 014 "Clinic Platform Completion" — US9) ──────────────────

/**
 * T159/T160 — evaluates a freed slot against waiting entries. Carries only
 * ids/scalars; `WaitlistOfferService.evaluateFreedSlot` re-resolves
 * everything else in tenant context.
 *
 * `appointmentId` alone is enough for a CANCEL-triggered evaluation — that
 * appointment's own row still holds the freed (branch, staff, start, end)
 * unchanged (only its `status` moved to `CANCELLED`). A RESCHEDULE-triggered
 * evaluation cannot rely on the same row: by the time this job runs, the
 * appointment's `start_at`/`end_at` hold the NEW time, not the freed one — so
 * `WaitlistListener` fills the four `freed*` fields from
 * `AppointmentRescheduledEvent`'s own snapshot in that case. Left `undefined`
 * for a CANCEL-triggered evaluation, which derives them from the appointment
 * row instead.
 */
export interface PlatformWaitlistEvaluateJob extends BaseJobData {
  tenantId: string;
  appointmentId: string;
  freedStartAt?: string;
  freedEndAt?: string;
  freedBranchId?: string;
  freedStaffId?: string;
}
