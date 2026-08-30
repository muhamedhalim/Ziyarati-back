/**
 * ============================================================================
 *  RBAC CONTRACT — SINGLE SOURCE OF TRUTH
 * ============================================================================
 *
 * Every part of the system that talks about roles or permissions MUST import
 * from this file:
 *   - the seeder (src/seed/*)
 *   - the guards (PermissionsGuard / RolesGuard)
 *   - the @RequirePermissions / @Roles decorators
 *   - the controllers
 *
 * Rules:
 *   1. ONE format for permissions: dot notation  → "<domain>.<action>".
 *   2. ONE format for role slugs: snake_case      → "super_admin".
 *   3. No hard-coded permission/role strings anywhere else. Reference the
 *      PERMISSION / ROLE objects, which are typed unions — using a slug that
 *      isn't defined here is a COMPILE ERROR.
 */

// ---------------------------------------------------------------------------
// Permissions (dot notation)
// ---------------------------------------------------------------------------

export const PERMISSION = {
  // General / workspace — entry to the clinic dashboard shell itself,
  // independent of what a role can see/do once inside. Every staff role
  // (system or tenant-custom) must hold this to reach `/app/**` at all; see
  // `NON_STAFF_ROLES`/`RoleGuard` on the frontend, which gates purely on
  // possession of this permission rather than a hardcoded role allow-list.
  DASHBOARD_ACCESS: 'dashboard.access',

  // Appointments
  APPOINTMENTS_CREATE: 'appointments.create',
  APPOINTMENTS_READ: 'appointments.read',
  APPOINTMENTS_READ_OWN: 'appointments.read_own', // ABAC — see below
  APPOINTMENTS_UPDATE: 'appointments.update',
  APPOINTMENTS_RESCHEDULE: 'appointments.reschedule',
  APPOINTMENTS_CANCEL: 'appointments.cancel',
  APPOINTMENTS_MANAGE_ALL: 'appointments.manage_all',

  // Reviews (customer feedback on completed appointments)
  REVIEWS_READ: 'reviews.read',
  REVIEWS_CREATE: 'reviews.create',
  REVIEWS_MANAGE: 'reviews.manage', // staff replies / moderation

  // Customers
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_UPDATE: 'customers.update',
  CUSTOMERS_MANAGE: 'customers.manage',

  // CRM (dedicated customer relationship domain — namespaced separately)
  CRM_CUSTOMERS_READ: 'crm.customers.read',
  CRM_CUSTOMERS_MANAGE: 'crm.customers.manage',
  CRM_NOTES_READ: 'crm.notes.read',
  CRM_NOTES_MANAGE: 'crm.notes.manage',
  CRM_TAGS_READ: 'crm.tags.read',
  CRM_TAGS_MANAGE: 'crm.tags.manage',
  CRM_FILES_READ: 'crm.files.read',
  CRM_FILES_MANAGE: 'crm.files.manage',

  // Support Tickets (tenant-side create/read/close/reply/reopen; platform
  // triage is permission-gated via the PLATFORM_SUPPORT_TICKETS_* family below)
  SUPPORT_TICKETS_READ: 'support_tickets.read',
  SUPPORT_TICKETS_CREATE: 'support_tickets.create',
  // Tenant-scoped like READ/CREATE (any caller with it may close any of
  // their own tenant's resolved tickets) — NOT a per-user ABAC ownership
  // scope, so deliberately not registered in OWNERSHIP_SCOPED_PERMISSIONS.
  SUPPORT_TICKETS_CLOSE: 'support_tickets.close',
  // Clinic-visible reply on the caller's OWN tenant's ticket. Deliberately
  // NOT in RESERVED_PERMISSION_SLUGS — delegable into a tenant "Other" custom
  // role like the rest of this family.
  SUPPORT_TICKETS_REPLY: 'support_tickets.reply',
  // "Issue not resolved" — resolved -> in_progress on the caller's own
  // tenant's ticket. Separate from CLOSE: the two are opposite verdicts on a
  // resolved ticket. Also not reserved.
  SUPPORT_TICKETS_REOPEN: 'support_tickets.reopen',

  // Platform Support Tickets (cross-tenant triage by platform staff). All
  // four are in RESERVED_PERMISSION_SLUGS — never delegable to a tenant
  // custom role. CLOSE is granted to no explicit role — it is held only by
  // super_admin via the ALL_PERMISSIONS('*') wildcard, so the close boundary
  // is a permission check, not a role check.
  PLATFORM_SUPPORT_TICKETS_READ: 'platform.support_tickets.read',
  PLATFORM_SUPPORT_TICKETS_TRIAGE: 'platform.support_tickets.triage',
  PLATFORM_SUPPORT_TICKETS_REPLY: 'platform.support_tickets.reply',
  PLATFORM_SUPPORT_TICKETS_CLOSE: 'platform.support_tickets.close',

  // ── Support Operations Console — cross-tenant DIAGNOSTICS ────────────────
  // A separate family from PLATFORM_SUPPORT_TICKETS_* above: those govern the
  // ticket WORKFLOW, these govern READING the clinic state needed to diagnose
  // a ticket. Deliberately one segment deeper than the rest of the catalogue
  // (`platform.support.<area>.<action>`) so the two families never blur — the
  // guard matches the whole slug, so segment depth is cosmetic.
  //
  // Every slug here is READ-ONLY except the three SAFE ACTIONS at the end, and
  // every one is in RESERVED_PERMISSION_SLUGS: a clinic Owner must never be
  // able to delegate cross-tenant diagnostic reach into a tenant custom role.
  // None of them grants financial, RBAC, tenant-administration, medical,
  // secret-bearing or AI-cost access — those stay super-admin-only, and the
  // Support endpoints return dedicated allow-listed DTOs rather than widening
  // any existing Super Admin response.
  PLATFORM_SUPPORT_CLINICS_READ_BASIC: 'platform.support.clinics.read_basic',
  PLATFORM_SUPPORT_SUBSCRIPTIONS_READ: 'platform.support.subscriptions.read',
  PLATFORM_SUPPORT_FEATURES_READ: 'platform.support.features.read',
  PLATFORM_SUPPORT_CLINIC_SETTINGS_READ:
    'platform.support.clinic_settings.read',
  PLATFORM_SUPPORT_INTEGRATIONS_READ: 'platform.support.integrations.read',
  PLATFORM_SUPPORT_NOTIFICATIONS_READ: 'platform.support.notifications.read',
  PLATFORM_SUPPORT_JOBS_READ: 'platform.support.jobs.read',
  PLATFORM_SUPPORT_AUDIT_READ: 'platform.support.audit.read',
  PLATFORM_SUPPORT_APPOINTMENTS_READ_DIAGNOSTICS:
    'platform.support.appointments.read_diagnostics',
  PLATFORM_SUPPORT_PAYMENTS_READ_DIAGNOSTICS:
    'platform.support.payments.read_diagnostics',
  PLATFORM_SUPPORT_AI_READ_DIAGNOSTICS: 'platform.support.ai.read_diagnostics',
  PLATFORM_SUPPORT_WHATSAPP_READ_DIAGNOSTICS:
    'platform.support.whatsapp.read_diagnostics',

  // Safe recovery actions. Each is granted ONLY because an existing service
  // already proves the underlying operation idempotent and destination-safe:
  //   EMAIL_RESEND         -> PlatformStaffService/StaffAccessService
  //                           .resendInvitation (destination + template
  //                           backend-resolved, fresh token, already audited)
  //   NOTIFICATIONS_RETRY  -> NotificationSchedulerService.retry (validates
  //                           RETRYABLE_STATUSES, clears send_attempted,
  //                           audited, single row — never retry-all)
  //   INTEGRATIONS_RECHECK -> MonitoringService.whatsappReadiness + redisPing
  //                           + StorageService.isConfigured (pure reads)
  // No financial, subscription, feature-flag, RBAC or medical write exists.
  PLATFORM_SUPPORT_NOTIFICATIONS_RETRY: 'platform.support.notifications.retry',
  PLATFORM_SUPPORT_EMAIL_RESEND: 'platform.support.email.resend',
  PLATFORM_SUPPORT_INTEGRATIONS_RECHECK:
    'platform.support.integrations.recheck',

  // Profile (self-service)
  PROFILE_UPDATE_OWN: 'profile.update_own', // ABAC — see below

  // Services
  SERVICES_CREATE: 'services.create',
  SERVICES_READ: 'services.read',
  SERVICES_UPDATE: 'services.update',
  SERVICES_DELETE: 'services.delete',

  // Staff
  STAFF_CREATE: 'staff.create',
  STAFF_READ: 'staff.read',
  STAFF_UPDATE: 'staff.update',
  STAFF_MANAGE: 'staff.manage',
  STAFF_SCHEDULE_MANAGE: 'staff.schedule.manage',
  STAFF_TIMEOFF_MANAGE: 'staff.timeoff.manage',
  STAFF_COMMISSION_READ: 'staff.commission.read',
  STAFF_RATING_READ: 'staff.rating.read',

  // Scheduling (availability engine — slots / blocked periods / holidays)
  SCHEDULING_SLOTS_READ: 'scheduling.slots.read',
  SCHEDULING_SLOTS_MANAGE: 'scheduling.slots.manage',
  SCHEDULING_BLOCKED_READ: 'scheduling.blocked.read',
  SCHEDULING_BLOCKED_MANAGE: 'scheduling.blocked.manage',
  SCHEDULING_HOLIDAYS_READ: 'scheduling.holidays.read',
  SCHEDULING_HOLIDAYS_MANAGE: 'scheduling.holidays.manage',
  SCHEDULING_AVAILABILITY_READ: 'scheduling.availability.read',

  // Payments (financial — kept strictly separate from reporting)
  PAYMENTS_READ: 'payments.read',
  PAYMENTS_MANAGE: 'payments.manage',
  REFUNDS_MANAGE: 'refunds.manage',
  INVOICES_READ: 'invoices.read',
  INVOICES_MANAGE: 'invoices.manage',
  SETTLEMENTS_READ: 'settlements.read',
  SETTLEMENTS_MANAGE: 'settlements.manage',

  // Reports / analytics (its own domain — NOT an alias of payments)
  REPORTS_READ: 'reports.read',
  REPORTS_EXPORT: 'reports.export',

  // Analytics (events ingestion + dashboard + pre-aggregated reports)
  ANALYTICS_EVENTS_READ: 'analytics.events.read',
  ANALYTICS_EVENTS_MANAGE: 'analytics.events.manage',
  ANALYTICS_DASHBOARD_READ: 'analytics.dashboard.read',
  ANALYTICS_REPORTS_READ: 'analytics.reports.read',
  ANALYTICS_REPORTS_MANAGE: 'analytics.reports.manage',

  // WhatsApp
  WHATSAPP_SEND: 'whatsapp.send',
  WHATSAPP_ACCOUNTS_READ: 'whatsapp.accounts.read',
  WHATSAPP_ACCOUNTS_MANAGE: 'whatsapp.accounts.manage',
  WHATSAPP_TEMPLATES_READ: 'whatsapp.templates.read',
  WHATSAPP_TEMPLATES_MANAGE: 'whatsapp.templates.manage',
  WHATSAPP_CONTACTS_READ: 'whatsapp.contacts.read',
  WHATSAPP_CONTACTS_MANAGE: 'whatsapp.contacts.manage',
  WHATSAPP_WEBHOOKS_MANAGE: 'whatsapp.webhooks.manage',
  WHATSAPP_ANALYTICS_READ: 'whatsapp.analytics.read',

  // Conversations / Messaging
  CONVERSATIONS_READ: 'conversations.read',
  CONVERSATIONS_MANAGE: 'conversations.manage',
  MESSAGES_SEND: 'messages.send',
  MESSAGES_READ: 'messages.read',
  PARTICIPANTS_MANAGE: 'participants.manage',
  ATTACHMENTS_MANAGE: 'attachments.manage',
  CONVERSATION_ANALYTICS_READ: 'analytics.read',

  // AI
  AI_CHAT: 'ai.chat',
  AI_MANAGE: 'ai.manage',
  AI_AGENTS_READ: 'ai.agents.read',
  AI_AGENTS_MANAGE: 'ai.agents.manage',
  AI_KNOWLEDGE_READ: 'ai.knowledge.read',
  AI_KNOWLEDGE_MANAGE: 'ai.knowledge.manage',
  AI_TRAINING_READ: 'ai.training.read',
  AI_TRAINING_MANAGE: 'ai.training.manage',
  AI_PROMPTS_READ: 'ai.prompts.read',
  AI_PROMPTS_MANAGE: 'ai.prompts.manage',
  AI_CONVERSATIONS_READ: 'ai.conversations.read',
  AI_CONVERSATIONS_MANAGE: 'ai.conversations.manage',
  AI_HANDOVER_READ: 'ai.handover.read',
  AI_HANDOVER_MANAGE: 'ai.handover.manage',
  AI_ANALYTICS_READ: 'ai.analytics.read',

  // Subscription & Billing
  SUBSCRIPTION_READ: 'subscription.read',
  SUBSCRIPTION_MANAGE: 'subscription.manage',
  BILLING_READ: 'billing.read',
  BILLING_MANAGE: 'billing.manage',
  USAGE_READ: 'usage.read',
  FEATUREFLAG_READ: 'featureflag.read',
  FEATUREFLAG_MANAGE: 'featureflag.manage',
  // Owner-initiated feature/limit upgrade requests. Platform-side review is
  // role-gated (super_admin only), not permission-gated — see
  // PlatformBillingUpgradeController, matching PlatformBillingAdminController.
  BILLING_UPGRADE_READ: 'billing_upgrade.read',
  BILLING_UPGRADE_MANAGE: 'billing_upgrade.manage',

  // Notifications
  NOTIFICATIONS_READ: 'notifications.read',
  NOTIFICATIONS_MANAGE: 'notifications.manage',
  NOTIFICATION_TEMPLATES_READ: 'notification_templates.read',
  NOTIFICATION_TEMPLATES_MANAGE: 'notification_templates.manage',
  NOTIFICATION_RULES_READ: 'notification_rules.read',
  NOTIFICATION_RULES_MANAGE: 'notification_rules.manage',

  // Campaigns
  CAMPAIGNS_READ: 'campaigns.read',
  CAMPAIGNS_MANAGE: 'campaigns.manage',
  CAMPAIGN_RECIPIENTS_READ: 'campaign_recipients.read',
  CAMPAIGN_RECIPIENTS_MANAGE: 'campaign_recipients.manage',
  CAMPAIGN_ANALYTICS_READ: 'campaign_analytics.read',

  // Platform / Integrations (infrastructure: API keys, audit logs, files)
  PLATFORM_API_KEYS_READ: 'platform.api-keys.read',
  PLATFORM_API_KEYS_MANAGE: 'platform.api-keys.manage',
  PLATFORM_API_LOGS_READ: 'platform.api-logs.read',
  PLATFORM_WEBHOOKS_READ: 'platform.webhooks.read',
  PLATFORM_WEBHOOKS_MANAGE: 'platform.webhooks.manage',
  // Outbound webhook subscriptions + deliveries (Phase 2 — Integration
  // platform). Deliberately separate from PLATFORM_WEBHOOKS_* above, which
  // governs the INBOUND provider webhook-log admin surface.
  PLATFORM_WEBHOOKS_OUTBOUND_READ: 'platform.webhooks-outbound.read',
  PLATFORM_WEBHOOKS_OUTBOUND_MANAGE: 'platform.webhooks-outbound.manage',
  // External-system integration connections + mapping/import/sync (Phase 3 —
  // two-way integrations). Governs the tenant-admin Developer Options surface;
  // the M2M write API itself is gated by API-key integration scopes, not these.
  PLATFORM_INTEGRATIONS_READ: 'platform.integrations.read',
  PLATFORM_INTEGRATIONS_MANAGE: 'platform.integrations.manage',
  PLATFORM_FILES_READ: 'platform.files.read',
  PLATFORM_FILES_MANAGE: 'platform.files.manage',
  // Platform-owned global settings (super_admin only; held via the * wildcard)
  PLATFORM_SETTINGS_READ: 'platform.settings.read',
  PLATFORM_SETTINGS_MANAGE: 'platform.settings.manage',

  // Admin / system
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  TENANTS_MANAGE: 'tenants.manage',

  // Branches (FND-017 — branch administration, delegable per-branch)
  BRANCHES_CREATE: 'branches.create',
  BRANCHES_UPDATE: 'branches.update',
  BRANCHES_UPDATE_OWN: 'branches.update_own', // ABAC — see below
  BRANCHES_DELETE: 'branches.delete',

  // Clinical records (medical-records module — extends the patient record
  // domain; not granted to any role yet, see T104's enforcing controller)
  CLINICAL_RECORDS_READ: 'clinical.records.read',
  CLINICAL_RECORDS_MANAGE: 'clinical.records.manage',

  // Accountability / activity log (activity-log module — not granted to any
  // role yet, see T190's enforcing controller)
  AUDIT_READ: 'audit.read',
} as const;

