import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { JOB } from './queue.constants';

/**
 * Redis payload minimisation for the three job types that carry content
 * (residency plan P6): `email.send` (recipient + template variables),
 * `whatsapp.send` / `whatsapp.retry` (recipient + template variables) and
 * `ai.execute` (raw message text).
 *
 * The payload is needed for exactly one reason: to run the job, and to retry it
 * if it fails. Once a job has COMPLETED nothing reads it again, yet BullMQ keeps
 * the whole job — recipient, variables, a staff member's temporary password —
 * in Redis for `removeOnComplete.age` (one hour) for anyone with Redis access.
 * After completion the content fields are therefore overwritten with a
 * minimised copy. The job id, template, idempotency key and record ids stay, so
 * queue-level de-duplication and observability are untouched.
 *
 * Deliberately NOT done here: failed jobs. A job that is waiting for a retry
 * must keep its payload, and an exhausted one is kept for the on-call replay
 * window (`PII_REMOVE_ON_FAIL_SECONDS`, six hours). Removing that would trade a
 * short exposure window for losing the ability to replay.
 */

/** Marker written into a minimised payload; processors refuse to run one. */
export const MINIMIZED_FLAG = 'minimized';

const BASE_KEYS = ['tenantId', 'correlationId', 'actorId', 'v'] as const;

function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * The minimised payload for a COMPLETED job of this name, or `null` when the
 * job type carries no content and is left alone. Pure — no I/O.
 */
export function minimizeJobData(
  jobName: string,
  data: unknown,
): Record<string, unknown> | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (d[MINIMIZED_FLAG] === true) return null; // already done

  switch (jobName) {
    case JOB.EMAIL_SEND:
      // Dropped: `to`, `variables`, `replyTo`.
      return {
        ...pick(d, BASE_KEYS),
        ...pick(d, ['template', 'locale', 'idempotencyKey']),
        [MINIMIZED_FLAG]: true,
      };

    case JOB.WHATSAPP_SEND:
    case JOB.WHATSAPP_RETRY: {
      const payload =
        d.payload !== null && typeof d.payload === 'object'
          ? (d.payload as Record<string, unknown>)
          : {};
      // Dropped: `toWaId`, `variables`. Record ids stay.
      return {
        ...pick(d, BASE_KEYS),
        ...pick(d, ['templateId', 'logId']),
        payload: pick(payload, [
          'accountId',
          'branchId',
          'contactId',
          'customerId',
          'scheduledAt',
        ]),
        [MINIMIZED_FLAG]: true,
      };
    }

    case JOB.AI_EXECUTE:
      // Dropped: `content` (the raw patient/user message).
      return {
        ...pick(d, BASE_KEYS),
        ...pick(d, ['aiConversationId', 'idempotencyKey']),
        [MINIMIZED_FLAG]: true,
      };

    default:
      return null;
  }
}

/** True when a job's payload has already been minimised after completion. */
export function isMinimized(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    (data as Record<string, unknown>)[MINIMIZED_FLAG] === true
  );
}

/**
 * Overwrites a completed job's payload with its minimised copy. Never throws:
 * the job has already succeeded, and the job may legitimately be gone by now
 * (`removeOnComplete`), so a failure here is logged and ignored.
 */
export async function minimizeCompletedJob(
  job: Pick<Job, 'name' | 'id' | 'data' | 'updateData'> | undefined,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  if (!job) return;
  const minimized = minimizeJobData(job.name, job.data);
  if (!minimized) return;
  try {
    await job.updateData(minimized);
  } catch (err) {
    logger.warn(
      `could not minimise completed ${job.name} job=${job.id}: ${(err as Error)?.message}`,
    );
  }
}
