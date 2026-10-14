import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { AuthAbuseLimiterScope } from '../modules/auth/auth-abuse.constants';
import { setLogMetricsSink } from '../common/logging/structured-logger';
import { setJobMetricsSink, type JobOutcome } from '../common/logging/job-instrumentation';
import {
  setProviderMetricsSink,
  type ProviderOutcome,
} from '../common/logging/provider-instrumentation';

/**
 * Minimum-viable observability (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M14): before this, the ONLY quantitative
 * signal anywhere in this codebase was one heartbeat key written by the
 * refunds reaper — everything else was logs-only (§14's own gap table).
 * This is NOT the full instrumentation plan §14 lists (no
 * `bullmq_job_duration_seconds` histogram, no `bullmq_oldest_job_age_seconds`,
 * no `redis_command_duration_seconds`, no automated alerting) — it covers
 * the highest-value subset that was already CHEAP to wire in because the
 * signal is already computed somewhere (job outcome events, cache hit/miss,
 * queue depth), matching §14's own "most of this is already computed, it
 * just needs to be counted instead of logged" framing. The remainder is a
 * concrete, sized follow-on, not silently dropped — see M14's §13 entry.
 *
 * Uses a DEDICATED `Registry` (not `prom-client`'s global default registry)
 * so multiple Nest test contexts in the same Jest process never share
 * metric state across specs.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly jobsTotal = new Counter({
    name: 'bullmq_jobs_total',
    help: 'BullMQ job outcomes by queue and status.',
    labelNames: ['queue', 'status'] as const,
    registers: [this.registry],
  });

  private readonly queueDepth = new Gauge({
    name: 'bullmq_queue_depth',
    help: 'Current BullMQ queue depth by queue and state.',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  private readonly cacheOperations = new Counter({
    name: 'cache_operations_total',
    help: 'Cache read outcomes by cache name and result.',
    labelNames: ['cache', 'result'] as const,
    registers: [this.registry],
  });

  private readonly workerHeartbeat = new Gauge({
    name: 'worker_heartbeat_timestamp_seconds',
    help: 'Unix timestamp (seconds) of the last observed heartbeat for a named worker/sweep.',
    labelNames: ['worker'] as const,
    registers: [this.registry],
  });

  /**
   * FND-008 — account-aware login-protection events. `store_unavailable` is
   * the load-bearing label: it is what makes a silent, indefinite loss of
   * brute-force protection (Redis fail-open — see LoginProtectionService)
   * externally observable rather than a quiet regression. No label carries
   * an email, identity hash, or IP — the label set is bounded, so there is
   * no cardinality risk.
   */
  private readonly loginProtectionEvents = new Counter({
    name: 'auth_login_protection_events_total',
    help: 'Account-aware login brute-force protection events by outcome.',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });

  /**
   * `PERF-CACHE-001` — makes the global `ThrottlerGuard`'s degraded-mode
   * fallback (Redis unreachable → local in-memory limiting, see
   * `FailsafeThrottlerStorage`) externally observable rather than a silent,
   * indefinite loss of cross-replica rate-limit consistency — same rationale
   * as `loginProtectionEvents`' `store_unavailable` label above.
   */
  /**
   * SEC-06 — rejected API-key authentications by reason. The only signal for an
   * UNKNOWN key (no tenant to attribute a log row to), so credential-guessing or a
   * leaked-then-revoked key shows up as a rate here. Labels are a closed set —
   * no key id, prefix or IP — so there is no cardinality risk.
   */
  private readonly apiKeyAuthFailures = new Counter({
    name: 'api_key_auth_failures_total',
    help: 'Rejected API-key authentications by reason (missing, unknown, inactive, expired).',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly throttlerStorageEvents = new Counter({
    name: 'throttler_storage_events_total',
    help: 'Global throttler storage outcomes by event, e.g. degraded fallback to in-memory limiting when Redis is unavailable.',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });

  /**
   * `PERF-BE-002` — closes the observability gap T025 confirmed empirically:
   * `ApiLoggingInterceptor` sits AFTER the 6 global guards, so a request
   * rejected by `ThrottlerGuard`/`JwtAuthGuard`/`CsrfGuard`/`MaintenanceGuard`/
   * `SubscriptionAccessGuard`/`FeatureGuard` (429/401/403/503/403) never
   * produced an `api_logs` row or touched `MetricsService` before this —
   * every other latency/error figure in this codebase was under-representative
   * of what a rejected request actually experienced. Recorded by a bootstrap
   * `app.use()` middleware registered before the guard chain (`main.ts`), so
   * this histogram sees 100% of requests, not just guard-surviving ones.
   * Labels deliberately exclude the route path — an unmatched/rejected
   * request has no reliable route template to normalize against (unlike
   * `ApiLoggingInterceptor`, which only ever runs post-match), and an
   * unbounded raw-path label would be a real cardinality risk on a
   * publicly-reachable metric.
   */
  private readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds by method and status code, captured before the guard chain so guard-rejected requests (429/401/403/503) are included.',
    labelNames: ['method', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /**
   * 009-auth-abuse-resistance (ZT-002, ZT-006) — every limiter this feature
   * introduces or extends (login's degraded fallback, forgot-password,
   * reset-password's two layers, register-owner's two layers) reports
   * through this ONE counter rather than one series per limiter. `limiter`
   * and `event` are both bounded, closed enums (research.md §R9) — no
   * identity, hash, IP or token can ever reach a label value, so cardinality
   * is fixed at 6 × 5 = 30 series regardless of traffic or attacker input.
   */
  private readonly authAbuseLimiterEvents = new Counter({
    name: 'auth_abuse_limiter_events_total',
    help: 'Authentication abuse-limiter decisions by limiter scope and outcome.',
    labelNames: ['limiter', 'event'] as const,
    registers: [this.registry],
  });

  /**
   * ZT-010 — fires only if the `uq_user_email_global` invariant is ever
   * lost (an unscoped recovery lookup returns more than one live row). No
   * identity information in the label set — this is a structural-integrity
   * signal, not an audit trail of who triggered it.
   */
  private readonly authRecoveryEvents = new Counter({
    name: 'auth_recovery_events_total',
    help: 'Password-recovery lookup outcomes requiring operator attention, by event.',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });

  /**
   * AUTH-002 — refresh-token rotation outcomes. Pre-fix, reuse detection was
   * completely silent: no metric, no audit row, no log line, even though
   * replay of a rotated token is the single strongest token-theft signal the
   * system produces. Carries no identity in the label set — `reuse_detected`
   * says a family was revoked, never whose.
   */
  private readonly refreshRotationEvents = new Counter({
    name: 'auth_refresh_rotation_events_total',
    help: 'Refresh-token rotation outcomes (reuse detection, bounded retry window), by event.',
    labelNames: ['event'] as const,
    registers: [this.registry],
  });

  /**
   * 015-db-api-efficiency-audit — P10/T062 (spec §21.2 gap). Before this,
   * NOTHING counted database statements per request; every "N queries per
   * page" figure in this audit had to be derived by reading TypeORM source
   * or manually counting `query:` log lines against a disposable database
   * (see the P0/P5/P7/P9 evidence files) rather than read off a graph.
   *
   * Incremented once per EXECUTED STATEMENT (`TypeOrmLogger.logQuery`),
   * labelled by `route` ONLY:
   *  - `route` is the Express-matched pattern (e.g. `/appointments/:id`) —
   *    the exact same value `ApiLoggingInterceptor` already uses for
   *    `api_logs.endpoint` — never the raw path with real ids, and never a
   *    tenant id. Bounded cardinality: one series per distinct ROUTE
   *    TEMPLATE, not per request or per tenant.
   *  - Counter only. The SQL text and parameters TypeORM's logger receives
   *    are never touched by this method — only the fact that one statement
   *    ran is counted.
   *  - `rate(db_queries_total[5m]) / rate(http_requests_total[5m])` derives
   *    "average queries per request" — this counter does not need to be a
   *    histogram to answer that question.
   */
  private readonly dbQueries = new Counter({
    name: 'db_queries_total',
    help: 'Executed SQL statements by route (Express-matched pattern only — never a raw path, tenant id, or query text).',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  /**
   * F-25 — an inbound WhatsApp message whose AI turn threw. Before this the
   * only trace was a log line, so a clinic whose assistant had gone silent
   * (the bot-actor re-provisioning bug) looked identical to a quiet inbox.
   * No tenant or contact in the label set — this is a fleet-level "assistant
   * is failing" signal; the ERROR log line carries the tenant for triage.
   */
  private readonly whatsappAiTurnFailures = new Counter({
    name: 'whatsapp_ai_turn_failures_total',
    help: 'Inbound WhatsApp messages whose AI turn failed, by whether the patient fallback message was delivered.',
    labelNames: ['fallback'] as const,
    registers: [this.registry],
  });

  /**
   * Every WhatsApp AI policy decision (`WhatsappAiPolicyService`) — the answer
   * to "why didn't the assistant reply?" at fleet level. Labels are a closed set
   * (`decision` ALLOW|SKIP, `reason` from AI_POLICY_REASON or ALLOWED, `stage`
   * pre_ai|pre_send) and carry no tenant or contact; the WHATSAPP_AI_DECISION
   * log line carries the tenant for triage.
   */
  private readonly whatsappAiDecisions = new Counter({
    name: 'whatsapp_ai_decisions_total',
    help: 'WhatsApp AI policy decisions, by outcome, refusal reason and the stage of the turn they were taken at.',
    labelNames: ['decision', 'reason', 'stage'] as const,
    registers: [this.registry],
  });

  /**
   * Every Meta webhook unit the edge persisted (`WhatsappWebhookService`), by
   * what became of it: `accepted` (new row), `deduplicated` (a redelivery of a
   * row we already hold) or `no_tenant` (stored for diagnostics, phone_number_id
   * matched no live account). Closed label set, no tenant.
   */
  private readonly whatsappInboundEvents = new Counter({
    name: 'whatsapp_inbound_events_total',
    help: 'WhatsApp webhook units persisted, by result (accepted, deduplicated, no_tenant).',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /**
   * Every bot message the WhatsApp bridge tried to send: `sent`, `suppressed`
   * (policy refused at the last moment), `deduped` (an earlier attempt already
   * delivered it) or `failed` (no usable account / provider error).
   */
  private readonly whatsappAiReplies = new Counter({
    name: 'whatsapp_ai_reply_total',
    help: 'WhatsApp bot reply sends, by result (sent, suppressed, deduped, failed).',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /**
   * Seconds from the start of an AI turn to its reply having been handed to the
   * provider (lock wait excluded; webhook receipt is not visible to the bridge).
   */
  private readonly whatsappAiTurnSeconds = new Histogram({
    name: 'whatsapp_ai_turn_seconds',
    help: 'Duration of a WhatsApp AI turn from start to reply sent, in seconds.',
    buckets: [1, 2, 5, 10, 20, 40, 60, 120],
    registers: [this.registry],
  });

  /**
   * Turns the server-side scope guard answered itself (no model call). `channel`
   * is the transport, `category` a `ScopeCategory` or `reply-code` — closed sets.
   */
  private readonly aiScopeBlocks = new Counter({
    name: 'ai_scope_blocks_total',
    help: 'Messages or replies stopped by the AI scope guard, by channel and category.',
    labelNames: ['channel', 'category'] as const,
    registers: [this.registry],
  });

  /** A WhatsApp turn that could not get its contact's lock in time and was left for a retry. */
  private readonly whatsappContactLockBusy = new Counter({
    name: 'whatsapp_contact_lock_busy_total',
    help: 'WhatsApp AI turns deferred because another turn for the same contact held the lock.',
    registers: [this.registry],
  });

  /**
   * Free-access lifecycle notices (`FreeAccessNoticeService.deliver`).
   * `kind`: started | expiring. `channel`: in_app | email. `outcome`:
   * sent | duplicate (idempotent no-op) | stale (override changed/revoked/
   * tenant deleted before delivery) | failed | no_recipient (no
   * SUBSCRIPTION_MANAGE holder — email still attempted independently).
   */
  private readonly freeAccessNotices = new Counter({
    name: 'free_access_notices_total',
    help: 'Free-access lifecycle notice deliveries, by kind/channel/outcome.',
    labelNames: ['kind', 'channel', 'outcome'] as const,
    registers: [this.registry],
  });

  /**
   * Logging & observability (LOGGING.md). Every label is a closed set — no
   * route, tenant, user, job id or host can reach a label value.
   *  - `log_events_total{level}`: log volume by level per process, so an error
   *    spike or a process that went silent is visible without reading logs.
   *  - `logger_write_failures_total`: lines the logger could not serialize.
   *  - `bullmq_job_duration_seconds{queue,outcome}` / `bullmq_job_attempts_total`:
   *    recorded IN-PROCESS by the replica that ran the job (job-instrumentation.ts),
   *    so `sum()` across worker replicas is correct — unlike `bullmq_jobs_total`,
   *    which every replica's QueueEvents listener counts (use `max()` on that one).
   *  - `external_requests_total` / `external_request_duration_seconds`
   *    `{provider,outcome}`: every outbound fetch (provider-instrumentation.ts).
   */
  private readonly logEvents = new Counter({
    name: 'log_events_total',
    help: 'Log lines written by this process, by level.',
    labelNames: ['level'] as const,
    registers: [this.registry],
  });

  private readonly loggerWriteFailures = new Counter({
    name: 'logger_write_failures_total',
    help: 'Log lines that could not be serialized and were replaced by a logger.write_failed marker.',
    registers: [this.registry],
  });

  private readonly jobDuration = new Histogram({
    name: 'bullmq_job_duration_seconds',
    help: 'BullMQ processor run time per attempt, by queue and outcome (completed, retry, failed, deferred).',
    labelNames: ['queue', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  private readonly jobAttempts = new Counter({
    name: 'bullmq_job_attempts_total',
    help: 'BullMQ processor attempts, by queue and outcome, counted by the replica that ran them.',
    labelNames: ['queue', 'outcome'] as const,
    registers: [this.registry],
  });

  private readonly externalRequests = new Counter({
    name: 'external_requests_total',
    help: 'Outbound HTTP requests to third-party providers, by provider and outcome.',
    labelNames: ['provider', 'outcome'] as const,
    registers: [this.registry],
  });

  private readonly externalRequestDuration = new Histogram({
    name: 'external_request_duration_seconds',
    help: 'Outbound HTTP request duration to response headers (or failure), by provider and outcome.',
    labelNames: ['provider', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });

  constructor() {
    // Standard Node/process metrics (event-loop lag, heap, CPU, handles) —
    // present in §14's gap table under "Workers: CPU, memory, event-loop
    // lag" (❌ before this pass), free to collect via prom-client itself.
    collectDefaultMetrics({ register: this.registry });

    // The logging instrumentation runs outside Nest DI (logger, undici
    // channel, BullMQ processor wrapper); hand it this registry's recorders.
    setLogMetricsSink({
      onLog: (level) => this.logEvents.inc({ level }),
      onWriteFailure: () => this.loggerWriteFailures.inc(),
    });
    setJobMetricsSink({ observeJob: (queue, outcome, seconds) => this.observeJob(queue, outcome, seconds) });
    setProviderMetricsSink({
      observeProviderRequest: (provider, outcome, seconds) =>
        this.observeProviderRequest(provider, outcome, seconds),
    });
  }

  observeJob(queue: string, outcome: JobOutcome, durationSeconds: number): void {
    this.jobAttempts.inc({ queue, outcome });
    this.jobDuration.observe({ queue, outcome }, durationSeconds);
  }

  observeProviderRequest(provider: string, outcome: ProviderOutcome, durationSeconds: number): void {
    this.externalRequests.inc({ provider, outcome });
    this.externalRequestDuration.observe({ provider, outcome }, durationSeconds);
  }

  recordJobEvent(
    queue: string,
    status: 'completed' | 'failed' | 'stalled',
  ): void {
    this.jobsTotal.inc({ queue, status });
  }

  setQueueDepth(queue: string, state: string, value: number): void {
    this.queueDepth.set({ queue, state }, value);
  }

  recordCacheOperation(cache: string, result: 'hit' | 'miss'): void {
    this.cacheOperations.inc({ cache, result });
  }

  setWorkerHeartbeat(
    worker: string,
    timestampSeconds: number = Date.now() / 1000,
  ): void {
    this.workerHeartbeat.set({ worker }, timestampSeconds);
  }

  recordLoginProtectionEvent(
    event: 'engaged' | 'blocked' | 'cleared' | 'store_unavailable',
  ): void {
    this.loginProtectionEvents.inc({ event });
  }

  recordApiKeyAuthFailure(reason: 'missing' | 'unknown' | 'inactive' | 'expired'): void {
    this.apiKeyAuthFailures.inc({ reason });
  }

  recordThrottlerStorageEvent(
    event: 'redis_unavailable' | 'degraded_entered' | 'recovered',
  ): void {
    this.throttlerStorageEvents.inc({ event });
  }

  recordAuthAbuseLimiterEvent(
    limiter: AuthAbuseLimiterScope,
    event: 'allowed' | 'refused' | 'suppressed' | 'degraded_allowed' | 'degraded_refused',
  ): void {
    this.authAbuseLimiterEvents.inc({ limiter, event });
  }

  /** ZT-010 — the recovery lookup found more than one live row for one normalized email; `uq_user_email_global` has been lost. */
  recordAuthRecoveryEvent(event: 'multiplicity_violation'): void {
    this.authRecoveryEvents.inc({ event });
  }

  /**
   * AUTH-002 — `reuse_detected`: a revoked token was replayed outside the retry
   * window and its family was revoked (investigate: possible token theft).
   * `retry_served`: a client whose response was lost resumed from the recorded
   * successor inside the bounded window (benign, but a sustained rate means
   * clients are losing responses).
   * `concurrent_refused`: a request lost the atomic rotation gate to another
   * request presenting the same token — the winner's session is intact and
   * nothing was revoked. Benign in itself, but it was previously the ONE
   * rotation outcome with no metric and no log at all, which is why a client
   * that mistook it for session loss went undiagnosed: the server saw only an
   * ordinary 401. A sustained rate means clients are refreshing concurrently
   * (multiple tabs) and should be serialising it.
   */
  recordRefreshRotationEvent(
    event: 'reuse_detected' | 'retry_served' | 'concurrent_refused',
  ): void {
    this.refreshRotationEvents.inc({ event });
  }

  /** F-25 — `fallback` = whether the patient was told the assistant could not answer. */
  recordWhatsappAiTurnFailure(fallback: 'sent' | 'not_sent'): void {
    this.whatsappAiTurnFailures.inc({ fallback });
  }

  recordWhatsappAiDecision(
    decision: 'ALLOW' | 'SKIP',
    reason: string,
    stage: 'pre_ai' | 'pre_send',
  ): void {
    this.whatsappAiDecisions.inc({ decision, reason, stage });
  }

  recordWhatsappInboundEvent(
    result: 'accepted' | 'deduplicated' | 'no_tenant',
  ): void {
    this.whatsappInboundEvents.inc({ result });
  }

  recordWhatsappAiReply(
    result: 'sent' | 'suppressed' | 'deduped' | 'failed',
  ): void {
    this.whatsappAiReplies.inc({ result });
  }

  observeWhatsappAiTurnSeconds(seconds: number): void {
    this.whatsappAiTurnSeconds.observe(seconds);
  }

  recordAiScopeBlock(channel: string, category: string): void {
    this.aiScopeBlocks.inc({ channel, category });
  }

  recordWhatsappContactLockBusy(): void {
    this.whatsappContactLockBusy.inc();
  }

  recordFreeAccessNotice(
    kind: 'started' | 'expiring',
    channel: 'in_app' | 'email',
    outcome: 'sent' | 'duplicate' | 'stale' | 'failed' | 'no_recipient',
  ): void {
    this.freeAccessNotices.inc({ kind, channel, outcome });
  }

  recordHttpRequest(method: string, statusCode: number, durationSeconds: number): void {
    this.httpRequestDuration.observe({ method, status_code: String(statusCode) }, durationSeconds);
  }

  /** `route` must already be a matched pattern (or `'unknown'`) — see `dbQueries`' docstring. */
  recordDbQuery(route: string): void {
    this.dbQueries.inc({ route });
  }

  /**
   * P1.3 — the three `pg-pool` gauges (`totalCount`/`idleCount`/`waitingCount`)
   * sampled once per interval by `DbPoolMetricsService`, in whichever process
   * root has a pool (API and worker each have their own — this service is
   * registered in both). Deliberately three separate gauges rather than one
   * labelled by state: `waiting` in particular is the one an alert should
   * fire on directly (`waiting > 0` sustained means every checked-out
   * connection is busy and requests are queueing for one), and a single
   * metric name with a stable query is easier to alert on than a labelled
   * one. No route/tenant/query-text label on any of them — process-wide pool
   * state only, same public-safety posture as `dbQueries` above.
   */
  private readonly dbPoolTotal = new Gauge({
    name: 'db_pool_total',
    help: 'Total connections currently held by the DB pool (in use + idle).',
    registers: [this.registry],
  });
  private readonly dbPoolIdle = new Gauge({
    name: 'db_pool_idle',
    help: 'Connections in the DB pool that are open but not checked out.',
    registers: [this.registry],
  });
  private readonly dbPoolWaiting = new Gauge({
    name: 'db_pool_waiting',
    help: 'Callers currently queued waiting for a DB pool connection to free up. Sustained > 0 means the pool is saturated.',
    registers: [this.registry],
  });

  setDbPoolStats(stats: {
    total: number;
    idle: number;
    waiting: number;
  }): void {
    this.dbPoolTotal.set(stats.total);
    this.dbPoolIdle.set(stats.idle);
    this.dbPoolWaiting.set(stats.waiting);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