export type PermissionSlug = (typeof PERMISSION)[keyof typeof PERMISSION];

/** All permission slugs, computed — no manual list to drift. */
export const ALL_PERMISSION_SLUGS: PermissionSlug[] = Object.values(PERMISSION);

/**
 * ABAC (attribute-based) permissions.
 *
 * These are ownership-scoped and CANNOT be enforced by RBAC possession alone:
 * holding `appointments.read_own` does not mean "read any appointment", it
 * means "read appointments you own". A plain PermissionsGuard check is NOT
 * sufficient — any route protected by one of these MUST additionally verify
 * record ownership in the service layer (e.g. `appointment.customer_id ===
 * currentUser.id`). They are listed separately so this requirement is explicit
 * and discoverable.
 */
export const OWNERSHIP_SCOPED_PERMISSIONS: ReadonlySet<PermissionSlug> =
  new Set([
    PERMISSION.APPOINTMENTS_READ_OWN,
    PERMISSION.PROFILE_UPDATE_OWN,
    PERMISSION.BRANCHES_UPDATE_OWN,
  ]);

/**
 * Permissions in the catalogue with NO verified enforcing consumer — no
 * controller route checks for it (no `@RequirePermissions`/
 * `@RequireAnyPermission` referencing it) and no service-layer ABAC policy
 * references it either (FND-010). `PROFILE_UPDATE_OWN` is the one known case:
 * it is granted to `ROLE.CUSTOMER`, but no seeder or signup flow assigns that
 * role and no route consumes the permission — a catalogue entry without a
 * consumer, per the Feature 004 spec decision: **keep the permission, do not
 * build the route, do not introduce a customer self-service feature.**
 *
 * This set is deliberately explicit and tested both ways —
 * `rbac.constants.spec.ts`'s catalogue-coverage test fails if the codebase's
 * real enforcement coverage ever drifts from this list, whether a permission
 * goes unenforced without being added here, or an entry here turns out to
 * actually be enforced (stale). `RolesService.assignRoleToUser` additionally
 * refuses to let any role carrying one of these become assignable to a user
 * (see `assertNoUnenforcedPermission`) — converting the latent gap into a
 * structurally impossible state rather than a live one, so a future change
 * that starts assigning `customer` cannot silently ship the gap live.
 */
