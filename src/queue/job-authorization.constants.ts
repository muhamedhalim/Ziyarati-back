import { JOB, JobName } from './queue.constants';
import { PERMISSION, PermissionSlug } from '../rbac/rbac.constants';
import { FeatureKey } from '../modules/subscription-billing/feature-registry';

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
  /**
   * The platform capability this job exercises on the tenant's behalf.
   *
   * Background work used to evaluate NOTHING about entitlement — no reference
   * to `AccessControlService` existed anywhere under `src/worker` or
   * `src/queue`, so a queued WhatsApp send, campaign fan-out or AI turn ran for
   * a tenant whose capability was switched off, suspended, or never granted.
   * Naming the capability here makes a job ask the SAME question its HTTP
   * sibling asks at the route.
   *
   * Omit for jobs that are not tenant-scoped work (sweeps, reaps) or that must
   * run regardless of entitlement — e.g. webhook delivery of events already
   * produced, and inbound integration ingest, which must keep accepting data
   * so nothing is lost while a tenant is blocked.
   */
  featureKey?: FeatureKey;
}

const SYSTEM: JobAuthzPolicy = { tier: 'system' };
const TENANT: JobAuthzPolicy = { tier: 'tenant' };
const SYSTEM_OR_TENANT: JobAuthzPolicy = { tier: 'system-or-tenant' };

