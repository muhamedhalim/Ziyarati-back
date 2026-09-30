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
  /**
   * Nurse role — the queue/status-lifecycle slice of `appointments.update`,
   * carved out on purpose: `appointments.update` ALSO covers reassigning the
   * staff member/branch (`PATCH /appointments/:id`) and replacing services
   * (`PUT /appointments/:id/services`), neither of which a nurse may do.
   * Admits `POST /appointments/:id/status` and the queue actions
   * (check-in/call/start/complete/skip/recall/no-show) via
   * `@RequireAnyPermission(APPOINTMENTS_UPDATE, APPOINTMENTS_STATUS_UPDATE)`
   * — never alone; `appointments.update` still satisfies the same routes so
   * every existing role's behaviour is unchanged. Delegable (not reserved):
   * it grants no doctor/branch/service reassignment and no financial reach.
   */
  APPOINTMENTS_STATUS_UPDATE: 'appointments.status.update',

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
  /**
   * Doctor role — edit the contact/demographic fields of a patient the holder
   * has an appointment with, and only those. A DELIBERATELY NARROWER write
   * than `CRM_CUSTOMERS_MANAGE` (which also creates, deletes, imports and
   * manages addresses/segments for the whole clinic). ABAC — see
   * OWNERSHIP_SCOPED_PERMISSIONS: a bare guard check is NOT sufficient, the
   * service verifies the appointment relationship
   * (`StaffScopeService.hasAppointmentWithCustomer`) and a field allow-list
   * (`CustomerService.updateOwnPatient`). Admits `PATCH /crm/customers/:id`
   * and `PUT /crm/customers/:id/profile` via
   * `@RequireAnyPermission(CRM_CUSTOMERS_MANAGE, CRM_CUSTOMERS_UPDATE_OWN)`.
   */
  CRM_CUSTOMERS_UPDATE_OWN: 'crm.customers.update_own',
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
  STAFF_READ_OWN: 'staff.read_own', // ABAC — see OWNERSHIP_SCOPED_PERMISSIONS
  STAFF_UPDATE: 'staff.update',
  STAFF_MANAGE: 'staff.manage',
  STAFF_SCHEDULE_MANAGE: 'staff.schedule.manage',
  /**
   * Read-only view of a branch's operating hours (`GET /working-hours`). The
   * read counterpart of `staff.schedule.manage`, carved out so a doctor can
   * open the Branches working-hours dialog WITHOUT `staff.read` (tenant-wide
   * staff browsing). Admits the route via
   * `@RequireAnyPermission(STAFF_READ, STAFF_SCHEDULE_READ)` — every role that
   * already holds `staff.read` is unaffected.
   */
  STAFF_SCHEDULE_READ: 'staff.schedule.read',
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
  /**
   * Nurse role — a DELIBERATELY NARROWER write scope than
   * `CLINICAL_RECORDS_MANAGE`. Granted alongside `CLINICAL_RECORDS_READ`
   * (never alone), it lets the holder create NOTE/VITALS entries and
   * encounters, and correct only their OWN NOTE/VITALS entries — never
   * DIAGNOSIS/MEDICATION/ALLERGY, never another author's entry, never a
   * delete. Enforced in `ClinicalRecordService` (kind + author checks), not
   * by the guard alone — see its docblock. ABAC-flavoured (ownership-scoped
   * on correction) — see OWNERSHIP_SCOPED_PERMISSIONS below. Reserved (see
   * RESERVED_PERMISSION_SLUGS) for the same reason CLINICAL_RECORDS_* is: an
   * Owner must never be able to delegate clinical write reach into an
   * arbitrary "Other" custom role.
   */
  CLINICAL_RECORDS_NURSING: 'clinical.records.nursing',

  // Accountability / activity log (activity-log module). Granted to `owner`
  // and `manager` only — see T192's migration and T193's enforcing
  // `ActivityLogController`.
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
    PERMISSION.STAFF_READ_OWN,
    // Nurse's clinical write permission is ownership-scoped on CORRECTION
    // only (create is kind-scoped, not author-scoped) — see its own
    // docblock above and ClinicalRecordService's enforcement.
    PERMISSION.CLINICAL_RECORDS_NURSING,
    // Doctor's patient-edit permission is ownership-scoped on the PATIENT
    // (an appointment with the caller's own StaffProfile) — see its own
    // docblock above and CustomerService.updateOwnPatient's enforcement.
    PERMISSION.CRM_CUSTOMERS_UPDATE_OWN,
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
    // audit.read's enforcing `ActivityLogController` landed in T193 — removed
    // here for the same reason (was declared in T003 as a known, documented
    // gap pending exactly this controller).
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
  // Nurse role — same rationale as the pair above: a narrower clinical WRITE
  // capability is still clinical write capability, and must never become
  // delegable into an arbitrary "Other" custom role just because a caller
  // (e.g. Owner, via `clinical.records.manage`) happens to hold it.
  PERMISSION.CLINICAL_RECORDS_NURSING,
]);