export const UNENFORCED_PERMISSION_SLUGS: ReadonlySet<PermissionSlug> = new Set(
  [PERMISSION.PROFILE_UPDATE_OWN],
);

/**
 * Catalogue permissions verified to be enforced via ROLE-IDENTITY gating
 * (`@Roles(ROLE.SUPER_ADMIN)` + `RolesGuard`) rather than permission-slug
 * checking — held only by `super_admin` via the `ALL_PERMISSIONS` wildcard,
 * never listed individually in any role's explicit permission array. The
 * catalogue-coverage test (`rbac.constants.spec.ts`) greps for literal
 * `PERMISSION.<KEY>` references and can't see role-identity gating (those
 * routes reference `ROLE.SUPER_ADMIN`, never the permission slug at all), so
 * these are excluded from its "unenforced" computation via this explicit,
 * human-verified allow-list rather than read as a false-positive gap.
 */
export const ROLE_GATED_PERMISSION_SLUGS: ReadonlySet<PermissionSlug> = new Set(
  [
    PERMISSION.PLATFORM_SETTINGS_READ, // system-setting.controller.ts:70, @Roles(ROLE.SUPER_ADMIN)
    PERMISSION.PLATFORM_SETTINGS_MANAGE, // ditto — same blanket controller-level gate
    PERMISSION.TENANTS_MANAGE, // tenant.controller.ts:151 (class) + per-method @Roles(ROLE.SUPER_ADMIN)
  ],
);

/**
 * Additional catalogue permissions the coverage test discovered to have NO
 * enforcing consumer, beyond `PROFILE_UPDATE_OWN` (FND-010's own finding) —
 * found BY writing this test, not part of Wave 3's finding list, so building
 * enforcement for them is out of scope for this remediation. Recorded here
 * rather than silently ignored, so the coverage test passes for the RIGHT
 * reason and a future wave can triage each individually:
 *
 *   - CUSTOMERS_CREATE / CUSTOMERS_UPDATE — `CustomerController` (the real,
 *     live route) checks `CRM_CUSTOMERS_MANAGE` instead; these look like
 *     leftovers from before the `crm.*` namespace was split out.
 *   - REPORTS_READ — no `reports.controller.ts` exists; the equivalent read
 *     is `ANALYTICS_REPORTS_READ` (daily/monthly report controllers).
 *     REPORTS_EXPORT was removed from this set in T004 (spec 014): T184
 *     gives it a real enforcing route (`report-export.controller.ts`).
 *   - AI_CHAT — both AI message routes check `AI_CONVERSATIONS_MANAGE`
 *     instead.
 *
 * Deliberately NOT added to `UNENFORCED_PERMISSION_SLUGS` / guarded by
 * `RolesService.assertNoUnenforcedPermission`: every role below is ALREADY
 * actively assigned via the live tenant-registration/staff-creation flow
 * (OWNER, MANAGER, RECEPTIONIST all hold at least one of these), so refusing
 * their assignment the way FND-010 does for the never-assigned `customer`
 * role would break real signup today — a regression this task must not
 * introduce for a problem it wasn't asked to fix.
 */
export const UNTRIAGED_COVERAGE_GAP_SLUGS: ReadonlySet<PermissionSlug> =
  new Set([
    PERMISSION.CUSTOMERS_CREATE,
    PERMISSION.CUSTOMERS_UPDATE,
    PERMISSION.REPORTS_READ,
    PERMISSION.AI_CHAT,
    // clinical.records.* enforcing controller landed in T112 — removed here
    // per this set's own rule ("remove each entry the moment its controller
    // lands", mirroring T004's REPORTS_EXPORT precedent).
    // Declared in T003 with no enforcing route yet, on purpose — audit.read's
    // grant lands with its enforcing code in T190. Remove then.
    PERMISSION.AUDIT_READ,
  ]);

/**
 * Permissions that can never be delegated through the "Other" custom-role
 * flow (`RolesService.assignCustomPermissions`/`validateCustomPermissions`),
 * even to a caller who holds them (e.g. Owner holds `roles.manage` and
 * `users.manage` directly). Granting any of these to a synthesized custom
 * role would let that employee manage OTHER users' roles/accounts or tenant
 * configuration directly via the standalone Roles/Users APIs — a
 * self-escalation path the "caller must hold what they grant" rule alone
 * does not close, since it only asks "does the caller have it", not "should
 * this ever be handed to a narrowly-scoped custom role." `TENANTS_MANAGE` is
 * included even though no tenant role holds it today (defense in depth).
 */
/**
 * The Support Operations Console diagnostic family — the exact set granted to
 * `platform_support` on top of its three ticket-workflow slugs, and the exact
 * set added to {@link RESERVED_PERMISSION_SLUGS}. Declared once so the grant
 * list and the reservation list can never drift apart (a drift would either
 * leave Support unable to do its job, or leave a cross-tenant slug delegable
 * into a tenant custom role).
 *
 * Order: the 12 read-only slugs first, then the 3 safe actions.
 */
export const PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS = [
  PERMISSION.PLATFORM_SUPPORT_CLINICS_READ_BASIC,
  PERMISSION.PLATFORM_SUPPORT_SUBSCRIPTIONS_READ,
  PERMISSION.PLATFORM_SUPPORT_FEATURES_READ,
  PERMISSION.PLATFORM_SUPPORT_CLINIC_SETTINGS_READ,
  PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_READ,
  PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_READ,
  PERMISSION.PLATFORM_SUPPORT_JOBS_READ,
  PERMISSION.PLATFORM_SUPPORT_AUDIT_READ,
  PERMISSION.PLATFORM_SUPPORT_APPOINTMENTS_READ_DIAGNOSTICS,
  PERMISSION.PLATFORM_SUPPORT_PAYMENTS_READ_DIAGNOSTICS,
  PERMISSION.PLATFORM_SUPPORT_AI_READ_DIAGNOSTICS,
  PERMISSION.PLATFORM_SUPPORT_WHATSAPP_READ_DIAGNOSTICS,
  PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_RETRY,
  PERMISSION.PLATFORM_SUPPORT_EMAIL_RESEND,
  PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_RECHECK,
] as const satisfies readonly PermissionSlug[];

export const RESERVED_PERMISSION_SLUGS: ReadonlySet<PermissionSlug> = new Set([
  PERMISSION.ROLES_MANAGE,
  PERMISSION.USERS_MANAGE,
  PERMISSION.TENANTS_MANAGE,
  // Entitlement toggles. A clinic Owner holds `roles.manage`, so anything NOT
  // reserved here can be minted into a tenant custom role and self-granted.
  // `featureflag.manage` writes the `feature_flags` table that the access
  // policy reads, which made it a direct paid-plan bypass: enable the
  // capability for yourself, and (because the grant path is unmetered) get it
  // without quotas too. Provenance (`feature_flags.source`) already neuters a
  // tenant-written row, and reserving the permission is the second lock.
  PERMISSION.FEATUREFLAG_MANAGE,
  // Platform support-ticket slugs (defence in depth alongside
  // API_PROTECTED_ROLE_SLUGS blocking `platform_support` itself) — a clinic
  // Owner must never be able to delegate cross-tenant platform authority into
  // a tenant custom role. The tenant-scoped SUPPORT_TICKETS_REPLY/REOPEN are
  // deliberately NOT here — those are meant to be delegable.
  PERMISSION.PLATFORM_SUPPORT_TICKETS_READ,
  PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE,
  PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY,
  PERMISSION.PLATFORM_SUPPORT_TICKETS_CLOSE,
  // Support Operations Console diagnostics — cross-tenant reach into clinic
  // operational state, plus the three safe recovery actions. Reserved for the
  // same reason as the ticket family: none of it may ever be delegated into a
  // tenant custom role by a clinic Owner who happens to hold `roles.manage`.
  ...PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS,
  // T106 (spec 014, US6, FR-H010b) — the clinical permission decision.
  // OWNER now holds `roles.manage` AND (T105) `clinical.records.read`/
  // `.manage`, so without this reservation an Owner could self-delegate
  // clinical access into an arbitrary "Other" custom role for ANY staff
  // member — including one built for someone doing reception-shaped work —
  // silently defeating FR-H010b's "MUST NOT be granted to the reception
  // role" the moment a custom role existed. Clinical content is exactly the
  // kind of narrowly-and-deliberately-granted capability this reservation
  // list exists for; it is never delegable, even to a caller who holds it.
  // Landed in the SAME change as T105's role grants — a window where the
  // grant exists but the reservation doesn't would itself be the leak.
  PERMISSION.CLINICAL_RECORDS_READ,
  PERMISSION.CLINICAL_RECORDS_MANAGE,
]);

// ---------------------------------------------------------------------------
// Roles (snake_case slugs)
// ---------------------------------------------------------------------------

