import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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

  constructor() {
    // Standard Node/process metrics (event-loop lag, heap, CPU, handles) —
    // present in §14's gap table under "Workers: CPU, memory, event-loop
    // lag" (❌ before this pass), free to collect via prom-client itself.
    collectDefaultMetrics({ register: this.registry });
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

  recordThrottlerStorageEvent(event: 'redis_unavailable'): void {
    this.throttlerStorageEvents.inc({ event });
  }

  recordHttpRequest(method: string, statusCode: number, durationSeconds: number): void {
    this.httpRequestDuration.observe({ method, status_code: String(statusCode) }, durationSeconds);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
