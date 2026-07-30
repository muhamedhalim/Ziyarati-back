import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

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

  get contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