export const ROLE = {
  SUPER_ADMIN: 'super_admin',
  OWNER: 'owner',
  MANAGER: 'manager',
  RECEPTIONIST: 'receptionist',
  DOCTOR: 'doctor',
  CUSTOMER: 'customer',
  /** Per-tenant system actor driving AI-initiated bookings (e.g. WhatsApp). */
  AI_BOT: 'ai-bot',
  /**
   * Platform-level system role (tenant = NULL, is_system = true). Holds only
   * the PLATFORM_SUPPORT_TICKETS_* read/triage/reply slugs — never CLOSE,
   * never DASHBOARD_ACCESS. Assigned to a `users` row with tenantId = NULL,
   * never to a tenant user (see NON_STAFF_ROLE_SLUGS and
   * API_PROTECTED_ROLE_SLUGS in roles.service.ts).
   */
  PLATFORM_SUPPORT: 'platform_support',
} as const;

export type RoleSlug = (typeof ROLE)[keyof typeof ROLE];

/**
 * Reserved `roleSlug` sentinel for the "Other" option on the Add/Edit Staff
 * role selector. It is deliberately NOT a member of {@link ROLE} / `RoleSlug`
 * and never becomes a row in the `roles` table under this literal slug — it
 * only tells `StaffService`/`RolesService` "synthesize (or update) a
 * tenant-scoped custom role from the caller-supplied `permissionSlugs`
 * instead of resolving a catalogue role." Reused end-to-end (no new
 * authorization system): the synthesized role is a normal row in `roles` /
 * `role_permissions`, assigned via the normal `user_roles` join, and enforced
 * by the same `PermissionsGuard` as every other role.
 */
export const CUSTOM_ROLE_SENTINEL = 'other' as const;

/**
 * Prefix `RolesService.resolveCustomRole` gives a synthesized custom role's
 * `name` when a display-name hint is available — normally the REQUESTING
 * staff member's own `fullName`. This makes `name` an ADMIN-FACING label
 * only: a role synthesized for Alice is named "Custom — Alice", then
 * persisted as an ordinary, reusable, tenant-scoped `Role` row that any
 * future staff member can be assigned via `GET /staff/assignable-roles` — so
 * `name` can end up carrying a DIFFERENT person's name than whoever now
 * holds it. Anything that echoes a role name back to the role HOLDER (e.g.
 * an onboarding email) must treat a name matching this prefix (or the
 * hint-less `'Custom role'` fallback) as unsafe to display — see
 * {@link isSynthesizedCustomRoleName}.
 */
export const CUSTOM_ROLE_NAME_PREFIX = 'Custom — ';

/** The exact fallback `resolveCustomRole` uses when no display-name hint is given. */
export const CUSTOM_ROLE_NAME_FALLBACK = 'Custom role';

/**
 * True for a `Role.name` synthesized by `resolveCustomRole` — i.e. one that
 * may embed a DIFFERENT person's full name and must never be echoed back to
 * whoever currently holds the role (see {@link CUSTOM_ROLE_NAME_PREFIX}).
 */
export function isSynthesizedCustomRoleName(name: string): boolean {
  return (
    name === CUSTOM_ROLE_NAME_FALLBACK ||
    name.startsWith(CUSTOM_ROLE_NAME_PREFIX)
  );
}

/**
 * System roles that can never be assigned as a clinic STAFF role:
 * `super_admin`/`owner` are founding/platform roles (granted only via the
 * seeder / `POST /auth/register-owner`), and `customer`/`ai-bot` are not
 * human-staff roles at all (end-user self-service and a system automation
 * actor, respectively). Everything else — the remaining system roles plus any
 * of the tenant's own custom roles — is fair game, so a tenant's custom roles
 * appear in the staff role selector automatically, with no code change.
 */
export const NON_STAFF_ROLE_SLUGS: readonly RoleSlug[] = [
  ROLE.SUPER_ADMIN,
  ROLE.OWNER,
  ROLE.CUSTOMER,
  ROLE.AI_BOT,
  // Platform-level role — never a clinic staff role. Belongs only to a
  // tenantId = NULL user, provisioned exclusively via /platform/staff.
  ROLE.PLATFORM_SUPPORT,
];

// ---------------------------------------------------------------------------
// Catalogue metadata (consumed by the permissions seeder)
// ---------------------------------------------------------------------------

export interface PermissionDef {
  slug: PermissionSlug;
  name: string;
  module: string;
}

export interface RoleDef {
  slug: RoleSlug;
  name: string;
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  {
    slug: PERMISSION.DASHBOARD_ACCESS,
    name: 'Access clinic dashboard',
    module: 'general',
  },

  {
    slug: PERMISSION.APPOINTMENTS_CREATE,
    name: 'Create appointments',
    module: 'appointments',
  },
  {
    slug: PERMISSION.APPOINTMENTS_READ,
    name: 'Read appointments',
    module: 'appointments',
  },
  {
    slug: PERMISSION.APPOINTMENTS_READ_OWN,
    name: 'Read own appointments',
    module: 'appointments',
  },
  {
    slug: PERMISSION.APPOINTMENTS_UPDATE,
    name: 'Update appointments',
    module: 'appointments',
  },
  {
    slug: PERMISSION.APPOINTMENTS_RESCHEDULE,
    name: 'Reschedule appointments',
    module: 'appointments',
  },
  {
    slug: PERMISSION.APPOINTMENTS_CANCEL,
    name: 'Cancel appointments',
    module: 'appointments',
  },
  {
    slug: PERMISSION.APPOINTMENTS_MANAGE_ALL,
    name: 'Manage all appointments',
    module: 'appointments',
  },

  {
    slug: PERMISSION.REVIEWS_READ,
    name: 'Read customer reviews',
    module: 'reviews',
  },
  {
    slug: PERMISSION.REVIEWS_CREATE,
    name: 'Create customer reviews',
    module: 'reviews',
  },
  {
    slug: PERMISSION.REVIEWS_MANAGE,
    name: 'Manage / reply to reviews',
    module: 'reviews',
  },

  {
    slug: PERMISSION.CUSTOMERS_CREATE,
    name: 'Create customers',
    module: 'customers',
  },
  {
    slug: PERMISSION.CUSTOMERS_READ,
    name: 'Read customers',
    module: 'customers',
  },
  {
    slug: PERMISSION.CUSTOMERS_UPDATE,
    name: 'Update customers',
    module: 'customers',
  },
  {
    slug: PERMISSION.CUSTOMERS_MANAGE,
    name: 'Manage customers',
    module: 'customers',
  },

  {
    slug: PERMISSION.CRM_CUSTOMERS_READ,
    name: 'Read CRM customers',
    module: 'crm',
  },
  {
    slug: PERMISSION.CRM_CUSTOMERS_MANAGE,
    name: 'Manage CRM customers',
    module: 'crm',
  },
  {
    // T104/T105 (spec 014, US6, FR-H010a) — one privacy boundary for BOTH the
    // new structured clinical entries and the clinical fields already stored
    // on CustomerProfile (medical_history, allergies, blood_type, notes).
    slug: PERMISSION.CLINICAL_RECORDS_READ,
    name: 'Read clinical records',
    module: 'clinical',
  },
  {
    slug: PERMISSION.CLINICAL_RECORDS_MANAGE,
    name: 'Manage clinical records',
    module: 'clinical',
  },
  {
    slug: PERMISSION.CRM_NOTES_READ,
    name: 'Read customer notes',
    module: 'crm',
  },
  {
    slug: PERMISSION.CRM_NOTES_MANAGE,
    name: 'Manage customer notes',
    module: 'crm',
  },
  { slug: PERMISSION.CRM_TAGS_READ, name: 'Read customer tags', module: 'crm' },
  {
    slug: PERMISSION.CRM_TAGS_MANAGE,
    name: 'Manage customer tags',
    module: 'crm',
  },
  {
    slug: PERMISSION.CRM_FILES_READ,
    name: 'Read customer files',
    module: 'crm',
  },
  {
    slug: PERMISSION.CRM_FILES_MANAGE,
    name: 'Manage customer files',
    module: 'crm',
  },

  {
    slug: PERMISSION.SUPPORT_TICKETS_READ,
    name: 'Read support tickets',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.SUPPORT_TICKETS_CREATE,
    name: 'Create support tickets',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.SUPPORT_TICKETS_CLOSE,
    name: 'Close own resolved support tickets',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.SUPPORT_TICKETS_REPLY,
    name: 'Reply to own support tickets',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.SUPPORT_TICKETS_REOPEN,
    name: 'Reopen own resolved support tickets ("Issue not resolved")',
    module: 'support_tickets',
  },

  {
    slug: PERMISSION.PLATFORM_SUPPORT_TICKETS_READ,
    name: 'Read platform support tickets (cross-tenant)',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE,
    name: 'Triage platform support tickets (status/priority, cannot close)',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY,
    name: 'Reply to / add internal notes on platform support tickets',
    module: 'support_tickets',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_TICKETS_CLOSE,
    name: 'Close platform support tickets',
    module: 'support_tickets',
  },