// ---------------------------------------------------------------------------
// Roles (snake_case slugs)
// ---------------------------------------------------------------------------

export const ROLE = {
  SUPER_ADMIN: 'super_admin',
  OWNER: 'owner',
  MANAGER: 'manager',
  /**
   * Runs ONE branch (location) of a multi-branch clinic. Operationally close
   * to `manager`, with two deliberate differences:
   *
   *  1. It holds `branches.update_own` INSTEAD of the tenant-wide
   *     `branches.update`. That pair is not decoration — it is the machine-
   *     readable definition of "this role is branch-restricted" (see
   *     {@link isBranchRestricted}), and therefore what makes every
   *     branch-scoped read/write on the backend narrow for this role and stay
   *     tenant-wide for `owner`/`manager`.
   *  2. It holds no financial, subscription/billing, clinic-configuration,
   *     staff-provisioning, AI-configuration or tenant-wide analytics slug —
   *     those are clinic-level concerns, not branch-level ones.
   *
   * Deliberately NOT granted `analytics.dashboard.read` (the tenant-wide
   * analytics scope FR-A016 keys on) nor `analytics.reports.read`: the daily-
   * report list endpoint is still tenant-wide, so granting the latter would
   * leak other branches' rows. See the note on ROLE_PERMISSIONS below.
   */
  BRANCH_MANAGER: 'branch_manager',
  RECEPTIONIST: 'receptionist',
  DOCTOR: 'doctor',
  /**
   * Clinic-wide (not branch-restricted), like `doctor`/`receptionist`. Reads
   * patients, appointments and the clinical timeline; runs queue/status
   * actions (`appointments.status.update`, never the tenant-wide
   * `appointments.update`); writes only NOTE/VITALS clinical entries and
   * corrects only their own (`clinical.records.nursing`, never `.manage`).
   * Never a bookable provider — see {@link PUBLIC_BOOKING_EXCLUDED_ROLES}.
   * No finance, staff, roles, users, settings, services or branch slug.
   */
  NURSE: 'nurse',
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
  /**
   * Platform-level system role (tenant = NULL, is_system = true) for a ZiyaraTech
   * field-sales employee. Holds NO permissions: every `/platform/sales/**` route
   * is Super Admin role-gated, so this role only classifies the account (it is
   * what `SalesEmployeeService.requireEmployee` verifies before a clinic can be
   * assigned to a user). Never assigned to a tenant user (see
   * NON_STAFF_ROLE_SLUGS and API_PROTECTED_ROLE_SLUGS in roles.service.ts).
   */
  PLATFORM_SALES: 'platform_sales',
} as const;

export type RoleSlug = (typeof ROLE)[keyof typeof ROLE];

