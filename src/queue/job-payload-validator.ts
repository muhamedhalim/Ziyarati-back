import { UnrecoverableError } from 'bullmq';

import { JOB } from './queue.constants';

interface RequiredFields {
  strings?: readonly string[];
  numbers?: readonly string[];
}

/**
 * Required fields per job name, beyond `BaseJobData.tenantId`/`actorId`
 * (already enforced per the job's declared tier by
 * `WorkerAuthorizationService` — see §0.8.10). Registered only for the job
 * names that reach `runInTenantContext` with EXTRA required fields the
 * processor immediately dereferences (e.g. `data.notificationId`,
 * `data.campaignId`) — a missing/malformed one today surfaces as a confusing
 * downstream crash (a DB query with `undefined`, a `TypeError`) instead of a
 * clean, DLQ-routed rejection (gap-closure — see
 * docs/CACHING_QUEUES_AUDIT.md M2).
 *
 * Deliberately NOT a full schema (zod/class-validator) per job type: every
 * job payload in this codebase is produced exclusively by trusted internal
 * enqueue call sites (never directly from external/HTTP input), so the real
 * risk this closes is a ROLLING-DEPLOY shape mismatch (old-shape job in
 * Redis, new-shape code dequeuing it) or a producer-side bug — not hostile
 * input. A required-field presence/type check catches both without the cost
 * and drift-risk of maintaining a full validated schema per job name. System
 * sweeps with no extra required fields (`payments.reconcile`,
 * `notifications.reap`, `refunds.reap`, `analytics.aggregate`/`.cleanup`,
 * `subscriptions.renewalCheck`, `usageReport.tick`) are intentionally absent
 * — there is nothing beyond `BaseJobData` to check for them.
 */
const REQUIRED_FIELDS: Partial<Record<string, RequiredFields>> = {
  [JOB.NOTIFICATIONS_DISPATCH]: { strings: ['notificationId'] },
  [JOB.WHATSAPP_SEND]: { strings: ['templateId'] },
  [JOB.WHATSAPP_RETRY]: { strings: ['templateId'] },
  [JOB.WHATSAPP_WEBHOOK_PROCESS]: { strings: ['webhookEventId'] },
  [JOB.WHATSAPP_MEDIA_DOWNLOAD]: {
    strings: ['accountId', 'messageId', 'mediaId', 'mediaType'],
  },
  [JOB.CAMPAIGNS_LAUNCH]: {
    strings: ['campaignId', 'runId', 'idempotencyKey'],
  },
  [JOB.CAMPAIGNS_FANOUT_CHUNK]: { strings: ['campaignId', 'runId'] },
  [JOB.CAMPAIGNS_PROCESS_RECIPIENT]: {
    strings: ['campaignId', 'runId', 'recipientId'],
  },
  [JOB.AI_EXECUTE]: {
    strings: ['aiConversationId', 'content', 'idempotencyKey'],
  },
  [JOB.WORKFLOW_RUN]: { strings: ['runId'] },
  [JOB.WORKFLOW_ACTION]: { strings: ['runId'], numbers: ['actionIndex'] },
  [JOB.WEBHOOKS_DELIVER]: { strings: ['webhookDeliveryId'] },
  [JOB.INTEGRATION_IMPORT]: { strings: ['importJobId'] },
  [JOB.INTEGRATION_SYNC]: { strings: ['syncJobId'] },
  [JOB.INTEGRATION_INBOUND]: { strings: ['inboundEventId'] },
};

/**
 * Throws `UnrecoverableError` (BullMQ: permanent failure, no retry — routes
 * to the queue's DLQ handler exactly like an authorization rejection) if
 * `data` isn't a plain object, or is missing/mis-typed a field this job name
 * requires. A no-op for job names with nothing registered (see module
 * docstring) — never throws for those, so this cannot regress a queue that
 * was never in scope.
 */
export function validateJobPayload(jobName: string, data: unknown): void {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new UnrecoverableError(
      `Job "${jobName}" payload is not a plain object`,
    );
  }
  const required = REQUIRED_FIELDS[jobName];
  if (!required) return;

  const record = data as Record<string, unknown>;
  for (const field of required.strings ?? []) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new UnrecoverableError(
        `Job "${jobName}" payload missing required string field "${field}"`,
      );
    }
  }
  for (const field of required.numbers ?? []) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new UnrecoverableError(
        `Job "${jobName}" payload missing required numeric field "${field}"`,
      );
    }
  }
}