  {
    slug: PERMISSION.PLATFORM_SUPPORT_CLINICS_READ_BASIC,
    name: 'Read a clinic support profile (basic operational identity)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_SUBSCRIPTIONS_READ,
    name: 'Read clinic subscription diagnostics (no pricing/cost)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_FEATURES_READ,
    name: 'Read clinic feature/module availability diagnostics',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_CLINIC_SETTINGS_READ,
    name: 'Read safe clinic operational configuration',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_READ,
    name: 'Read clinic integration status (no credentials)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_READ,
    name: 'Read clinic email/notification delivery history',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_JOBS_READ,
    name: 'Read queue/worker health (no Redis administration)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_AUDIT_READ,
    name: 'Read sanitized clinic operational activity timeline',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_APPOINTMENTS_READ_DIAGNOSTICS,
    name: 'Read appointment diagnostics (no medical data)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_PAYMENTS_READ_DIAGNOSTICS,
    name: 'Read payment diagnostics (no card data, fees or secrets)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_AI_READ_DIAGNOSTICS,
    name: 'Read AI diagnostics (no costs, prompts or provider keys)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_WHATSAPP_READ_DIAGNOSTICS,
    name: 'Read WhatsApp diagnostics (no Meta tokens or secrets)',
    module: 'support_diagnostics',
  },

  {
    slug: PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_RETRY,
    name: 'Retry one failed notification (safe, audited)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_EMAIL_RESEND,
    name: 'Resend one eligible transactional email (safe, audited)',
    module: 'support_diagnostics',
  },
  {
    slug: PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_RECHECK,
    name: 'Trigger a read-only integration health recheck (audited)',
    module: 'support_diagnostics',
  },

  {
    slug: PERMISSION.PROFILE_UPDATE_OWN,
    name: 'Update own profile',
    module: 'profile',
  },

  {
    slug: PERMISSION.SERVICES_CREATE,
    name: 'Create services',
    module: 'services',
  },
  { slug: PERMISSION.SERVICES_READ, name: 'Read services', module: 'services' },
  {
    slug: PERMISSION.SERVICES_UPDATE,
    name: 'Update services',
    module: 'services',
  },
  {
    slug: PERMISSION.SERVICES_DELETE,
    name: 'Delete services',
    module: 'services',
  },

  { slug: PERMISSION.STAFF_CREATE, name: 'Create staff', module: 'staff' },
  { slug: PERMISSION.STAFF_READ, name: 'Read staff', module: 'staff' },
  { slug: PERMISSION.STAFF_UPDATE, name: 'Update staff', module: 'staff' },
  { slug: PERMISSION.STAFF_MANAGE, name: 'Manage staff', module: 'staff' },
  {
    slug: PERMISSION.STAFF_SCHEDULE_MANAGE,
    name: 'Manage staff schedules & working hours',
    module: 'staff',
  },
  {
    slug: PERMISSION.STAFF_TIMEOFF_MANAGE,
    name: 'Manage staff time off',
    module: 'staff',
  },
  {
    slug: PERMISSION.STAFF_COMMISSION_READ,
    name: 'Read staff commissions',
    module: 'staff',
  },
  {
    slug: PERMISSION.STAFF_RATING_READ,
    name: 'Read staff ratings',
    module: 'staff',
  },

  {
    slug: PERMISSION.SCHEDULING_SLOTS_READ,
    name: 'Read calendar slots',
    module: 'scheduling',
  },
  {
    slug: PERMISSION.SCHEDULING_SLOTS_MANAGE,
    name: 'Manage calendar slots',
    module: 'scheduling',
  },
  {
    slug: PERMISSION.SCHEDULING_BLOCKED_READ,
    name: 'Read blocked slots',
    module: 'scheduling',
  },
  {
    slug: PERMISSION.SCHEDULING_BLOCKED_MANAGE,
    name: 'Manage blocked slots',
    module: 'scheduling',
  },
  {
    slug: PERMISSION.SCHEDULING_HOLIDAYS_READ,
    name: 'Read holidays',
    module: 'scheduling',
  },
  {
    slug: PERMISSION.SCHEDULING_HOLIDAYS_MANAGE,
    name: 'Manage holidays',
    module: 'scheduling',
  },
  {
    slug: PERMISSION.SCHEDULING_AVAILABILITY_READ,
    name: 'Read availability',
    module: 'scheduling',
  },

  { slug: PERMISSION.PAYMENTS_READ, name: 'Read payments', module: 'payments' },
  {
    slug: PERMISSION.PAYMENTS_MANAGE,
    name: 'Manage payments',
    module: 'payments',
  },
  {
    slug: PERMISSION.REFUNDS_MANAGE,
    name: 'Manage refunds',
    module: 'payments',
  },
  { slug: PERMISSION.INVOICES_READ, name: 'Read invoices', module: 'payments' },
  {
    slug: PERMISSION.INVOICES_MANAGE,
    name: 'Manage invoices',
    module: 'payments',
  },
  {
    slug: PERMISSION.SETTLEMENTS_READ,
    name: 'Read settlements',
    module: 'payments',
  },
  {
    slug: PERMISSION.SETTLEMENTS_MANAGE,
    name: 'Generate / manage settlements',
    module: 'payments',
  },

  { slug: PERMISSION.REPORTS_READ, name: 'Read reports', module: 'reports' },
  {
    slug: PERMISSION.REPORTS_EXPORT,
    name: 'Export reports',
    module: 'reports',
  },

  {
    slug: PERMISSION.ANALYTICS_EVENTS_READ,
    name: 'Read analytics events',
    module: 'analytics',
  },
  {
    slug: PERMISSION.ANALYTICS_EVENTS_MANAGE,
    name: 'Track analytics events',
    module: 'analytics',
  },
  {
    slug: PERMISSION.ANALYTICS_DASHBOARD_READ,
    name: 'Read dashboard metrics',
    module: 'analytics',
  },
  {
    slug: PERMISSION.ANALYTICS_REPORTS_READ,
    name: 'Read analytics reports',
    module: 'analytics',
  },
  {
    slug: PERMISSION.ANALYTICS_REPORTS_MANAGE,
    name: 'Generate analytics reports',
    module: 'analytics',
  },

  {
    slug: PERMISSION.WHATSAPP_SEND,
    name: 'Send WhatsApp messages',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_ACCOUNTS_READ,
    name: 'Read WhatsApp accounts',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_ACCOUNTS_MANAGE,
    name: 'Manage WhatsApp accounts',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_TEMPLATES_READ,
    name: 'Read WhatsApp templates',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_TEMPLATES_MANAGE,
    name: 'Manage WhatsApp templates',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_CONTACTS_READ,
    name: 'Read WhatsApp contacts',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_CONTACTS_MANAGE,
    name: 'Manage WhatsApp contacts',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_WEBHOOKS_MANAGE,
    name: 'Manage WhatsApp webhooks',
    module: 'whatsapp',
  },
  {
    slug: PERMISSION.WHATSAPP_ANALYTICS_READ,
    name: 'Read WhatsApp analytics',
    module: 'whatsapp',
  },

  {
    slug: PERMISSION.CONVERSATIONS_READ,
    name: 'Read conversations',
    module: 'conversations',
  },
  {
    slug: PERMISSION.CONVERSATIONS_MANAGE,
    name: 'Manage conversations',
    module: 'conversations',
  },
  {
    slug: PERMISSION.MESSAGES_SEND,
    name: 'Send messages',
    module: 'conversations',
  },
  {
    slug: PERMISSION.MESSAGES_READ,
    name: 'Read messages',
    module: 'conversations',
  },
  {
    slug: PERMISSION.PARTICIPANTS_MANAGE,
    name: 'Manage conversation participants',
    module: 'conversations',
  },
  {
    slug: PERMISSION.ATTACHMENTS_MANAGE,
    name: 'Manage message attachments',
    module: 'conversations',
  },
  {
    slug: PERMISSION.CONVERSATION_ANALYTICS_READ,
    name: 'Read conversation analytics',
    module: 'conversations',
  },

  { slug: PERMISSION.AI_CHAT, name: 'Use AI assistant', module: 'ai' },
  { slug: PERMISSION.AI_MANAGE, name: 'Manage AI assistant', module: 'ai' },
  { slug: PERMISSION.AI_AGENTS_READ, name: 'Read AI agents', module: 'ai' },
  { slug: PERMISSION.AI_AGENTS_MANAGE, name: 'Manage AI agents', module: 'ai' },
  {
    slug: PERMISSION.AI_KNOWLEDGE_READ,
    name: 'Read AI knowledge bases',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_KNOWLEDGE_MANAGE,
    name: 'Manage AI knowledge bases',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_TRAINING_READ,
    name: 'Read AI training files',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_TRAINING_MANAGE,
    name: 'Manage AI training files',
    module: 'ai',
  },
  { slug: PERMISSION.AI_PROMPTS_READ, name: 'Read AI prompts', module: 'ai' },
  {
    slug: PERMISSION.AI_PROMPTS_MANAGE,
    name: 'Manage AI prompts',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_CONVERSATIONS_READ,
    name: 'Read AI conversations',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_CONVERSATIONS_MANAGE,
    name: 'Manage AI conversations',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_HANDOVER_READ,
    name: 'Read AI handover requests',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_HANDOVER_MANAGE,
    name: 'Manage AI handover requests',
    module: 'ai',
  },
  {
    slug: PERMISSION.AI_ANALYTICS_READ,
    name: 'Read AI analytics',
    module: 'ai',
  },

