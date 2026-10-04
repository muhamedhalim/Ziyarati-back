import { ConfigService } from '@nestjs/config';
import { DefaultJobOptions } from 'bullmq';

/** Standardized queue names. Campaigns are split by stage for isolation. */
export const QUEUE = {
  NOTIFICATIONS: 'notifications',
  NOTIFICATIONS_DLQ: 'notifications.dlq',
  /**
   * Outbound sends (template + session). Named for its DIRECTION so it reads as
   * a peer of the inbound queues below rather than the catch-all "whatsapp".
   */
  WHATSAPP_OUTBOUND: 'whatsapp-outbound',
  /**
   * Inbound Meta events. Separate from outbound on purpose: a backlog of
   * inbound traffic must never delay appointment reminders going out, and the
   * two have completely different retry/latency characteristics.
   */
  WHATSAPP_WEBHOOK: 'whatsapp-webhook',
  /**
   * Inbound media downloads. Separate again because media is slow, large and
   * failure-prone (Meta's URLs expire in minutes) — mixing it into the webhook
   * queue would let one big video stall message processing.
   */
  WHATSAPP_MEDIA: 'whatsapp-media',
  /** Dead-letter park for exhausted whatsapp-webhook/whatsapp-media jobs. */
  WHATSAPP_DLQ: 'whatsapp.dlq',
  // Campaign execution pipeline (stage-isolated queues).
  CAMPAIGNS_LAUNCH: 'campaigns.launch',
  CAMPAIGNS_FANOUT: 'campaigns.fanout',
  CAMPAIGNS_PROCESS: 'campaigns.processRecipient',
  CAMPAIGNS_DLQ: 'campaigns.dlq',
  AI: 'ai',
  ANALYTICS: 'analytics',
  SETTLEMENTS: 'settlements',
  SUBSCRIPTIONS: 'subscriptions',
  REFUNDS: 'refunds',
  /** Payment reconciliation sweep (stale PENDING ⇄ gateway truth). */
  PAYMENTS: 'payments',
  PLATFORM: 'platform',
  EMAIL: 'email',
  USAGE_REPORT: 'usage-report',
  WORKFLOW: 'workflow',
  /** Outbound webhook delivery (Phase 2 — Integration platform). */
  WEBHOOKS_DELIVER: 'webhooks.deliver',
  /** Dead-letter park for exhausted webhooks.deliver jobs. */
  WEBHOOKS_DLQ: 'webhooks.dlq',
  /** Async batch import processing (Phase 4 — two-way integrations). */
  INTEGRATION_IMPORT: 'integration.import',
  /** Synchronization runs — pull/push external changes (Phase 4). */
  INTEGRATION_SYNC: 'integration.sync',
  /** Inbound integration webhook processing (Phase 4). */
  INTEGRATION_INBOUND: 'integration.inbound',
  /**
   * Maintenance sweeps for the integration platform (gap-closure pass — see
   * docs/CACHING_QUEUES_AUDIT.md §0.8.8): recovers import/sync/inbound rows
   * left in a running/processing state by a dead worker. Repeatable, system
   * job (tenantId null), lock-guarded — see IntegrationRecoveryProcessor.
   */
  INTEGRATION_MAINTENANCE: 'integration.maintenance',
  /**
   * Maintenance sweeps for campaigns (FND-020), mirroring
   * INTEGRATION_MAINTENANCE's shape exactly: recovers dead-lettered
   * recipients whose DLQ write itself was never confirmed (a Redis hiccup at
   * the moment of enqueue) — separate from the hot CAMPAIGNS_PROCESS queue so
   * a low-frequency system sweep never contends with its dispatch
   * concurrency/rate-limiter settings. Repeatable, system job (tenantId
   * null), lock-guarded — see CampaignDlqRecoveryProcessor.
   */
  CAMPAIGNS_MAINTENANCE: 'campaigns.maintenance',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);

/** The campaign pipeline queues (used for monitoring/depth helpers). */
export const CAMPAIGN_QUEUES: QueueName[] = [
  QUEUE.CAMPAIGNS_LAUNCH,
  QUEUE.CAMPAIGNS_FANOUT,
  QUEUE.CAMPAIGNS_PROCESS,
  QUEUE.CAMPAIGNS_DLQ,
];