export const JOB_AUTHZ_POLICY: Partial<Record<JobName, JobAuthzPolicy>> = {
  [JOB.NOTIFICATIONS_DISPATCH]: {
    tier: 'tenant',
    featureKey: FeatureKey.NOTIFICATIONS,
  },
  [JOB.NOTIFICATIONS_REAP]: SYSTEM,
  // P1.5 (MS-007) — same queue, same capability as NOTIFICATIONS_DISPATCH
  // above: this job only writes the `ScheduledNotification` rows that
  // eventually flow through that exact dispatch path, so it is gated on the
  // same entitlement rather than a new one.
  [JOB.REMINDERS_SCHEDULE]: {
    tier: 'tenant',
    featureKey: FeatureKey.NOTIFICATIONS,
  },
  [JOB.WHATSAPP_SEND]: { tier: 'tenant', featureKey: FeatureKey.WHATSAPP },
  [JOB.WHATSAPP_RETRY]: { tier: 'tenant', featureKey: FeatureKey.WHATSAPP },
  // Own type declares `tenantId: string | null` — null is a legitimate,
  // documented case (event matched no live account), not a bug.
  //
  // NO `featureKey`, DELIBERATELY. This job INGESTS: it stores the customer's
  // inbound message and status updates. Refusing it for an unentitled or
  // suspended clinic would silently destroy real customer messages that the
  // clinic never gets to read once access is restored — a data-loss cure worse
  // than the disease. What the ingested event goes on to DO is gated instead,
  // at the two seams that act: `WhatsappInboundAiService.handleInboundValue`
  // (AI_ASSISTANT + WHATSAPP, checked once per batch),
  // `AiExecutionService` (AI_ASSISTANT, per turn) and
  // `WhatsappMessagingService.sendSession` (WHATSAPP, per outbound reply).
  [JOB.WHATSAPP_WEBHOOK_PROCESS]: SYSTEM_OR_TENANT,
  [JOB.WHATSAPP_MEDIA_DOWNLOAD]: {
    tier: 'tenant',
    featureKey: FeatureKey.WHATSAPP,
  },
  // NO `featureKey`, same reasoning as WHATSAPP_WEBHOOK_PROCESS immediately
  // above: this SYNCS the clinic's own message history/state from Meta — it
  // does not send anything or consume AI/messaging entitlement, and refusing
  // it for a suspended/unentitled tenant would just leave Coexistence synced
  // forever, not protect anything. Always carries a real tenantId (kicked off
  // by an authenticated onboarding call), so `tenant`, not `system-or-tenant`.
  [JOB.WHATSAPP_COEXISTENCE_SYNC]: TENANT,
  [JOB.CAMPAIGNS_LAUNCH]: { tier: 'tenant', featureKey: FeatureKey.CAMPAIGNS },
  [JOB.CAMPAIGNS_FANOUT_CHUNK]: {
    tier: 'tenant',
    featureKey: FeatureKey.CAMPAIGNS,
  },
  [JOB.CAMPAIGNS_PROCESS_RECIPIENT]: {
    tier: 'tenant',
    featureKey: FeatureKey.CAMPAIGNS,
  },
  [JOB.AI_EXECUTE]: { tier: 'tenant', featureKey: FeatureKey.AI_ASSISTANT },
  [JOB.AI_MEMORY_CLEANUP]: SYSTEM,
  [JOB.AI_TOOL_CALL_RETENTION]: SYSTEM,
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
  // AUTH-005 retention sweep. SYSTEM, never tenant-scoped: `refresh_tokens`
  // has no tenant column (it hangs off `users`), and the sweep's predicate is
  // purely temporal — there is no per-tenant variant of "this row expired a
  // week ago", and no tenant should be able to trigger it.
  [JOB.PLATFORM_AUTH_TOKEN_CLEANUP]: SYSTEM,
  // Both platform-level (no tenant — e.g. a security alert to a platform
  // admin) and tenant-scoped senders exist under this one job name.
  [JOB.EMAIL_SEND]: SYSTEM_OR_TENANT,
  // Report schedules are platform-level (super-admin), never per-tenant.
  [JOB.USAGE_REPORT_TICK]: SYSTEM,
  [JOB.USAGE_REPORT_RUN]: SYSTEM,
  [JOB.WORKFLOW_RUN]: { tier: 'tenant', featureKey: FeatureKey.AUTOMATIONS },
  [JOB.WORKFLOW_ACTION]: {
    tier: 'tenant',
    requiredPermission: PERMISSION.AI_MANAGE,
    featureKey: FeatureKey.AUTOMATIONS,
  },
  // NO `featureKey`, DELIBERATELY. Outbound webhook delivery ships events that
  // were ALREADY produced by work the tenant was entitled to do at the time.
  // Gating delivery would drop those events on the floor after the fact, which
  // breaks the receiving system's view of the world without preventing
  // anything — the capability that produced the event is where entitlement
  // belongs, and that is where it is enforced. Registering the webhook in the
  // first place goes through `@RequireFeature(INTEGRATIONS)` on the HTTP route.
  [JOB.WEBHOOKS_DELIVER]: TENANT,
  [JOB.INTEGRATION_IMPORT]: {
    tier: 'tenant',
    featureKey: FeatureKey.INTEGRATIONS,
  },
  [JOB.INTEGRATION_SYNC]: {
    tier: 'tenant',
    featureKey: FeatureKey.INTEGRATIONS,
  },
  [JOB.INTEGRATION_INBOUND]: TENANT,
  [JOB.INTEGRATION_RECOVER_STALE]: SYSTEM,
  [JOB.CAMPAIGNS_RECOVER_DLQ]: SYSTEM,

  // Spec 014 "Clinic Platform Completion".
  // Same shape as SUBSCRIPTIONS_RENEWAL_CHECK: a single repeatable sweep with
  // no per-invocation tenant identity — billing itself is not feature-gated
  // (FeatureKey.BILLING is `alwaysOn`).
  [JOB.SUBSCRIPTIONS_RENEWAL_BILL]: SYSTEM,
  [JOB.ANALYTICS_EXPORT_GENERATE]: {
    tier: 'tenant',
    featureKey: FeatureKey.ANALYTICS,
  },
  // Rendered for one tenant's own invoice; `invoices` maps to PAYMENTS below.
  [JOB.ANALYTICS_INVOICE_DOCUMENT]: {
    tier: 'tenant',
    featureKey: FeatureKey.PAYMENTS,
  },
  [JOB.PLATFORM_WAITLIST_EVALUATE]: {
    tier: 'tenant',
    featureKey: FeatureKey.APPOINTMENTS,
  },
  // Repeatable maintenance sweeps — no per-invocation tenant identity, same
  // registration shape as PLATFORM_LOG_CLEANUP / ANALYTICS_CLEANUP.
  [JOB.PLATFORM_WAITLIST_EXPIRY]: SYSTEM,
  [JOB.PLATFORM_QUEUE_DAY_CLOSE]: SYSTEM,
  [JOB.PLATFORM_EXPORT_EXPIRY]: SYSTEM,
  // Global sweep with no per-invocation tenant identity. Each tenant's
  // `automations` entitlement is checked INSIDE the sweep, and the runs it
  // triggers execute as tenant-tier `workflow.run` jobs (gated again there).
  [JOB.PLATFORM_BIRTHDAY_GREETINGS]: SYSTEM,
  // The override id is looked up fresh inside `deliver()` — the tenant it
  // belongs to is never trusted from the payload (plan §12).
  [JOB.PLATFORM_FREE_ACCESS_NOTICE]: SYSTEM,
  // Repeatable maintenance sweep — no per-invocation tenant identity, same
  // registration shape as PLATFORM_WAITLIST_EXPIRY / PLATFORM_QUEUE_DAY_CLOSE.
  [JOB.PLATFORM_FREE_ACCESS_EXPIRY_SWEEP]: SYSTEM,
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