  {
    slug: PERMISSION.SUBSCRIPTION_READ,
    name: 'Read subscription',
    module: 'billing',
  },
  {
    slug: PERMISSION.SUBSCRIPTION_MANAGE,
    name: 'Manage subscription',
    module: 'billing',
  },
  {
    slug: PERMISSION.BILLING_READ,
    name: 'Read billing & invoices',
    module: 'billing',
  },
  {
    slug: PERMISSION.BILLING_MANAGE,
    name: 'Manage billing & invoices',
    module: 'billing',
  },
  { slug: PERMISSION.USAGE_READ, name: 'Read usage stats', module: 'billing' },
  {
    slug: PERMISSION.FEATUREFLAG_READ,
    name: 'Read feature flags',
    module: 'billing',
  },
  {
    slug: PERMISSION.FEATUREFLAG_MANAGE,
    name: 'Manage feature flags',
    module: 'billing',
  },
  {
    slug: PERMISSION.BILLING_UPGRADE_READ,
    name: 'Read billing upgrade requests',
    module: 'billing',
  },
  {
    slug: PERMISSION.BILLING_UPGRADE_MANAGE,
    name: 'Create / accept / cancel billing upgrade requests',
    module: 'billing',
  },

  {
    slug: PERMISSION.NOTIFICATIONS_READ,
    name: 'Read notifications',
    module: 'notifications',
  },
  {
    slug: PERMISSION.NOTIFICATIONS_MANAGE,
    name: 'Manage notifications',
    module: 'notifications',
  },
  {
    slug: PERMISSION.NOTIFICATION_TEMPLATES_READ,
    name: 'Read notification templates',
    module: 'notifications',
  },
  {
    slug: PERMISSION.NOTIFICATION_TEMPLATES_MANAGE,
    name: 'Manage notification templates',
    module: 'notifications',
  },
  {
    slug: PERMISSION.NOTIFICATION_RULES_READ,
    name: 'Read notification rules',
    module: 'notifications',
  },
  {
    slug: PERMISSION.NOTIFICATION_RULES_MANAGE,
    name: 'Manage notification rules',
    module: 'notifications',
  },

  {
    slug: PERMISSION.CAMPAIGNS_READ,
    name: 'Read campaigns',
    module: 'campaigns',
  },
  {
    slug: PERMISSION.CAMPAIGNS_MANAGE,
    name: 'Manage campaigns',
    module: 'campaigns',
  },
  {
    slug: PERMISSION.CAMPAIGN_RECIPIENTS_READ,
    name: 'Read campaign recipients',
    module: 'campaigns',
  },
  {
    slug: PERMISSION.CAMPAIGN_RECIPIENTS_MANAGE,
    name: 'Manage campaign recipients',
    module: 'campaigns',
  },
  {
    slug: PERMISSION.CAMPAIGN_ANALYTICS_READ,
    name: 'Read campaign analytics',
    module: 'campaigns',
  },

  {
    slug: PERMISSION.PLATFORM_API_KEYS_READ,
    name: 'Read API keys',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_API_KEYS_MANAGE,
    name: 'Manage API keys',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_API_LOGS_READ,
    name: 'Read API logs',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_WEBHOOKS_READ,
    name: 'Read webhook logs',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_WEBHOOKS_MANAGE,
    name: 'Manage webhook logs',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_READ,
    name: 'Read outbound webhooks',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE,
    name: 'Manage outbound webhooks',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_INTEGRATIONS_READ,
    name: 'Read integration connections',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_INTEGRATIONS_MANAGE,
    name: 'Manage integration connections',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_FILES_READ,
    name: 'Read file uploads',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_FILES_MANAGE,
    name: 'Manage file uploads',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_SETTINGS_READ,
    name: 'Read system settings',
    module: 'platform',
  },
  {
    slug: PERMISSION.PLATFORM_SETTINGS_MANAGE,
    name: 'Manage system settings',
    module: 'platform',
  },

  { slug: PERMISSION.USERS_MANAGE, name: 'Manage users', module: 'admin' },
  { slug: PERMISSION.ROLES_MANAGE, name: 'Manage roles', module: 'admin' },
  { slug: PERMISSION.TENANTS_MANAGE, name: 'Manage tenants', module: 'admin' },

  {
    slug: PERMISSION.BRANCHES_CREATE,
    name: 'Create branches',
    module: 'branches',
  },
  {
    slug: PERMISSION.BRANCHES_UPDATE,
    name: 'Update branches',
    module: 'branches',
  },
  {
    slug: PERMISSION.BRANCHES_UPDATE_OWN,
    name: 'Update own assigned branch',
    module: 'branches',
  },
  {
    slug: PERMISSION.BRANCHES_DELETE,
    name: 'Delete branches',
    module: 'branches',
  },
];

export const ROLES: RoleDef[] = [
  {
    slug: ROLE.SUPER_ADMIN,
    name: 'Super Admin',
    description: 'Platform operator. Full control across all tenants.',
  },
  {
    slug: ROLE.OWNER,
    name: 'Clinic Owner',
    description: 'Owns the clinic (tenant). Runs the business end-to-end.',
  },
  {
    slug: ROLE.MANAGER,
    name: 'Operations Manager',
    description: 'Supervises staff, appointments and customers for the clinic.',
  },
  {
    slug: ROLE.RECEPTIONIST,
    name: 'Receptionist',
    description:
      'Front desk. Handles bookings, customers and WhatsApp replies.',
  },
  {
    slug: ROLE.DOCTOR,
    name: 'Doctor',
    description:
      'Clinical staff who treat customers. Manages own appointments and schedule.',
  },
  {
    slug: ROLE.CUSTOMER,
    name: 'Customer',
    description: 'End user who books appointments and manages their profile.',
  },
  {
    slug: ROLE.PLATFORM_SUPPORT,
    name: 'Platform Customer Service',
    description:
      'ZiyaraTech support employee. Triages clinic support tickets across tenants. Cannot close tickets or access Super Admin functionality.',
  },
];

// ---------------------------------------------------------------------------
// Role → permission mapping (strict; the seeder reconciles to exactly this)
// ---------------------------------------------------------------------------

/** Sentinel meaning "every permission in the catalogue" (resolved dynamically). */
export const ALL_PERMISSIONS = '*' as const;

/**
 * The AI Bot Actor's permission set — intentionally minimal (least privilege):
 * only what its tool calls actually need (booking + the customer lookup that
 * resolves a WhatsApp contact to a bookable person). No financial, AI-config,
 * staff, or analytics permissions. Shared by `ROLE_PERMISSIONS` (below, for
 * type completeness) and `WhatsappBotActorService` (the actual grant), so
 * both always agree.
 */
export const AI_BOT_PERMISSIONS: PermissionSlug[] = [
  PERMISSION.APPOINTMENTS_CREATE,
  PERMISSION.APPOINTMENTS_READ,
  PERMISSION.APPOINTMENTS_RESCHEDULE,
  PERMISSION.APPOINTMENTS_CANCEL,
  PERMISSION.SCHEDULING_AVAILABILITY_READ,
  PERMISSION.CUSTOMERS_READ,
  PERMISSION.CUSTOMERS_CREATE,
];

export const ROLE_PERMISSIONS: Record<
  RoleSlug,
  PermissionSlug[] | typeof ALL_PERMISSIONS
