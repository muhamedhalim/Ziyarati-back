import { JOB, JobName } from './queue.constants';
import { PERMISSION, PermissionSlug } from '../rbac/rbac.constants';

/**
 * Per-job-name authorization tier (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.10). Replaces inferring SYSTEM-tier
 * solely from `!data.tenantId`: `tenantId` being null is a payload-shape fact,
 * not a job-type declaration — e.g. `whatsapp.webhookProcess`'s own type
 * allows `tenantId: string | null` even for a real per-tenant job (an inbound
 * event whose `phone_number_id` matched no live account). The OLD blanket rule
 * conflated "no tenant in THIS payload" with "this job type is inherently
 * system-wide" — a future bug that accidentally nulled a real tenant job's
 * `tenantId` would have silently downgraded to unchecked execution instead of
 * failing loudly.
 *
 * Three tiers:
 *  - `system`         — never has a real tenant to check (a platform-wide sweep).
 *  - `tenant`         — ALWAYS carries a real tenantId per its own job-data type;
 *                       a null tenantId at runtime is now a rejection (data
 *                       corruption / misconfiguration), not a silent skip.
 *                       Actor validation still only runs when `actorId` is
 *                       present (many tenant-tier jobs are system-triggered
 *                       within a tenant, with no human actor at all).
 *  - `system-or-tenant` — a job name that GENUINELY serves both roles under
 *                       the same name: several queues fan a null-tenantId
 *                       sweep out into real-tenantId per-tenant jobs of the
 *                       SAME job name (`analytics.aggregate`,
 *                       `analytics.generateReport`, `settlements.process`),
 *                       and `email.send` legitimately has both platform-level
 *                       (no tenant) and tenant-scoped senders. For these,
 *                       tenantId presence decides tenant-vs-system per
 *                       invocation — the same behaviour the old blanket rule
 *                       had, but now an explicit, per-job-name opt-in instead
 *                       of an implicit default applied to every job.
 *
 * `requiredPermission` (optional, only meaningful when an actor IS present):
 * per instruction ("add permission checks only for jobs you actually need"),
 * reviewed every job type for genuine permission-drift risk — an HTTP-triggered
 * enqueue re-validates permission at click time, and most jobs execute
 * promptly after, so re-checking on every job would be unnecessary overhead
 * for a risk that doesn't exist. The one real gap: `workflow.action` — the
 * visual workflow builder lets an admin configure an arbitrary per-action
 * `delayMinutes`, so a job can sit delayed for hours/days after the
 * triggering permission check, executing real side effects (email/WhatsApp/
 * webhook sends) attributed to an actor whose permissions may have been
 * revoked since. No other job type here has an analogous long-delay +
 * side-effect shape. Checked against `PERMISSION.AI_MANAGE` — the SAME
 * permission `WorkflowController` already requires to trigger/manage a
 * workflow (`workflow.controller.ts:81`), reused rather than inventing a new
 * slug. Workflow runs with no human actor (system-triggered, e.g. an
 * appointment-created trigger) are unaffected — the check only runs when an
 * `actorId` is actually present.
 */
export type JobAuthzTier = 'system' | 'tenant' | 'system-or-tenant';

export interface JobAuthzPolicy {
  tier: JobAuthzTier;
  requiredPermission?: PermissionSlug;
}

const SYSTEM: JobAuthzPolicy = { tier: 'system' };
const TENANT: JobAuthzPolicy = { tier: 'tenant' };
const SYSTEM_OR_TENANT: JobAuthzPolicy = { tier: 'system-or-tenant' };

export const JOB_AUTHZ_POLICY: Partial<Record<JobName, JobAuthzPolicy>> = {
  [JOB.NOTIFICATIONS_DISPATCH]: TENANT,
  [JOB.NOTIFICATIONS_REAP]: SYSTEM,
  [JOB.WHATSAPP_SEND]: TENANT,
  [JOB.WHATSAPP_RETRY]: TENANT,
  // Own type declares `tenantId: string | null` — null is a legitimate,
  // documented case (event matched no live account), not a bug.
  [JOB.WHATSAPP_WEBHOOK_PROCESS]: SYSTEM_OR_TENANT,
  [JOB.WHATSAPP_MEDIA_DOWNLOAD]: TENANT,
  [JOB.CAMPAIGNS_LAUNCH]: TENANT,
  [JOB.CAMPAIGNS_FANOUT_CHUNK]: TENANT,
  [JOB.CAMPAIGNS_PROCESS_RECIPIENT]: TENANT,
  [JOB.AI_EXECUTE]: TENANT,
  [JOB.AI_MEMORY_CLEANUP]: SYSTEM,
  [JOB.AI_BATCH_POLL]: SYSTEM,
  // Fans a null-tenantId sweep out into real-tenantId jobs of the SAME name.
  [JOB.ANALYTICS_AGGREGATE]: SYSTEM_OR_TENANT,
  [JOB.ANALYTICS_GENERATE_REPORT]: SYSTEM_OR_TENANT,
  [JOB.ANALYTICS_CLEANUP]: SYSTEM,
  // Same fan-out pattern as the analytics sweeps.
  [JOB.SETTLEMENTS_PROCESS]: SYSTEM_OR_TENANT,
  [JOB.SUBSCRIPTIONS_RENEWAL_CHECK]: SYSTEM,
  [JOB.REFUNDS_REAP]: SYSTEM,
  [JOB.PAYMENTS_RECONCILE]: SYSTEM,
  [JOB.PLATFORM_LOG_CLEANUP]: SYSTEM,
  // Both platform-level (no tenant — e.g. a security alert to a platform
  // admin) and tenant-scoped senders exist under this one job name.
  [JOB.EMAIL_SEND]: SYSTEM_OR_TENANT,
  // Report schedules are platform-level (super-admin), never per-tenant.
  [JOB.USAGE_REPORT_TICK]: SYSTEM,
  [JOB.USAGE_REPORT_RUN]: SYSTEM,
  [JOB.WORKFLOW_RUN]: TENANT,
  [JOB.WORKFLOW_ACTION]: { tier: 'tenant', requiredPermission: PERMISSION.AI_MANAGE },
  [JOB.WEBHOOKS_DELIVER]: TENANT,
  [JOB.INTEGRATION_IMPORT]: TENANT,
  [JOB.INTEGRATION_SYNC]: TENANT,
  [JOB.INTEGRATION_INBOUND]: TENANT,
  [JOB.INTEGRATION_RECOVER_STALE]: SYSTEM,
};

/**
 * Resolves a job's policy. FAIL CLOSED (gap-closure pass — see
 * docs/CACHING_QUEUES_AUDIT.md §0.8.7): an unregistered job name THROWS rather
 * than degrading to a permissive default. The previous version silently fell
 * back to `system-or-tenant` (the old blanket payload-shape inference) for
 * anything missing from the registry — meaning a NEW job type someone forgot
 * to register here would quietly run with the most permissive tier available
 * instead of failing loudly, defeating the entire point of a per-job-name
 * registry. `WorkerAuthorizationService.assertAuthorized` is expected to catch
 * this and reject the job (`UnrecoverableError`, no retry) rather than let it
 * propagate as an unhandled crash.
 */
export function resolveJobAuthzPolicy(jobName: string): JobAuthzPolicy {
  const policy = JOB_AUTHZ_POLICY[jobName as JobName];
  if (!policy) {
    throw new Error(
      `No authorization policy registered for job "${jobName}" in JOB_AUTHZ_POLICY — ` +
        'register an explicit tier in job-authorization.constants.ts before this job type can run.',
    );
  }
  return policy;
}
