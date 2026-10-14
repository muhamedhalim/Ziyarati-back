import { Logger } from '@nestjs/common';
import { ProcessorDecoratorService } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

import { runWithJobLogContext } from './log-context';
import { LOG_EVENT } from './log-events';

/**
 * Job lifecycle logging + metrics for EVERY BullMQ processor, from one place.
 *
 * `@nestjs/bullmq` builds each `Worker` with
 * `ProcessorDecoratorService.decorate(processor)` — an identity function the
 * library documents as "can be overridden to provide custom behavior". It is
 * not configurable through module options, so `installJobInstrumentation()`
 * wraps the prototype method once, before the worker context is created. The
 * processors themselves, their concurrency, retry/backoff options and job
 * semantics are untouched: the wrapper only observes and rethrows.
 *
 * Ownership: this wrapper is THE place a job failure is logged (once per
 * attempt, by the replica that ran it). `QueueMonitor` and the processors'
 * own `@OnWorkerEvent('failed')` handlers no longer log failures at error.
 *
 *   - retry ahead        → warn  `job.processing.retry_scheduled`
 *   - final failure      → error `job.processing.failed` (the message keeps the
 *                          `failed job=` phrase the existing CloudWatch filter matches)
 *   - DelayedError & co. → debug `job.processing.deferred` (rate-limit reschedules
 *                          are flow control, not failures)
 *   - start / success    → debug (campaign fan-out makes these too hot for info)
 *
 * Payloads are never logged — only queue, job name/id, attempt, duration and
 * the tenant id the producer stamped (validated again by `runInTenantContext`
 * before any work happens).
 */
export type JobOutcome = 'completed' | 'retry' | 'failed' | 'deferred';

export interface JobMetricsSink {
  observeJob(queue: string, outcome: JobOutcome, durationSeconds: number): void;
}

const DEFERRAL_ERRORS = new Set([
  'DelayedError',
  'WaitingChildrenError',
  'WaitingError',
  'RateLimitError',
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const logger = new Logger('JobRunner');
const tracer = trace.getTracer('ziyaratech-jobs');
let metricsSink: JobMetricsSink | undefined;
let installed = false;

export function setJobMetricsSink(sink: JobMetricsSink | undefined): void {
  metricsSink = sink;
}

type Processor = (
  job: Job,
  token?: string,
  signal?: AbortSignal,
) => Promise<unknown>;

export function installJobInstrumentation(): void {
  if (installed) return;
  installed = true;
  const original = ProcessorDecoratorService.prototype.decorate;
  ProcessorDecoratorService.prototype.decorate = function decorate(
    this: ProcessorDecoratorService,
    processor: Processor,
  ) {
    return instrumentProcessor(original.call(this, processor) as Processor);
  } as typeof original;
}

export function instrumentProcessor(processor: Processor): Processor {
  return async (job: Job, token?: string, signal?: AbortSignal) => {
    const queue = job.queueName;
    const attempt = (job.attemptsMade ?? 0) + 1;
    const maxAttempts = Math.max(1, job.opts?.attempts ?? 1);
    const base = jobFields(job, attempt, maxAttempts);

    // One span per attempt so the job's queries/provider calls share a trace.
    // A non-recording no-op when tracing is disabled.
    return tracer.startActiveSpan(
      `job ${queue}/${job.name}`,
      { kind: SpanKind.CONSUMER },
      (span) =>
        runWithJobLogContext(
          {
            queue,
            job_name: job.name,
            job_id: job.id,
            attempt,
            max_attempts: maxAttempts,
          },
          () =>
            runAttempt(
              processor,
              job,
              token,
              signal,
              base,
              attempt,
              maxAttempts,
              span,
            ),
        ),
    );
  };
}

async function runAttempt(
  processor: Processor,
  job: Job,
  token: string | undefined,
  signal: AbortSignal | undefined,
  base: Record<string, unknown>,
  attempt: number,
  maxAttempts: number,
  span: Span,
): Promise<unknown> {
  const queue = job.queueName;
  const startedAt = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e9;
  logger.debug({
    ...base,
    event: LOG_EVENT.JOB_PROCESSING_STARTED,
    message: `[${queue}] started job=${job.id} (${job.name})`,
  });
  try {
    const result = await processor(job, token, signal);
    const seconds = elapsed();
    metricsSink?.observeJob(queue, 'completed', seconds);
    logger.debug({
      ...base,
      event: LOG_EVENT.JOB_PROCESSING_COMPLETED,
      message: `[${queue}] completed job=${job.id} (${job.name})`,
      duration_ms: Math.round(seconds * 1000),
    });
    return result;
  } catch (err) {
    const seconds = elapsed();
    const duration_ms = Math.round(seconds * 1000);
    const name = (err as { name?: string } | null)?.name ?? '';
    if (DEFERRAL_ERRORS.has(name)) {
      metricsSink?.observeJob(queue, 'deferred', seconds);
      logger.debug({
        ...base,
        event: LOG_EVENT.JOB_PROCESSING_DEFERRED,
        message: `[${queue}] deferred job=${job.id} (${name})`,
        duration_ms,
      });
      throw err;
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: name || 'Error' });
    const unrecoverable = name === 'UnrecoverableError';
    const final =
      unrecoverable ||
      (job as unknown as { discarded?: boolean }).discarded === true ||
      attempt >= maxAttempts;
    const reason = (err as { message?: string } | null)?.message ?? String(err);
    if (final) {
      metricsSink?.observeJob(queue, 'failed', seconds);
      logger.error({
        ...base,
        event: LOG_EVENT.JOB_PROCESSING_FAILED,
        message: `[${queue}] ✗ failed job=${job.id} (${job.name}) attempt ${attempt}/${maxAttempts}: ${reason}`,
        duration_ms,
        exhausted: attempt >= maxAttempts,
        unrecoverable,
        error: err,
      });
    } else {
      metricsSink?.observeJob(queue, 'retry', seconds);
      logger.warn({
        ...base,
        event: LOG_EVENT.JOB_PROCESSING_RETRY_SCHEDULED,
        message: `[${queue}] retry job=${job.id} (${job.name}) after attempt ${attempt}/${maxAttempts}: ${reason}`,
        duration_ms,
        error: err,
      });
    }
    throw err;
  } finally {
    span.end();
  }
}

function jobFields(
  job: Job,
  attempt: number,
  maxAttempts: number,
): Record<string, unknown> {
  const data = (job.data ?? {}) as {
    tenantId?: unknown;
    correlationId?: unknown;
  };
  const fields: Record<string, unknown> = {
    queue: job.queueName,
    job_name: job.name,
    job_id: job.id,
    attempt,
    max_attempts: maxAttempts,
  };
  if (typeof data.tenantId === 'string' && UUID_RE.test(data.tenantId))
    fields.tenant_id = data.tenantId;
  if (
    typeof data.correlationId === 'string' &&
    SAFE_ID_RE.test(data.correlationId)
  ) {
    fields.request_id = data.correlationId;
  }
  return fields;
}