/**
 * Roles whose staff may be chosen as the "Employee" of a NEW appointment made
 * from the clinic dashboard — doctors and the manager. Receptionists (and every
 * other role) run the front desk; they are not bookable as the provider.
 *
 * Single source of truth for BOTH halves of the rule: the `bookable` filter on
 * `GET /staff` (what the picker offers) and the create-time check in
 * `AppointmentService.create` (what the API accepts), so the two can never
 * drift. Existing appointments are never re-validated against it.
 */
export const APPOINTMENT_BOOKABLE_STAFF_ROLES: readonly RoleSlug[] = [
  ROLE.DOCTOR,
  ROLE.MANAGER,
];

/**
 * Roles that must NEVER be publicly listed as a bookable provider —
 * distinct from {@link APPOINTMENT_BOOKABLE_STAFF_ROLES} above, which is an
 * ALLOW-list for the dashboard "Employee" picker (doctor + manager only).
 * This is a narrower DENY-list consulted only when a staff profile's
 * `is_available_for_booking` flag is being SET to `true` — see
 * `StaffService.resolveBookableFlag` — so it forces the flag back to
 * `false` for a role that must stay off the public/AI-booking surfaces
 * (`public-discovery`, `public-booking-context`, `availability.service`,
 * `scheduling-ref.service`), all of which key on that flag alone rather
 * than on role.
 *
 * Deliberately NOT "every role outside `APPOINTMENT_BOOKABLE_STAFF_ROLES`":
 * `receptionist` and a tenant custom role have never been excluded by role
 * (only by the flag's own default), and changing that today would be an
 * unrelated behavior change. This list only ever grows by an explicit,
 * reviewed decision — currently just the role this predicate exists for.
 */
export const PUBLIC_BOOKING_EXCLUDED_ROLES: readonly RoleSlug[] = [
  ROLE.NURSE,
];

/**
 * THE definition of "this principal may only see/act on its own branch(es)".
 *
 * Expressed as a PERMISSION predicate, never a role allow-list, so it holds
 * for `branch_manager` AND for any tenant "Other" custom role delegated
 * `branches.update_own` — without either one being named here.
 *
 * The rule reuses the ABAC pair FND-017 already established for
 * `BranchService.update`: `branches.update` is the tenant-wide capability,
 * `branches.update_own` the branch-restricted one. A principal holding the
 * tenant-wide slug (owner, manager) is never restricted; a principal holding
 * NEITHER (receptionist, doctor, ai-bot, patients, system/worker callers with
 * no principal at all) is likewise never restricted — which is what keeps
 * this change backward compatible for every role that exists today.
 *
 * Consumed by `BranchScopeService` (the only place that turns this predicate
 * into an actual SQL narrowing) and mirrored — from the same permission data,
 * not a copy of this list — by the staff Permission Preview, so "what the
 * preview shows" and "what the API enforces" cannot drift.
 */
export function isBranchRestricted(permissions: readonly string[]): boolean {
  return (
    permissions.includes(PERMISSION.BRANCHES_UPDATE_OWN) &&
    !permissions.includes(PERMISSION.BRANCHES_UPDATE)
  );
}

/**
 * THE definition of "this principal may only see/act on rows belonging to
 * its own StaffProfile" — the same ABAC pattern as {@link isBranchRestricted}
 * one level up, applied to the `appointments.read`/`appointments.read_own`
 * pair instead of the branch one.
 *
 * PRECONDITION: only meaningful on a route already admitted by
 * `@RequireAnyPermission(PERMISSION.APPOINTMENTS_READ,
 * PERMISSION.APPOINTMENTS_READ_OWN)` (or an equivalent ANY-of check). Fail-
 * closed by construction: anything that reached such a route WITHOUT the
 * tenant-wide slug is narrowed by definition — there is no third state.
 *
 * Expressed as a PERMISSION predicate, never a role allow-list, so it holds
 * for `doctor` AND for any tenant "Other" custom role delegated
 * `appointments.read_own` alone — without either being named here. Consumed
 * by `AppointmentsService`, `DashboardSummaryService` and
 * `PatientQueueService`, all via `StaffScopeService.resolveOwnStaffId`
 * (`src/core/staff-scope`) — never a fourth hand-copied lookup.
 */