/**
 * All four dead-letter parks in the system (single source of truth — see
 * docs/CACHING_QUEUES_AUDIT.md §0.1 for the recount that corrected the
 * original audit's "6 DLQs" claim to this real count of 4). Jobs only ever
 * land here via `.add()` for parking/inspection/admin-replay; no `Worker`
 * ever processes a DLQ queue, so `attempts`/backoff on jobs added to these
 * queues is inert (see L2 — used by `ProducerQueues` to zero that out).
 */
export const DLQ_QUEUES: QueueName[] = [
  QUEUE.NOTIFICATIONS_DLQ,
  QUEUE.WHATSAPP_DLQ,
  QUEUE.CAMPAIGNS_DLQ,
  QUEUE.WEBHOOKS_DLQ,
];

/** Standardized job names — `<domain>.<action>`. */
export const JOB = {
  NOTIFICATIONS_DISPATCH: 'notifications.dispatch',
  NOTIFICATIONS_REAP: 'notifications.reap',
  NOTIFICATIONS_DLQ: 'notifications.dlq',
  /** P1.5 (MS-007) — durable, outbox-driven reminder scheduling for a newly
   *  created appointment. Written to `outbox_jobs` in the SAME transaction
   *  as the appointment row (`AppointmentsService.create`), so it commits
   *  or rolls back atomically with the booking — never a listener racing a
   *  saturated pool for a connection after the fact. Consumed by
   *  `NotificationsProcessor` (same queue reminders already live on). */
  REMINDERS_SCHEDULE: 'reminders.schedule',
  WHATSAPP_SEND: 'whatsapp.send',
  WHATSAPP_RETRY: 'whatsapp.retry',
  WHATSAPP_WEBHOOK_PROCESS: 'whatsapp.webhookProcess',
  WHATSAPP_MEDIA_DOWNLOAD: 'whatsapp.mediaDownload',
  /** Coexistence smb_app_state_sync → history pair (same queue as sends: it's an outbound Graph call). */
  WHATSAPP_COEXISTENCE_SYNC: 'whatsapp.coexistenceSync',
  WHATSAPP_DLQ: 'whatsapp.dlq',
  CAMPAIGNS_LAUNCH: 'campaigns.launch',
  CAMPAIGNS_FANOUT_CHUNK: 'campaigns.fanoutChunk',
  CAMPAIGNS_PROCESS_RECIPIENT: 'campaigns.processRecipient',
  CAMPAIGNS_DLQ: 'campaigns.dlq',
  AI_EXECUTE: 'ai.execute',
  AI_MEMORY_CLEANUP: 'ai.memoryCleanup',
  /** AI-008 (FR-029c): repeatable sweep purging attempt-only ai_tool_calls rows past the retention window. */
  AI_TOOL_CALL_RETENTION: 'ai.toolCallRetention',
  /** Repeatable sweep: poll live OpenAI batches + process terminal ones. */
  AI_BATCH_POLL: 'ai.batchPoll',
  ANALYTICS_AGGREGATE: 'analytics.aggregate',
  ANALYTICS_GENERATE_REPORT: 'analytics.generateReport',
  ANALYTICS_CLEANUP: 'analytics.cleanup',
  SETTLEMENTS_PROCESS: 'settlements.process',
  SUBSCRIPTIONS_RENEWAL_CHECK: 'subscriptions.renewalCheck',
  REFUNDS_REAP: 'refunds.reap',
  PAYMENTS_RECONCILE: 'payments.reconcile',
  /**
   * REL-005 — durable post-payment effects. Written to `outbox_jobs` in the SAME
   * transaction that moves a payment to PAID/FAILED (or records a refund), so the
   * consequences that DEPEND on that change — confirming the booking, granting an
   * add-on, applying a billing upgrade, reversing an entitlement on refund —
   * cannot be lost to a crash between the commit and an in-process event emit.
   * Consumed by `PaymentsProcessor` on the existing `payments` queue. SYSTEM tier
   * (the money has already moved; see job-authorization.constants.ts).
   */
  PAYMENTS_OUTCOME: 'payments.outcome',
  /**
   * Tap migration (Phase 5) — the daily reconciliation against what the gateway
   * says: fees, payouts, discrepancies. Platform-level (no tenant), on the existing
   * `payments` queue. A daily sweep re-reads a short look-back window; a weekly one
   * re-reads Tap's whole 30-day reporting window. Read-only toward the gateway.
   */
  PAYMENTS_PROVIDER_RECONCILE: 'payments.providerReconcile',
  PLATFORM_LOG_CLEANUP: 'platform.logCleanup',
  /**
   * AUTH-005 (see docs/AUTH_CONCURRENCY_GC_AUDIT.md) — repeatable retention
   * sweep for `refresh_tokens` / `password_resets`, which previously had no
   * cleanup path at all. Shares the existing `platform` maintenance queue
   * rather than introducing a scheduler: BullMQ repeatable jobs dedup by
   * repeat key, so this stays single-flight across worker replicas.
   */
  PLATFORM_AUTH_TOKEN_CLEANUP: 'platform.authTokenCleanup',
  EMAIL_SEND: 'email.send',
  USAGE_REPORT_TICK: 'usageReport.tick',
  USAGE_REPORT_RUN: 'usageReport.run',
  WORKFLOW_RUN: 'workflow.run',
  WORKFLOW_ACTION: 'workflow.action',
  WEBHOOKS_DELIVER: 'webhooks.deliver',
  WEBHOOKS_DLQ: 'webhooks.dlq',
  INTEGRATION_IMPORT: 'integration.import',
  INTEGRATION_SYNC: 'integration.sync',
  INTEGRATION_INBOUND: 'integration.inbound',
  /** Repeatable maintenance sweep — see QUEUE.INTEGRATION_MAINTENANCE. */
  INTEGRATION_RECOVER_STALE: 'integration.recoverStale',
  /**
   * Daily retention sweep on QUEUE.INTEGRATION_MAINTENANCE: deletes expired
   * idempotency records, terminal inbound-event history past retention, and
   * expired OAuth handshake states. Without it those tables grow without bound.
   */
  INTEGRATION_PURGE_EXPIRED: 'integration.purgeExpired',
  /** Repeatable maintenance sweep — see QUEUE.CAMPAIGNS_MAINTENANCE. */
  CAMPAIGNS_RECOVER_DLQ: 'campaigns.recoverDlq',

  // Spec 014 "Clinic Platform Completion" — added to EXISTING queues; no new
  // queue is introduced (SUBSCRIPTIONS_RENEWAL_BILL → QUEUE.SUBSCRIPTIONS,
  // ANALYTICS_* → QUEUE.ANALYTICS, PLATFORM_* → QUEUE.PLATFORM).
  /** Repeatable daily sweep: bills subscriptions due for recurring renewal (S5). */
  SUBSCRIPTIONS_RENEWAL_BILL: 'subscriptions.renewalBill',
  /** Async report-export rendering (S13), on the existing analytics queue. */
  ANALYTICS_EXPORT_GENERATE: 'analytics.exportGenerate',
  /** Async invoice PDF rendering (S12), on the existing analytics queue. */
  ANALYTICS_INVOICE_DOCUMENT: 'analytics.invoiceDocument',
  /** Evaluates waitlist entries against a freed slot (S9). */
  PLATFORM_WAITLIST_EVALUATE: 'platform.waitlistEvaluate',
  /** Repeatable sweep: expires waitlist offers past their deadline (S9). */
  PLATFORM_WAITLIST_EXPIRY: 'platform.waitlistExpiry',
  /** Repeatable daily sweep: closes out the day's patient queue (S10). */
  PLATFORM_QUEUE_DAY_CLOSE: 'platform.queueDayClose',
  /** Repeatable daily sweep: expires stale report-export downloads (S13). */
  PLATFORM_EXPORT_EXPIRY: 'platform.exportExpiry',
  /**
   * Repeatable hourly sweep: emits `customer.birthday` for patients whose
   * birthday it is in their clinic's local time (acts at local 09:00), which
   * the workflow engine's "Birthday Greeting" template listens for.
   */
  PLATFORM_BIRTHDAY_GREETINGS: 'platform.birthdayGreetings',
  /**
   * Free-access lifecycle notice delivery (in-app + email), one job per
   * override event — start or a 48h expiry warning. SYSTEM tier: the
   * override id is the only trust anchor in the payload, and
   * `FreeAccessNoticeService.deliver()` re-reads the tenant/override fresh
   * from the DB rather than trusting a `tenantId` in the job data (plan §12).
   */
  PLATFORM_FREE_ACCESS_NOTICE: 'platform.freeAccessNotice',
  /**
   * Repeatable hourly sweep: claims free-access overrides entering their
   * final 48h and enqueues exactly one `PLATFORM_FREE_ACCESS_NOTICE` (kind
   * EXPIRING) per claimed row — see `FreeAccessNoticeService.sweepExpiring`.
   * SYSTEM tier, same reasoning as `PLATFORM_FREE_ACCESS_NOTICE` above: the
   * claim query itself is the source of truth, never anything in the payload.
   */
  PLATFORM_FREE_ACCESS_EXPIRY_SWEEP: 'platform.freeAccessExpirySweep',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * Production-safe default job options: configurable attempts + exponential
 * backoff, completed jobs trimmed (age + count cap). FAILED jobs are retained
 * (`removeOnFail: false`) because the processor explicitly routes exhausted
 * TRANSIENT failures into the dedicated DLQ — we never want them silently
 * evicted before that handler runs.
 */
export function defaultJobOptions(config: ConfigService): DefaultJobOptions {
  return {
    attempts: config.get<number>('QUEUE_DEFAULT_ATTEMPTS', 5) ?? 5,
    backoff: {
      type: 'exponential',
      delay: config.get<number>('QUEUE_BACKOFF_MS', 3000) ?? 3000,
    },
    removeOnComplete: { age: 3600, count: 1000 },
    // Cap failed-job retention so the failed set can't grow unbounded in Redis.
    // The processors route exhausted failures to the DLQ in their `failed`
    // handler (which fires before eviction), so a 7-day window is ample for
    // inspection without leaking memory at millions/day.
    removeOnFail: { age: STANDARD_REMOVE_ON_FAIL_SECONDS, count: 10_000 },
  };
}

/**
 * Shorter failed-job retention for the queues whose payload carries
 * patient-identifying content — `email.send` (recipient + template
 * `variables`), `whatsapp.send`/`.retry` (template `variables`), `ai.execute`
 * (raw message `content`, currently unreachable — see M1's §13 entry) —
 * versus the default 7-day window (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M1). A failed job's payload sits in Redis,
 * readable by anyone with Redis access (a snapshot, a `MONITOR` session, an
 * operator), for as long as `removeOnFail` allows; 6 hours is ample for the
 * DLQ/on-call window this codebase already uses to inspect and replay a
 * failure, without leaving a patient's message content sitting in Redis for
 * a week. Passed as each PII-bearing enqueue method's own `removeOnFail`
 * override (BullMQ's per-job `opts` wins over the queue's own
 * `defaultJobOptions`), not a global change — every other queue keeps the
 * 7-day default.
 */
export const PII_REMOVE_ON_FAIL_SECONDS = 6 * 3600;

/**
 * Standard (non-PII-bearing) failed-job retention — matches
 * `defaultJobOptions`'s own `removeOnFail.age` exactly (kept as one named
 * constant so the two can never silently drift apart).
 */
export const STANDARD_REMOVE_ON_FAIL_SECONDS = 7 * 24 * 3600;

/**
 * Stamps the ISO deadline a newly-parked DLQ job should be swept at
 * (FND-037). DLQ_QUEUES jobs are added via `.add()` and never processed by
 * any Worker (see `DLQ_QUEUES`'s own doc comment above), so BullMQ's
 * `removeOnComplete`/`removeOnFail` job options — which fire only on the
 * corresponding state transition — never apply to them; an explicit stamped
 * deadline plus an external sweep (`QueueMonitorService`) is the only
 * mechanism that can actually expire a parked job.
 *
 * `piiAdjacent` is passed explicitly by each `enqueue*Dlq` call site (mirrors
 * how `PII_REMOVE_ON_FAIL_SECONDS` is already applied explicitly per source
 * enqueue, not looked up centrally by queue name) — today only `WHATSAPP_DLQ`
 * carries PII-adjacent content (template variables) in its Redis-resident
 * `originalData`; `NOTIFICATIONS_DLQ`/`CAMPAIGNS_DLQ`/`WEBHOOKS_DLQ` payloads
 * carry only internal ids (verified by reading each `*DlqJob` interface and
 * its enqueue call sites), so they take the standard class.
 *
 * A job parked BEFORE this fix has no `expiresAt` at all — the sweep leaves
 * those alone rather than retroactively shrinking their (previously
 * unenforced) retention the moment this code deploys.
 */
export function dlqExpiresAt(
  piiAdjacent: boolean,
  now: Date = new Date(),
): string {
  const seconds = piiAdjacent
    ? PII_REMOVE_ON_FAIL_SECONDS
    : STANDARD_REMOVE_ON_FAIL_SECONDS;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/**
 * Optional BullMQ key prefix (default `bull`, i.e. unprefixed — matches every
 * existing deployment exactly, so this is purely additive) — gap-closure
 * pass, see docs/CACHING_QUEUES_AUDIT.md M3. Isolates one environment's
 * queues from another's if they ever share a Redis instance/db index (an
 * easy mistake with a copy-pasted `REDIS_URL`): without a prefix, a staging
 * worker pointed at a production Redis by accident would happily consume and
 * complete real production jobs.
 *
 * Deliberately opt-in (unset by default), NOT flipped on unconditionally:
 * every queue name in an ALREADY-RUNNING deployment currently resolves to
 * `bull:{name}:*` keys. Setting `QUEUE_ENV_PREFIX` changes every subsequent
 * `Queue`/`Worker`/`QueueEvents` construction to `bull:{prefix}:{name}:*` —
 * any job already enqueued under the OLD keys becomes invisible to the new
 * prefix and is orphaned. Turning this on for an existing environment needs a
 * coordinated deploy: drain every queue to empty (or accept the orphaned
 * backlog), THEN roll out `QUEUE_ENV_PREFIX` everywhere that talks to that
 * Redis (API + worker, every replica) in the same deploy. A brand-new
 * environment can set it from day one with no drain needed.
 */
export function bullPrefix(): string | undefined {
  const prefix = process.env.QUEUE_ENV_PREFIX?.trim();
  return prefix && prefix.length > 0 ? prefix : undefined;
}

/**
 * Same `QUEUE_ENV_PREFIX` opt-in (see `bullPrefix` above), formatted for
 * direct string-concatenation into a cache key (`analytics:*`, `rl:*`) —
 * `"{prefix}:"` when set, or `""` (a no-op prefix) when unset, so every call
 * site can unconditionally write `` `${cacheKeyPrefix()}analytics:...` ``
 * without an `if` at each of the ~6 key-building call sites.
 */
export function cacheKeyPrefix(): string {
  const prefix = bullPrefix();
  return prefix ? `${prefix}:` : '';
}

/**
 * Page size for tenant-fan-out sweeps (analytics/settlements — gap-closure,
 * see docs/CACHING_QUEUES_AUDIT.md M7): bounds both the DB read
 * (`WorkerTenantsService.activeTenantIdsPage`) and the BullMQ `addBulk` call
 * size, so a 5 000+-tenant deployment doesn't turn one sweep tick into a
 * single unbounded query plus 5 000 sequential `add()` round trips.
 */
export const SWEEP_FANOUT_PAGE_SIZE = 500;

/** Worker concurrency per process (read at decoration time in the worker app). */
export function workerConcurrency(): number {
  const n = Number(process.env.WORKER_CONCURRENCY ?? '5');
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** Higher concurrency for the recipient-send queue (the hot path). */
export function dispatchConcurrency(): number {
  const n = Number(process.env.CAMPAIGN_DISPATCH_CONCURRENCY ?? '25');
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * GLOBAL provider-protection limiter for the recipient-send queue. Caps total
 * throughput to the channel provider across all tenants/pods sharing this Redis.
 * Per-tenant fairness is enforced separately by the Redis token bucket.
 */
export function dispatchLimiter(): { max: number; duration: number } {
  const max = Number(process.env.CAMPAIGN_GLOBAL_MAX_PER_SEC ?? '1000');
  return { max: Number.isFinite(max) && max > 0 ? max : 1000, duration: 1000 };
}

/**
 * Extended BullMQ `lockDuration` (default is 30_000ms) for processors whose
 * OWN bounded external-call timeout is already close to — or exceeds — that
 * default (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M8). Without this,
 * ordinary tail latency on a healthy (non-hung) call can outlive the lock,
 * and BullMQ's stall detector hands the job to a second worker while the
 * first is still legitimately running it — a false stall, not a real hang.
 * Examples: `ai.execute`'s OpenAI call alone is bounded at
 * `OPENAI_REQUEST_TIMEOUT_MS` (default 30_000ms) — i.e. the SAME as the
 * default lock, before any DB persistence/metering work after it; a
 * multi-page `integration.sync`/`integration.import` run issues several
 * sequential 8s-bounded REST calls, so total duration routinely exceeds 30s
 * even though no single call hangs. `maxStalledCount` is deliberately left
 * at BullMQ's own default (1, i.e. one stall-triggered redelivery permitted)
 * rather than lowered to 0 — this codebase's claim-based idempotency
 * (`WorkflowService.claimAction`, the email/WhatsApp/notification atomic
 * claims, campaign recipient state re-checks) already makes a stall-redelivery
 * SAFE for every processor that carries real side effects, so failing the job
 * outright on the first stall would trade "safely retries" for "fails and
 * needs the DLQ to notice," a net loss given those guards already exist.
 */
export const EXTENDED_LOCK_DURATION_MS = 60_000;

/**
 * Exponential backoff WITH jitter — avoids a thundering herd when a provider
 * recovers and many jobs retry at the same instant. Registered on the worker as
 * a custom backoff strategy under the name `expo-jitter`.
 */
export const BACKOFF_EXPO_JITTER = 'expo-jitter';
export function expoJitterBackoff(attemptsMade: number): number {
  const base = Number(process.env.QUEUE_BACKOFF_MS ?? '3000');
  const max = Number(process.env.QUEUE_BACKOFF_MAX_MS ?? '60000');
  const exp = Math.min(base * 2 ** (attemptsMade - 1), max);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Worker deployment role (Phase 0 correction — see
 * docs/CACHING_QUEUES_AUDIT.md §0.3/§0.5). Measured locally: 21 processors at
 * the default concurrency sum to a much smaller DB-pool draw than
 * `campaigns.processRecipient` alone once its concurrency (25, uncapped by
 * anything else) is folded in, and the two have very different failure/scale
 * profiles (one is provider-throughput-bound, the rest are DB/CPU-bound
 * sweeps and dispatch-adjacent work). Splitting them into separate
 * deployments — each with its OWN `DB_POOL_MAX` — was measured to be more
 * effective than raising one shared pool to match the combined theoretical
 * concurrency (the benchmark showed diminishing returns from pool size once
 * concurrency is already several times the pool).
 *
 * Default `all` is a NO-OP change: a deployment that never sets `WORKER_ROLE`
 * (today's single-worker-process setup, and local dev) behaves exactly as
 * before this correction — every processor registers in one process, same as
 * today. Only setting `WORKER_ROLE=critical` or `WORKER_ROLE=dispatch`
 * activates the split, for an operator who has provisioned two deployments.
 */
export type WorkerRole = 'all' | 'critical' | 'dispatch';

export function resolveWorkerRole(): WorkerRole {
  const raw = (process.env.WORKER_ROLE ?? 'all').trim().toLowerCase();
  return raw === 'critical' || raw === 'dispatch' ? raw : 'all';
}

/** The one queue carved out into its own deployment under `WORKER_ROLE=dispatch`. */
export const DISPATCH_ONLY_QUEUES: QueueName[] = [QUEUE.CAMPAIGNS_PROCESS];

/**
 * Which queues THIS process should register with BullMQ (`registerQueueAsync`
 * in worker.module.ts), given its resolved role. `all` (the default) registers
 * everything, matching today's unsplit behaviour exactly.
 */
export function queuesForRole(role: WorkerRole): QueueName[] {
  if (role === 'dispatch') return DISPATCH_ONLY_QUEUES;
  if (role === 'critical')
    return ALL_QUEUES.filter((q) => !DISPATCH_ONLY_QUEUES.includes(q));
  return ALL_QUEUES;
}
