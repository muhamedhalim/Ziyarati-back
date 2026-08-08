/**
 * ============================================================================
 *  SUPPORT OPERATIONS CONSOLE — shared constants
 * ============================================================================
 *
 * Platform Customer Service works tickets ACROSS tenants, so every endpoint in
 * this module is deliberately cross-tenant and therefore deliberately
 * explicit: the target clinic always arrives as a `:tenantId` path parameter
 * that `SupportClinicResolver` validates, never as an ambient tenant context.
 *
 * Nothing here weakens tenant scoping elsewhere — `TenantContextService.
 * requireTenantId()` and every tenant-scoped service stay exactly as they are.
 */

/** Default page size for every paginated diagnostic history. */
export const SUPPORT_DIAGNOSTIC_PAGE_SIZE = 20;

/**
 * Clinic directory page size. Separate from the diagnostic-history size
 * because the directory is a BROWSE surface (an agent scanning for the clinic
 * that just called) rather than a forensic one, so a slightly larger page is
 * genuinely more useful. The ceiling still exists for the same reason as
 * everywhere else here: diagnostics never bulk-export a tenant list.
 */
export const SUPPORT_CLINIC_DIRECTORY_PAGE_SIZE = 25;

/** Hard ceiling on the clinic-directory page size. */
export const SUPPORT_CLINIC_DIRECTORY_MAX_PAGE_SIZE = 100;

/** Hard ceiling on any diagnostic page size — diagnostics never bulk-export. */
export const SUPPORT_DIAGNOSTIC_MAX_PAGE_SIZE = 100;

/**
 * Default look-back for delivery/activity histories when the caller supplies
 * no explicit range. Diagnostics answer "what happened to this clinic
 * recently", not "give me everything ever" — an unbounded scan of
 * `email_logs` / `audit_logs` / `payments` for a busy clinic is both a
 * performance hazard and more disclosure than a support case needs.
 */
export const SUPPORT_DIAGNOSTIC_DEFAULT_DAYS = 30;

/** Ceiling on the look-back window a caller may request. */
export const SUPPORT_DIAGNOSTIC_MAX_DAYS = 180;

/**
 * Email templates Support is allowed to RESEND (§8 of the Support Operations
 * Console brief: "never let Platform Support choose an arbitrary template").
 * The resend endpoint re-resolves the destination and the payload from the
 * stored record — the caller supplies only which record to resend, never a
 * template name, never an address. This list exists so a future template
 * cannot become resendable by accident.
 */
export const SUPPORT_RESENDABLE_EMAIL_TEMPLATES = [
  'staff_invitation',
] as const;

export type SupportResendableEmailTemplate =
  (typeof SUPPORT_RESENDABLE_EMAIL_TEMPLATES)[number];

/**
 * Queues surfaced in the Support jobs-health view. A deliberate allow-list
 * rather than "every queue": Support needs to answer "is delivery working?",
 * not to inventory the platform's internals.
 */
export const SUPPORT_VISIBLE_QUEUES = [
  'email',
  'notifications',
  'whatsapp',
] as const;

/**
 * Redis key holding the worker-liveness heartbeat. Mirrors
 * `MonitoringService`'s constant rather than importing it — the platform
 * monitoring module is super-admin-scoped and pulling it in here would wire a
 * cross-module dependency for one string. The heartbeat itself is written by
 * the refunds reaper and reused platform-wide as the "is any worker alive"
 * proxy.
 */
export const SUPPORT_WORKER_HEARTBEAT_KEY = 'payments:reaper:heartbeat';

/** Heartbeat older than this reads as `degraded` rather than `running`. */
export const SUPPORT_WORKER_HEARTBEAT_STALE_SECONDS = 3600;

/**
 * Audit actions surfaced in a clinic's Support activity timeline. An
 * allow-list, not a denylist: `audit_logs.action` is an open string written by
 * many services, so an "everything except X" filter would silently start
 * leaking whatever a future service decides to record. Anything not listed
 * here simply does not appear in the Support timeline.
 */
export const SUPPORT_VISIBLE_AUDIT_ACTIONS = [
  // Tenant lifecycle
  'tenant.approved',
  'tenant.rejected',
  'tenant.suspended',
  'tenant.reactivated',
  // Subscription / entitlement (platform-admin writer)
  'platform_admin.billing_mode.set',
  'platform_admin.override.grant',
  'platform_admin.override.extend',
  'platform_admin.override.revoke',
  'subscription.entered_grace',
  'subscription.grace_expired',
  // Staff access / invitations
  'staff.invitation_sent',
  'staff.invitation_resent',
  'staff.access_enabled',
  'staff.access_disabled',
  // Integrations
  'whatsapp.account_connected',
  'whatsapp.account_disconnected',
  // Support's own actions (so one agent can see another's)
  'platform_support.email_resent',
  'platform_support.notification_retried',
  'platform_support.integration_rechecked',
] as const;

/**
 * `entity_type` recorded on Support audit rows.
 *
 * The ACTIONS themselves live on `PLATFORM_ADMIN_AUDIT_ACTION`
 * (`SUPPORT_EMAIL_RESENT` and friends) rather than in a parallel constant
 * here: every platform-side action a human takes on a clinic's behalf belongs
 * in one trail, written by one service.
 */
export const SUPPORT_AUDIT_ENTITY = 'SupportDiagnostics';

/**
 * Per-actor rate limit on the safe actions. Each one causes a real outbound
 * message or a real provider probe, so a stuck UI (or a frustrated agent
 * clicking repeatedly) must not turn into a send storm against a clinic's
 * patients. Relaxed under Jest for the same reason as the app-wide default.
 */
export const SUPPORT_ACTION_THROTTLE = {
  default: { limit: process.env.NODE_ENV === 'test' ? 1_000_000 : 10, ttl: 60_000 },
};