export function isScopedToOwnStaff(permissions: readonly string[]): boolean {
  return !permissions.includes(PERMISSION.APPOINTMENTS_READ);
}

/**
 * THE definition of "this principal may only DRIVE (queue actions, status
 * changes) appointments assigned to its own StaffProfile" — the WRITE-side
 * sibling of {@link isScopedToOwnStaff}.
 *
 * Deliberately NOT a reuse of {@link isScopedToOwnStaff}: that predicate's
 * precondition is admission by the appointment READ routes. The queue/status
 * write routes are admitted by `appointments.update` OR
 * `appointments.status.update` instead, so `!appointments.read` would newly
 * narrow any unrelated custom role that merely lacks the tenant-wide read.
 *
 * The rule: holds `appointments.status.update` (the carved-out slug that
 * admits the write routes without `appointments.update`) and NEITHER tenant-wide
 * slug. Fail-closed by construction — no third state:
 *   - doctor (`status.update` + `read_own`)              → scoped
 *   - nurse (`status.update` + tenant-wide `read`)        → NOT scoped (a
 *     nurse is never the assigned provider; unchanged)
 *   - owner/manager/branch_manager/receptionist (`update`) → NOT scoped
 *   - ai-bot, customer, worker jobs (no `status.update`)   → NOT scoped
 *
 * Consumed only through `StaffScopeService.assertMayDriveAppointment`, which
 * `AppointmentService.changeStatus` and `PatientQueueService` share — never a
 * hand-copied check.
 */
export function isStatusWriteScopedToOwnStaff(
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes(PERMISSION.APPOINTMENTS_STATUS_UPDATE) &&
    !permissions.includes(PERMISSION.APPOINTMENTS_UPDATE) &&
    !permissions.includes(PERMISSION.APPOINTMENTS_READ)
  );
}

/**
 * The only appointment statuses a caller for whom
 * {@link isStatusWriteScopedToOwnStaff} holds may set — the clinical
 * lifecycle a treating provider drives. Excludes `CONFIRMED` on purpose:
 * `changeStatus` never touches `payment_status`, so letting a provider
 * manually confirm a `PENDING_PAYMENT` booking would bypass payment
 * confirmation. Confirmation remains a front-desk/payment concern.
 * Stored as strings so this module stays free of an entity import.
 */
export const OWN_STAFF_SETTABLE_APPOINTMENT_STATUSES: readonly string[] = [
  'IN_PROGRESS',
  'COMPLETED',
  'NO_SHOW',
];

/**
 * Nurse role — whether a caller holding `appointments.read` (or `_read_own`)
 * may ALSO see an appointment's financial fields: `total_amount`,
 * `payment_status`, `currency`, `services[].price`,
 * `services[].service.base_price`/`pricing_type`, a cancellation's
 * `refundAmount`, and the queue view's `appointment.paymentStatus`.
 *
 * Deliberately a DERIVED predicate, not a new permission slug: every
 * existing role (owner, manager, branch_manager, receptionist, doctor)
 * already holds at least one of the four slugs below, so this changes
 * NOTHING for them — the redaction affects only a caller who reads
 * appointments without ever creating/updating/reading-own one or holding
 * `payments.read`, which today means exactly the Nurse role, and, as an
 * accepted side effect, any tenant "Other" custom role an Owner builds with
 * `appointments.read` alone (documented, not fixed — narrowing an existing
 * custom role's visibility is a product decision, not this predicate's to
 * make). Consumed only at controller RESPONSE boundaries (appointments
 * list/detail/timeline, the status-change response, the queue list and
 * every queue action response) — never inside `AppointmentService.findOne`
 * itself, which internal write paths (create/update/cancel/etc.) reuse and
 * must keep seeing the full row regardless of who is acting.
 */