> = {
  // Platform operator: everything, resolved dynamically from the catalogue.
  [ROLE.SUPER_ADMIN]: ALL_PERMISSIONS,

  // Clinic owner: full clinic control, excluding platform internals
  // (tenants.manage) and end-user self-service (ABAC) scopes.
  [ROLE.OWNER]: [
    PERMISSION.DASHBOARD_ACCESS,
    PERMISSION.APPOINTMENTS_CREATE,
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_RESCHEDULE,
    PERMISSION.APPOINTMENTS_CANCEL,
    PERMISSION.APPOINTMENTS_MANAGE_ALL,
    PERMISSION.REVIEWS_READ,
    PERMISSION.REVIEWS_MANAGE,
    PERMISSION.CUSTOMERS_CREATE,
    PERMISSION.CUSTOMERS_READ,
    PERMISSION.CUSTOMERS_UPDATE,
    PERMISSION.CUSTOMERS_MANAGE,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.CRM_CUSTOMERS_MANAGE,
    // T105 (spec 014, US6, FR-H010b) — one privacy boundary for both the new
    // structured clinical entries and CustomerProfile's clinical fields.
    PERMISSION.CLINICAL_RECORDS_READ,
    PERMISSION.CLINICAL_RECORDS_MANAGE,
    PERMISSION.CRM_NOTES_READ,
    PERMISSION.CRM_NOTES_MANAGE,
    PERMISSION.CRM_TAGS_READ,
    PERMISSION.CRM_TAGS_MANAGE,
    PERMISSION.CRM_FILES_READ,
    PERMISSION.CRM_FILES_MANAGE,
    PERMISSION.SUPPORT_TICKETS_READ,
    PERMISSION.SUPPORT_TICKETS_CREATE,
    PERMISSION.SUPPORT_TICKETS_CLOSE,
    PERMISSION.SUPPORT_TICKETS_REPLY,
    PERMISSION.SUPPORT_TICKETS_REOPEN,
    PERMISSION.SERVICES_CREATE,
    PERMISSION.SERVICES_READ,
    PERMISSION.SERVICES_UPDATE,
    PERMISSION.SERVICES_DELETE,
    PERMISSION.STAFF_CREATE,
    PERMISSION.STAFF_READ,
    PERMISSION.STAFF_UPDATE,
    PERMISSION.STAFF_MANAGE,
    PERMISSION.STAFF_SCHEDULE_MANAGE,
    PERMISSION.STAFF_TIMEOFF_MANAGE,
    PERMISSION.STAFF_COMMISSION_READ,
    PERMISSION.STAFF_RATING_READ,
    PERMISSION.SCHEDULING_SLOTS_READ,
    PERMISSION.SCHEDULING_SLOTS_MANAGE,
    PERMISSION.SCHEDULING_BLOCKED_READ,
    PERMISSION.SCHEDULING_BLOCKED_MANAGE,
    PERMISSION.SCHEDULING_HOLIDAYS_READ,
    PERMISSION.SCHEDULING_HOLIDAYS_MANAGE,
    PERMISSION.SCHEDULING_AVAILABILITY_READ,
    PERMISSION.PAYMENTS_READ,
    PERMISSION.PAYMENTS_MANAGE,
    PERMISSION.REFUNDS_MANAGE,
    PERMISSION.INVOICES_READ,
    PERMISSION.INVOICES_MANAGE,
    PERMISSION.SETTLEMENTS_READ,
    PERMISSION.SETTLEMENTS_MANAGE,
    PERMISSION.REPORTS_READ,
    PERMISSION.REPORTS_EXPORT,
    PERMISSION.ANALYTICS_EVENTS_READ,
    PERMISSION.ANALYTICS_EVENTS_MANAGE,
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
    PERMISSION.ANALYTICS_REPORTS_MANAGE,
    PERMISSION.WHATSAPP_SEND,
    PERMISSION.WHATSAPP_ACCOUNTS_READ,
    PERMISSION.WHATSAPP_ACCOUNTS_MANAGE,
    PERMISSION.WHATSAPP_TEMPLATES_READ,
    PERMISSION.WHATSAPP_TEMPLATES_MANAGE,
    PERMISSION.WHATSAPP_CONTACTS_READ,
    PERMISSION.WHATSAPP_CONTACTS_MANAGE,
    PERMISSION.WHATSAPP_WEBHOOKS_MANAGE,
    PERMISSION.WHATSAPP_ANALYTICS_READ,
    PERMISSION.CONVERSATIONS_READ,
    PERMISSION.CONVERSATIONS_MANAGE,
    PERMISSION.MESSAGES_SEND,
    PERMISSION.MESSAGES_READ,
    PERMISSION.PARTICIPANTS_MANAGE,
    PERMISSION.ATTACHMENTS_MANAGE,
    PERMISSION.CONVERSATION_ANALYTICS_READ,
    PERMISSION.AI_CHAT,
    PERMISSION.AI_MANAGE,
    PERMISSION.AI_AGENTS_READ,
    PERMISSION.AI_AGENTS_MANAGE,
    PERMISSION.AI_KNOWLEDGE_READ,
    PERMISSION.AI_KNOWLEDGE_MANAGE,
    PERMISSION.AI_TRAINING_READ,
    PERMISSION.AI_TRAINING_MANAGE,
    PERMISSION.AI_PROMPTS_READ,
    PERMISSION.AI_PROMPTS_MANAGE,
    PERMISSION.AI_CONVERSATIONS_READ,
    PERMISSION.AI_CONVERSATIONS_MANAGE,
    PERMISSION.AI_HANDOVER_READ,
    PERMISSION.AI_HANDOVER_MANAGE,
    PERMISSION.AI_ANALYTICS_READ,
    PERMISSION.SUBSCRIPTION_READ,
    PERMISSION.SUBSCRIPTION_MANAGE,
    PERMISSION.BILLING_READ,
    PERMISSION.BILLING_MANAGE,
    PERMISSION.USAGE_READ,
    PERMISSION.FEATUREFLAG_READ,
    PERMISSION.BILLING_UPGRADE_READ,
    PERMISSION.BILLING_UPGRADE_MANAGE,
    PERMISSION.NOTIFICATIONS_READ,
    PERMISSION.NOTIFICATIONS_MANAGE,
    PERMISSION.NOTIFICATION_TEMPLATES_READ,
    PERMISSION.NOTIFICATION_TEMPLATES_MANAGE,
    PERMISSION.NOTIFICATION_RULES_READ,
    PERMISSION.NOTIFICATION_RULES_MANAGE,
    PERMISSION.CAMPAIGNS_READ,
    PERMISSION.CAMPAIGNS_MANAGE,
    PERMISSION.CAMPAIGN_RECIPIENTS_READ,
    PERMISSION.CAMPAIGN_RECIPIENTS_MANAGE,
    PERMISSION.CAMPAIGN_ANALYTICS_READ,
    PERMISSION.USERS_MANAGE,
    PERMISSION.ROLES_MANAGE,
    PERMISSION.PLATFORM_API_KEYS_READ,
    PERMISSION.PLATFORM_API_KEYS_MANAGE,
    PERMISSION.PLATFORM_API_LOGS_READ,
    PERMISSION.PLATFORM_WEBHOOKS_READ,
    PERMISSION.PLATFORM_WEBHOOKS_MANAGE,
    PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_READ,
    PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE,
    PERMISSION.PLATFORM_INTEGRATIONS_READ,
    PERMISSION.PLATFORM_INTEGRATIONS_MANAGE,
    PERMISSION.PLATFORM_FILES_READ,
    PERMISSION.PLATFORM_FILES_MANAGE,
    PERMISSION.BRANCHES_CREATE,
    PERMISSION.BRANCHES_UPDATE,
    PERMISSION.BRANCHES_DELETE,
  ],

  // Operations manager: appointments + customers + staff + reports.
  // No payment/refund access at all (reporting is its own domain now).
  [ROLE.MANAGER]: [
    PERMISSION.DASHBOARD_ACCESS,
    PERMISSION.APPOINTMENTS_CREATE,
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_RESCHEDULE,
    PERMISSION.APPOINTMENTS_CANCEL,
    PERMISSION.APPOINTMENTS_MANAGE_ALL,
    PERMISSION.REVIEWS_READ,
    PERMISSION.REVIEWS_MANAGE,
    PERMISSION.CUSTOMERS_CREATE,
    PERMISSION.CUSTOMERS_READ,
    PERMISSION.CUSTOMERS_UPDATE,
    PERMISSION.CUSTOMERS_MANAGE,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.CRM_CUSTOMERS_MANAGE,
    // T105 (spec 014, US6, FR-H010b) — one privacy boundary for both the new
    // structured clinical entries and CustomerProfile's clinical fields.
    PERMISSION.CLINICAL_RECORDS_READ,
    PERMISSION.CLINICAL_RECORDS_MANAGE,
    PERMISSION.CRM_NOTES_READ,
    PERMISSION.CRM_NOTES_MANAGE,
    PERMISSION.CRM_TAGS_READ,
    PERMISSION.CRM_TAGS_MANAGE,
    PERMISSION.CRM_FILES_READ,
    PERMISSION.CRM_FILES_MANAGE,
    PERMISSION.SUPPORT_TICKETS_READ,
    PERMISSION.SUPPORT_TICKETS_CREATE,
    PERMISSION.SUPPORT_TICKETS_CLOSE,
    PERMISSION.SUPPORT_TICKETS_REPLY,
    PERMISSION.SUPPORT_TICKETS_REOPEN,
    PERMISSION.SERVICES_CREATE,
    PERMISSION.SERVICES_READ,
    PERMISSION.SERVICES_UPDATE,
    PERMISSION.STAFF_CREATE,
    PERMISSION.STAFF_READ,
    PERMISSION.STAFF_UPDATE,
    PERMISSION.STAFF_MANAGE,
    PERMISSION.STAFF_SCHEDULE_MANAGE,
    PERMISSION.STAFF_TIMEOFF_MANAGE,
    PERMISSION.STAFF_COMMISSION_READ,
    PERMISSION.STAFF_RATING_READ,
    PERMISSION.SCHEDULING_SLOTS_READ,
    PERMISSION.SCHEDULING_SLOTS_MANAGE,
    PERMISSION.SCHEDULING_BLOCKED_READ,
    PERMISSION.SCHEDULING_BLOCKED_MANAGE,
    PERMISSION.SCHEDULING_HOLIDAYS_READ,
    PERMISSION.SCHEDULING_HOLIDAYS_MANAGE,
    PERMISSION.SCHEDULING_AVAILABILITY_READ,
    PERMISSION.SUBSCRIPTION_READ,
    PERMISSION.BILLING_READ,
    PERMISSION.USAGE_READ,
    PERMISSION.FEATUREFLAG_READ,
    PERMISSION.BILLING_UPGRADE_READ,
    PERMISSION.NOTIFICATIONS_READ,
    PERMISSION.NOTIFICATIONS_MANAGE,
    PERMISSION.NOTIFICATION_TEMPLATES_READ,
    PERMISSION.NOTIFICATION_TEMPLATES_MANAGE,
    PERMISSION.NOTIFICATION_RULES_READ,
    PERMISSION.NOTIFICATION_RULES_MANAGE,
    PERMISSION.CAMPAIGNS_READ,
    PERMISSION.CAMPAIGNS_MANAGE,
    PERMISSION.CAMPAIGN_RECIPIENTS_READ,
    PERMISSION.CAMPAIGN_RECIPIENTS_MANAGE,
    PERMISSION.CAMPAIGN_ANALYTICS_READ,
    PERMISSION.WHATSAPP_SEND,
    PERMISSION.WHATSAPP_ACCOUNTS_READ,
    PERMISSION.WHATSAPP_ACCOUNTS_MANAGE,
    PERMISSION.WHATSAPP_TEMPLATES_READ,
    PERMISSION.WHATSAPP_TEMPLATES_MANAGE,
    PERMISSION.WHATSAPP_CONTACTS_READ,
    PERMISSION.WHATSAPP_CONTACTS_MANAGE,
    PERMISSION.WHATSAPP_WEBHOOKS_MANAGE,
    PERMISSION.WHATSAPP_ANALYTICS_READ,
    PERMISSION.CONVERSATIONS_READ,
    PERMISSION.CONVERSATIONS_MANAGE,
    PERMISSION.MESSAGES_SEND,
    PERMISSION.MESSAGES_READ,
    PERMISSION.PARTICIPANTS_MANAGE,
    PERMISSION.ATTACHMENTS_MANAGE,
    PERMISSION.CONVERSATION_ANALYTICS_READ,
    PERMISSION.AI_CHAT,
    PERMISSION.AI_MANAGE,
    PERMISSION.AI_AGENTS_READ,
    PERMISSION.AI_AGENTS_MANAGE,
    PERMISSION.AI_KNOWLEDGE_READ,
    PERMISSION.AI_KNOWLEDGE_MANAGE,
    PERMISSION.AI_TRAINING_READ,
    PERMISSION.AI_TRAINING_MANAGE,
    PERMISSION.AI_PROMPTS_READ,
    PERMISSION.AI_PROMPTS_MANAGE,
    PERMISSION.AI_CONVERSATIONS_READ,
    PERMISSION.AI_CONVERSATIONS_MANAGE,
    PERMISSION.AI_HANDOVER_READ,
    PERMISSION.AI_HANDOVER_MANAGE,
    PERMISSION.AI_ANALYTICS_READ,
    PERMISSION.REPORTS_READ,
    PERMISSION.ANALYTICS_EVENTS_READ,
    PERMISSION.ANALYTICS_EVENTS_MANAGE,
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
    PERMISSION.ANALYTICS_REPORTS_MANAGE,
    PERMISSION.PLATFORM_API_LOGS_READ,
    PERMISSION.PLATFORM_WEBHOOKS_READ,
    PERMISSION.PLATFORM_FILES_READ,
    PERMISSION.PLATFORM_FILES_MANAGE,
    PERMISSION.BRANCHES_CREATE,
    PERMISSION.BRANCHES_UPDATE,
  ],

  // Front desk: books appointments, manages customer records, WhatsApp replies.
  [ROLE.RECEPTIONIST]: [
    PERMISSION.DASHBOARD_ACCESS,
    PERMISSION.APPOINTMENTS_CREATE,
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_UPDATE,
    PERMISSION.APPOINTMENTS_RESCHEDULE,
    PERMISSION.APPOINTMENTS_CANCEL,
    PERMISSION.REVIEWS_READ,
    PERMISSION.CUSTOMERS_CREATE,
    PERMISSION.CUSTOMERS_READ,
    PERMISSION.CUSTOMERS_UPDATE,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.CRM_CUSTOMERS_MANAGE,
    PERMISSION.CRM_NOTES_READ,
    PERMISSION.CRM_NOTES_MANAGE,
    PERMISSION.CRM_TAGS_READ,
    PERMISSION.CRM_FILES_READ,
    PERMISSION.CRM_FILES_MANAGE,
    PERMISSION.SUPPORT_TICKETS_READ,
    PERMISSION.SUPPORT_TICKETS_CREATE,
    PERMISSION.SUPPORT_TICKETS_CLOSE,
    PERMISSION.SUPPORT_TICKETS_REPLY,
    PERMISSION.SUPPORT_TICKETS_REOPEN,
    PERMISSION.SERVICES_READ,
    PERMISSION.STAFF_READ,
    PERMISSION.SCHEDULING_SLOTS_READ,
    PERMISSION.SCHEDULING_BLOCKED_READ,
    PERMISSION.SCHEDULING_HOLIDAYS_READ,
    PERMISSION.SCHEDULING_AVAILABILITY_READ,
    PERMISSION.NOTIFICATIONS_READ,
    PERMISSION.NOTIFICATION_TEMPLATES_READ,
    PERMISSION.CAMPAIGNS_READ,
    PERMISSION.CAMPAIGN_RECIPIENTS_READ,
    PERMISSION.CAMPAIGN_ANALYTICS_READ,
    PERMISSION.WHATSAPP_SEND,
    PERMISSION.WHATSAPP_ACCOUNTS_READ,
    PERMISSION.WHATSAPP_TEMPLATES_READ,
    PERMISSION.WHATSAPP_CONTACTS_READ,
    PERMISSION.WHATSAPP_CONTACTS_MANAGE,
    PERMISSION.WHATSAPP_ANALYTICS_READ,
    PERMISSION.CONVERSATIONS_READ,
    PERMISSION.CONVERSATIONS_MANAGE,
    PERMISSION.MESSAGES_SEND,
    PERMISSION.MESSAGES_READ,
    PERMISSION.PARTICIPANTS_MANAGE,
    PERMISSION.ATTACHMENTS_MANAGE,
    PERMISSION.CONVERSATION_ANALYTICS_READ,
    PERMISSION.AI_CONVERSATIONS_READ,
    PERMISSION.AI_HANDOVER_READ,
    PERMISSION.AI_HANDOVER_MANAGE,
  ],

  // Clinical staff — deliberately minimal (least privilege), reviewed against
  // the actual clinic modules rather than assumed:
  //
  //   - DASHBOARD_ACCESS: reach the workspace shell at all.
  //   - APPOINTMENTS_READ_OWN: an ABAC/ownership-scoped permission (see
  //     OWNERSHIP_SCOPED_PERMISSIONS above) — NOT the tenant-wide
  //     APPOINTMENTS_READ. AppointmentsService enforces the "own" scope
  //     server-side (filters by the caller's own StaffProfile via
  //     `appointment.staff.id`), so a doctor can list/view only appointments
  //     assigned to them, including the notes/timeline sub-resources.
  //   - CRM_CUSTOMERS_READ (T105, spec 014, US6, FR-H010c) — a DELIBERATE
  //     REVERSAL of this block's own prior reasoning below, made explicitly
  //     by the spec: without it a doctor cannot open ANY patient record at
  //     all, so the entire clinical-records capability (the reason this role
  //     exists) would be unreachable. The tenant-wide browsing risk the
  //     original comment warned about is now the accepted tradeoff, made
  //     safe by two things the original reasoning didn't have available:
  //     `clinical.records.read` gates the actually-sensitive content (not
  //     this read), and FR-H011 records every clinical read to
  //     `clinical_access_logs` — so browsing IS possible but is no longer
  //     unaccountable. CRM_CUSTOMERS_MANAGE is still NOT granted.
  //   - CLINICAL_RECORDS_READ / CLINICAL_RECORDS_MANAGE (T105, FR-H010b) —
  //     the actual clinical-content boundary: structured entries and
  //     CustomerProfile's clinical fields, one gate for both (FR-H010a).
  //
  // Still explicitly NOT granted: appointments.create/update/reschedule/cancel
  // (status/lifecycle changes), crm.customers.manage, crm.notes.*, crm.tags.*,
  // crm.files.*, staff.* (including own-schedule viewing — no ownership-scoped
  // variant exists yet), services.read, notifications.read, ai.chat,
  // reviews.read. Add only once there is a real ownership-scoped enforcement
  // path for each, mirroring APPOINTMENTS_READ_OWN.
  [ROLE.DOCTOR]: [
    PERMISSION.DASHBOARD_ACCESS,
    PERMISSION.APPOINTMENTS_READ_OWN,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.CLINICAL_RECORDS_READ,
    PERMISSION.CLINICAL_RECORDS_MANAGE,
  ],

  // End user: self-service only (ownership enforced in the service layer).
  [ROLE.CUSTOMER]: [
    PERMISSION.APPOINTMENTS_CREATE,
    PERMISSION.APPOINTMENTS_READ_OWN,
    PERMISSION.REVIEWS_CREATE,
    PERMISSION.PROFILE_UPDATE_OWN,
  ],

  // AI Bot Actor: least-privilege, booking-only (see AI_BOT_PERMISSIONS below).
  // Not a global system role — created per-tenant, lazily, by
  // WhatsappBotActorService via RolesService.create(); the role-permissions
  // seeder only reconciles GLOBAL (tenant-less) roles, so it harmlessly skips
  // this entry (it exists only to satisfy the exhaustive `RoleSlug` mapping).
  [ROLE.AI_BOT]: AI_BOT_PERMISSIONS,

  // Platform Customer Service: cross-tenant support-ticket triage, plus the
  // read-only Support Operations Console diagnostics needed to work out WHY a
  // clinic's problem happened, plus three proven-safe recovery actions.
  //
  // Deliberately excludes PLATFORM_SUPPORT_TICKETS_CLOSE (only super_admin
  // holds it, via the '*' wildcard) and DASHBOARD_ACCESS (this role must
  // never reach the clinic workspace shell). Also excludes the tenant-scoped
  // SUPPORT_TICKETS_REPLY/REOPEN — those are separate permissions on separate
  // (clinic-side) controllers.
  //
  // What this role STILL cannot do, by construction — there is no slug here
  // for any of it: change subscriptions/plans/pricing/usage, toggle feature
  // flags, approve or suspend a clinic, refund or modify a payment, modify an
  // appointment or a patient, read medical data, read AI costs, read secrets,
  // manage RBAC, manage platform staff, or change platform configuration.
  [ROLE.PLATFORM_SUPPORT]: [
    PERMISSION.PLATFORM_SUPPORT_TICKETS_READ,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE,
    PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY,
    ...PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS,
  ],
};
