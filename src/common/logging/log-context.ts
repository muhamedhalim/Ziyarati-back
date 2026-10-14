import { AsyncLocalStorage } from 'node:async_hooks';

import { getTenantLogContext } from '../../core/tenant-context/tenant-context.service';
import { activeSpanIds } from './tracing';

/**
 * Per-job log fields (queue, job, attempt), set by the job instrumentation
 * around every processor call.
 *
 * Deliberately a SEPARATE AsyncLocalStorage from the tenant context: a
 * processor re-opens the tenant store itself (`runInTenantContext`), which
 * would wipe anything stored there by an outer wrapper. Two independent stores
 * nest cleanly — the job fields survive the tenant store being replaced
 * underneath them.
 */
export interface JobLogContext {
  queue: string;
  job_name: string;
  job_id: string | undefined;
  attempt: number;
  max_attempts: number;
}

const jobLogAls = new AsyncLocalStorage<JobLogContext>();

export function runWithJobLogContext<T>(ctx: JobLogContext, fn: () => T): T {
  return jobLogAls.run(ctx, fn);
}

export function getJobLogContext(): JobLogContext | undefined {
  return jobLogAls.getStore();
}

/**
 * The context fields every log line gets automatically. Identity comes ONLY
 * from the tenant store (authenticated principal / authorized job), never from
 * request input. Never throws: a failure here must not cost the log line.
 */
export function currentLogContext(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const tenant = getTenantLogContext();
    if (tenant) {
      if (tenant.requestId) out.request_id = tenant.requestId;
      if (tenant.userId) out.user_id = tenant.userId;
      if (tenant.tenantId) out.tenant_id = tenant.tenantId;
      if (tenant.platformAdmin) out.platform_admin = true;
    }
    const job = jobLogAls.getStore();
    if (job) {
      out.queue = job.queue;
      out.job_name = job.job_name;
      if (job.job_id !== undefined) out.job_id = job.job_id;
      out.attempt = job.attempt;
    }
    const span = activeSpanIds();
    if (span) {
      out.trace_id = span.trace_id;
      out.span_id = span.span_id;
    }
  } catch {
    // context is best-effort
  }
  return out;
}