export function canViewAppointmentFinancials(
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes(PERMISSION.APPOINTMENTS_CREATE) ||
    permissions.includes(PERMISSION.APPOINTMENTS_UPDATE) ||
    permissions.includes(PERMISSION.APPOINTMENTS_READ_OWN) ||
    permissions.includes(PERMISSION.PAYMENTS_READ)
  );
}

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
 *
 * `manager` ("Operations Manager") is retired from NEW staff assignment —
 * `branch_manager` is the role for managing a branch going forward. The
 * `manager` role definition, its permission grant, and any account that
 * already holds it are untouched; this only stops it being offered or
 * accepted for staff creation/update going forward.
 */
export const NON_STAFF_ROLE_SLUGS: readonly RoleSlug[] = [
  ROLE.SUPER_ADMIN,
  ROLE.OWNER,
  ROLE.CUSTOMER,
  ROLE.AI_BOT,
  // Platform-level role — never a clinic staff role. Belongs only to a
  // tenantId = NULL user, provisioned exclusively via /platform/staff.
  ROLE.PLATFORM_SUPPORT,
  ROLE.PLATFORM_SALES,
  // Retired from staff assignment in favor of branch_manager. See docblock.
  ROLE.MANAGER,
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
    slug: PERMISSION.APPOINTMENTS_STATUS_UPDATE,
    name: 'Update appointment queue status',
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
    slug: PERMISSION.CRM_CUSTOMERS_UPDATE_OWN,
    name: "Edit own patients' details",
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
    slug: PERMISSION.CLINICAL_RECORDS_NURSING,
    name: 'Record nursing notes & vitals',
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
  {
    slug: PERMISSION.STAFF_READ_OWN,
    name: 'Read own staff profile & schedule',
    module: 'staff',
  },
  { slug: PERMISSION.STAFF_UPDATE, name: 'Update staff', module: 'staff' },
  { slug: PERMISSION.STAFF_MANAGE, name: 'Manage staff', module: 'staff' },
  {
    slug: PERMISSION.STAFF_SCHEDULE_MANAGE,
    name: 'Manage staff schedules & working hours',
    module: 'staff',
  },
  {
    slug: PERMISSION.STAFF_SCHEDULE_READ,
    name: 'View branch working hours',
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

  {
    // T192 (spec 014, US14, FR-U009) — the clinic-facing accountability
    // surface. Granted only to `owner`/`manager` (see ROLE_PERMISSIONS below
    // and the migration that mirrors this in the database).
    slug: PERMISSION.AUDIT_READ,
    name: 'Read clinic activity log',
    module: 'activity_log',
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
    slug: ROLE.BRANCH_MANAGER,
    name: 'Branch Manager',
    description:
      'Runs one branch. Sees and manages only the branch(es) they are assigned to — appointments, queue, schedules, patients and the branch activity log. No clinic finances, billing, settings or staff provisioning.',
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
    slug: ROLE.NURSE,
    name: 'Nurse',
    description:
      'Clinical support staff. Views patients, appointments and the clinical record; records nursing notes and vitals; runs queue check-in and status updates. No diagnoses, prescriptions, finances, staff or settings.',
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
  {
    slug: ROLE.PLATFORM_SALES,
    name: 'Platform Sales',
    description:
      'ZiyaraTech field-sales employee. Owns a portfolio of clinics with monthly targets, managed by Super Admin. Holds no console permissions.',
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
    // T192 (spec 014, US14, FR-U009) — clinic ownership only, alongside
    // manager. Deliberately NOT granted to receptionist or doctor.
    PERMISSION.AUDIT_READ,
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
    // T192 (spec 014, US14, FR-U009) — clinic management, alongside owner.
    // Deliberately NOT granted to receptionist or doctor.
    PERMISSION.AUDIT_READ,
  ],

  /**
   * Branch manager: the operations manager's day-to-day surface, narrowed to
   * one location. Derived from `ROLE_PERMISSIONS[MANAGER]` by SUBTRACTION, so
   * this role can never quietly out-grant the role it is modelled on.
   *
   * Removed vs. MANAGER, and why:
   *   - `branches.create` / `branches.update`  → replaced by
   *     `branches.update_own`. This swap is what makes {@link
   *     isBranchRestricted} true for this role; it is load-bearing, not
   *     cosmetic.
   *   - `analytics.dashboard.read`             → the tenant-wide analytics
   *     scope (FR-A016). Holding it would defeat the branch narrowing
   *     `AdvancedAnalyticsService.resolveScope` already performs.
   *   - `analytics.reports.read` / `.manage`,
   *     `analytics.events.*`, `reports.read`   → `GET /analytics/reports/daily`
   *     is still TENANT-WIDE (one row per branch per day, no scope
   *     resolution). Granting the read would leak sibling branches' figures,
   *     so it stays out until that endpoint is branch-scoped too.
   *   - `staff.create` / `staff.update` / `staff.manage` → staff provisioning
   *     has no branch constraint on its write path, so granting it would let
   *     a branch manager create staff for another branch.
   *   - `staff.commission.read`                → compensation is clinic-level.
   *   - `services.create` / `.update`          → the service catalogue is
   *     shared across branches.
   *   - `subscription.read`, `billing.read`, `usage.read`, `featureflag.read`,
   *     `billing_upgrade.read`                 → clinic-level commercial data.
   *   - `clinical.records.read` / `.manage`    → an operations role, not a
   *     clinical one; the curated privacy boundary stays owner/manager/doctor.
   *   - `notification_templates.*`,
   *     `notification_rules.*`, `campaigns.manage`,
   *     `campaign_recipients.manage`           → clinic-wide configuration and
   *     outbound marketing; read-only access is kept.
   *   - `whatsapp.accounts.manage`,
   *     `whatsapp.templates.manage`,
   *     `whatsapp.webhooks.manage`, `ai.manage`,
   *     `ai.agents.*`, `ai.knowledge.*`,
   *     `ai.training.*`, `ai.prompts.*`        → channel/AI configuration is
   *     clinic-wide; the conversational surface (reply, hand-over takeover)
   *     is kept because that IS branch front-desk work.
   *   - `platform.api-logs.read`,
   *     `platform.webhooks.read`,
   *     `platform.files.*`                     → developer/integration tooling.
   *
   * Kept from MANAGER: the full appointment lifecycle, queue (which reads
   * `appointments.*`), scheduling, staff READ + schedule/time-off management,
   * CRM, reviews, conversations/WhatsApp replies, support tickets,
   * notifications read, and `audit.read` — every one of which is narrowed to
   * the caller's branch(es) server-side (see `BranchScopeService`), except
   * where the underlying entity has no branch at all (customers, handovers),
   * which is documented at each call site rather than silently ignored.
   */
  [ROLE.BRANCH_MANAGER]: [
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
    PERMISSION.SERVICES_READ,
    PERMISSION.STAFF_READ,
    PERMISSION.STAFF_SCHEDULE_MANAGE,
    PERMISSION.STAFF_TIMEOFF_MANAGE,
    PERMISSION.STAFF_RATING_READ,
    PERMISSION.SCHEDULING_SLOTS_READ,
    PERMISSION.SCHEDULING_SLOTS_MANAGE,
    PERMISSION.SCHEDULING_BLOCKED_READ,
    PERMISSION.SCHEDULING_BLOCKED_MANAGE,
    PERMISSION.SCHEDULING_HOLIDAYS_READ,
    PERMISSION.SCHEDULING_HOLIDAYS_MANAGE,
    PERMISSION.SCHEDULING_AVAILABILITY_READ,
    PERMISSION.NOTIFICATIONS_READ,
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
    // The branch-restriction marker (see `isBranchRestricted`) AND a real
    // capability: a branch manager may edit their own branch's details.
    PERMISSION.BRANCHES_UPDATE_OWN,
    // Narrowed to the caller's branch(es) by `ActivityLogService`.
    PERMISSION.AUDIT_READ,
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
  //   - STAFF_READ_OWN — an ABAC/ownership-scoped permission (see
  //     OWNERSHIP_SCOPED_PERMISSIONS above), NOT the tenant-wide STAFF_READ.
  //     Enforced structurally rather than by a service-layer ownership check:
  //     `GET /staff/me`, `/staff/me/schedules` and `/staff/me/time-off`
  //     (`staff.controller.ts`) accept no id from the client at all — the
  //     caller's own StaffProfile id comes from `StaffScopeService`, so there
  //     is no request shape that could ask for anyone else's. This is the
  //     ownership-scoped enforcement path the note below used to say did not
  //     exist yet; it now does, and is scoped to profile/schedule/time-off
  //     read only — `staff.read` (browsing every OTHER staff member) is
  //     still not granted.
  //   - APPOINTMENTS_STATUS_UPDATE — the doctor's own queue workflow:
  //     check-in/call/start/complete/skip/recall/no-show and
  //     `POST /appointments/:id/status`. Granted ONLY together with the
  //     ownership check in `StaffScopeService.assertMayDriveAppointment`
  //     (predicate: `isStatusWriteScopedToOwnStaff`), which confines a
  //     holder without `appointments.update`/`appointments.read` to
  //     appointments assigned to its OWN StaffProfile (404 otherwise), and
  //     limits the status a doctor may set to
  //     `OWN_STAFF_SETTABLE_APPOINTMENT_STATUSES` (no manual CONFIRMED — that
  //     would bypass payment confirmation). Without that check the slug alone
  //     would let a doctor drive another doctor's entry by UUID.
  //   - CRM_CUSTOMERS_UPDATE_OWN — edit contact/demographic fields of a
  //     patient the doctor has an appointment with (ABAC, see its docblock).
  //     CRM_CUSTOMERS_MANAGE stays withheld: it also creates/deletes/imports
  //     patients and manages addresses/segments clinic-wide.
  //   - CRM_NOTES_READ / CRM_TAGS_READ / CRM_FILES_READ — read-only care
  //     context on the patient record (same trio the nurse holds). The
  //     matching `.manage` slugs are NOT granted (`crm.files.manage` also
  //     hard-deletes the stored object; notes are not author-scoped).
  //   - STAFF_SCHEDULE_READ — read a branch's working hours so the Branches
  //     page works, without `staff.read`. Tenant-verified by the service.
  //
  // Still explicitly NOT granted: appointments.create/update/reschedule/cancel
  // (booking/reassigning/moving/cancelling), crm.customers.manage,
  // crm.notes/tags/files.manage, staff.read/update/manage (any OTHER staff
  // member's data), staff.schedule.manage/staff.timeoff.manage (writes to
  // anyone's schedule, including their own), branches.* (administration),
  // services.read, notifications.read, ai.chat, reviews.read, every
  // finance/billing/settings/analytics slug. Add only once there is a real
  // ownership-scoped enforcement path for each, mirroring
  // APPOINTMENTS_READ_OWN.
  [ROLE.DOCTOR]: [
    PERMISSION.DASHBOARD_ACCESS,
    PERMISSION.APPOINTMENTS_READ_OWN,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.CRM_CUSTOMERS_UPDATE_OWN,
    PERMISSION.CRM_NOTES_READ,
    PERMISSION.CRM_TAGS_READ,
    PERMISSION.CRM_FILES_READ,
    PERMISSION.CLINICAL_RECORDS_READ,
    PERMISSION.CLINICAL_RECORDS_MANAGE,
    PERMISSION.STAFF_READ_OWN,
    PERMISSION.STAFF_SCHEDULE_READ,
  ],

  // Nurse — clinic-wide (NOT branch-restricted; not in isBranchRestricted's
  // input pair), like doctor/receptionist. Reviewed permission-by-permission
  // against the same modules DOCTOR was, with a deliberately different
  // shape:
  //
  //   - DASHBOARD_ACCESS: reach the workspace shell at all.
  //   - APPOINTMENTS_READ (tenant-wide, NOT `_read_own`): a nurse is never
  //     the assigned provider on an appointment (nurse is not in
  //     APPOINTMENT_BOOKABLE_STAFF_ROLES), so `_read_own` would resolve to
  //     no StaffProfile ownership and show nothing — the "own" ABAC pattern
  //     only fits a role that IS the assigned staff member. Tenant-wide read
  //     is what lets a nurse see the appointments/queue they support.
  //   - APPOINTMENTS_STATUS_UPDATE (NOT the tenant-wide APPOINTMENTS_UPDATE):
  //     queue check-in/call/start/complete/skip/recall/no-show and
  //     `POST /appointments/:id/status` only — never reassigning the
  //     doctor/branch (`PATCH`) or replacing services (`PUT .../services`).
  //   - CRM_CUSTOMERS_READ / CRM_NOTES_READ / CRM_TAGS_READ / CRM_FILES_READ:
  //     read-only patient record access — search, notes, tags and files.
  //     CRM_CUSTOMERS_MANAGE / CRM_NOTES_MANAGE / CRM_TAGS_MANAGE /
  //     CRM_FILES_MANAGE are deliberately NOT granted (D3: files are
  //     read-only in v1 — `crm.files.manage` also hard-deletes the R2
  //     object, which a nurse must never be able to do).
  //   - CLINICAL_RECORDS_READ: the clinical timeline, allergies and doctor's
  //     instructions — same privacy boundary as doctor/owner/manager.
  //   - CLINICAL_RECORDS_NURSING (NOT `.manage`): create NOTE/VITALS entries
  //     and encounters, correct only their OWN NOTE/VITALS entries — see its
  //     own docblock above. `.manage` is withheld on purpose: it would let a
  //     nurse create/approve DIAGNOSIS or MEDICATION entries, correct a
  //     doctor's entry, or delete clinical content, none of which is a
  //     nursing duty.
  //   - STAFF_READ_OWN: own profile/schedule/time-off only, exactly like
  //     doctor — never the tenant-wide STAFF_READ.
  //
  // Explicitly NOT granted: appointments.create/update/reschedule/cancel/
  // manage_all, crm.*.manage, clinical.records.manage, staff.read/create/
  // update/manage/schedule.manage/timeoff.manage, services.*, scheduling.*
  // (manage), every payments/invoices/settlements/billing/subscription
  // slug, reports.*/analytics.*, audit.read, whatsapp.*, conversations.*/
  // messages.*/ai.*, notifications.*, campaigns.*, platform.*, users.manage,
  // roles.manage, branches.* — none of these are nursing duties.
  [ROLE.NURSE]: [
    PERMISSION.DASHBOARD_ACCESS,
    PERMISSION.APPOINTMENTS_READ,
    PERMISSION.APPOINTMENTS_STATUS_UPDATE,
    PERMISSION.CRM_CUSTOMERS_READ,
    PERMISSION.CRM_NOTES_READ,
    PERMISSION.CRM_TAGS_READ,
    PERMISSION.CRM_FILES_READ,
    PERMISSION.CLINICAL_RECORDS_READ,
    PERMISSION.CLINICAL_RECORDS_NURSING,
    PERMISSION.STAFF_READ_OWN,
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

  // Platform Sales: classification only. Every /platform/sales/** route is
  // gated on Super Admin by role (like /platform/staff), so this role has no
  // permission slug — and therefore no console, no clinic-workspace access
  // (no DASHBOARD_ACCESS) and no platform diagnostics.
  [ROLE.PLATFORM_SALES]: [],
};
