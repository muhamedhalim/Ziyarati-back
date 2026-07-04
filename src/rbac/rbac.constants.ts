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
  PLATFORM_FILES_READ: 'platform.files.read',
  PLATFORM_FILES_MANAGE: 'platform.files.manage',
  // Platform-owned global settings (super_admin only; held via the * wildcard)
  PLATFORM_SETTINGS_READ: 'platform.settings.read',
  PLATFORM_SETTINGS_MANAGE: 'platform.settings.manage',

  // Admin / system
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  TENANTS_MANAGE: 'tenants.manage',
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
export const OWNERSHIP_SCOPED_PERMISSIONS: ReadonlySet<PermissionSlug> = new Set([
  PERMISSION.APPOINTMENTS_READ_OWN,
  PERMISSION.PROFILE_UPDATE_OWN,
]);

// ---------------------------------------------------------------------------
// Roles (snake_case slugs)
// ---------------------------------------------------------------------------

export const ROLE = {
  SUPER_ADMIN: 'super_admin',
  OWNER: 'owner',
  MANAGER: 'manager',
  RECEPTIONIST: 'receptionist',
  CUSTOMER: 'customer',
  /** Per-tenant system actor driving AI-initiated bookings (e.g. WhatsApp). */
  AI_BOT: 'ai-bot',
} as const;

export type RoleSlug = (typeof ROLE)[keyof typeof ROLE];

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
  { slug: PERMISSION.APPOINTMENTS_CREATE, name: 'Create appointments', module: 'appointments' },
  { slug: PERMISSION.APPOINTMENTS_READ, name: 'Read appointments', module: 'appointments' },
  { slug: PERMISSION.APPOINTMENTS_READ_OWN, name: 'Read own appointments', module: 'appointments' },
  { slug: PERMISSION.APPOINTMENTS_UPDATE, name: 'Update appointments', module: 'appointments' },
  { slug: PERMISSION.APPOINTMENTS_RESCHEDULE, name: 'Reschedule appointments', module: 'appointments' },
  { slug: PERMISSION.APPOINTMENTS_CANCEL, name: 'Cancel appointments', module: 'appointments' },
  { slug: PERMISSION.APPOINTMENTS_MANAGE_ALL, name: 'Manage all appointments', module: 'appointments' },

  { slug: PERMISSION.REVIEWS_READ, name: 'Read customer reviews', module: 'reviews' },
  { slug: PERMISSION.REVIEWS_CREATE, name: 'Create customer reviews', module: 'reviews' },
  { slug: PERMISSION.REVIEWS_MANAGE, name: 'Manage / reply to reviews', module: 'reviews' },

  { slug: PERMISSION.CUSTOMERS_CREATE, name: 'Create customers', module: 'customers' },
  { slug: PERMISSION.CUSTOMERS_READ, name: 'Read customers', module: 'customers' },
  { slug: PERMISSION.CUSTOMERS_UPDATE, name: 'Update customers', module: 'customers' },
  { slug: PERMISSION.CUSTOMERS_MANAGE, name: 'Manage customers', module: 'customers' },

  { slug: PERMISSION.CRM_CUSTOMERS_READ, name: 'Read CRM customers', module: 'crm' },
  { slug: PERMISSION.CRM_CUSTOMERS_MANAGE, name: 'Manage CRM customers', module: 'crm' },
  { slug: PERMISSION.CRM_NOTES_READ, name: 'Read customer notes', module: 'crm' },
  { slug: PERMISSION.CRM_NOTES_MANAGE, name: 'Manage customer notes', module: 'crm' },
  { slug: PERMISSION.CRM_TAGS_READ, name: 'Read customer tags', module: 'crm' },
  { slug: PERMISSION.CRM_TAGS_MANAGE, name: 'Manage customer tags', module: 'crm' },
  { slug: PERMISSION.CRM_FILES_READ, name: 'Read customer files', module: 'crm' },
  { slug: PERMISSION.CRM_FILES_MANAGE, name: 'Manage customer files', module: 'crm' },

  { slug: PERMISSION.PROFILE_UPDATE_OWN, name: 'Update own profile', module: 'profile' },

  { slug: PERMISSION.SERVICES_CREATE, name: 'Create services', module: 'services' },
  { slug: PERMISSION.SERVICES_READ, name: 'Read services', module: 'services' },
  { slug: PERMISSION.SERVICES_UPDATE, name: 'Update services', module: 'services' },
  { slug: PERMISSION.SERVICES_DELETE, name: 'Delete services', module: 'services' },

  { slug: PERMISSION.STAFF_CREATE, name: 'Create staff', module: 'staff' },
  { slug: PERMISSION.STAFF_READ, name: 'Read staff', module: 'staff' },
  { slug: PERMISSION.STAFF_UPDATE, name: 'Update staff', module: 'staff' },
  { slug: PERMISSION.STAFF_MANAGE, name: 'Manage staff', module: 'staff' },
  { slug: PERMISSION.STAFF_SCHEDULE_MANAGE, name: 'Manage staff schedules & working hours', module: 'staff' },
  { slug: PERMISSION.STAFF_TIMEOFF_MANAGE, name: 'Manage staff time off', module: 'staff' },
  { slug: PERMISSION.STAFF_COMMISSION_READ, name: 'Read staff commissions', module: 'staff' },
  { slug: PERMISSION.STAFF_RATING_READ, name: 'Read staff ratings', module: 'staff' },

  { slug: PERMISSION.SCHEDULING_SLOTS_READ, name: 'Read calendar slots', module: 'scheduling' },
  { slug: PERMISSION.SCHEDULING_SLOTS_MANAGE, name: 'Manage calendar slots', module: 'scheduling' },
  { slug: PERMISSION.SCHEDULING_BLOCKED_READ, name: 'Read blocked slots', module: 'scheduling' },
  { slug: PERMISSION.SCHEDULING_BLOCKED_MANAGE, name: 'Manage blocked slots', module: 'scheduling' },
  { slug: PERMISSION.SCHEDULING_HOLIDAYS_READ, name: 'Read holidays', module: 'scheduling' },
  { slug: PERMISSION.SCHEDULING_HOLIDAYS_MANAGE, name: 'Manage holidays', module: 'scheduling' },
  { slug: PERMISSION.SCHEDULING_AVAILABILITY_READ, name: 'Read availability', module: 'scheduling' },

  { slug: PERMISSION.PAYMENTS_READ, name: 'Read payments', module: 'payments' },
  { slug: PERMISSION.PAYMENTS_MANAGE, name: 'Manage payments', module: 'payments' },
  { slug: PERMISSION.REFUNDS_MANAGE, name: 'Manage refunds', module: 'payments' },
  { slug: PERMISSION.INVOICES_READ, name: 'Read invoices', module: 'payments' },
  { slug: PERMISSION.INVOICES_MANAGE, name: 'Manage invoices', module: 'payments' },
  { slug: PERMISSION.SETTLEMENTS_READ, name: 'Read settlements', module: 'payments' },
  { slug: PERMISSION.SETTLEMENTS_MANAGE, name: 'Generate / manage settlements', module: 'payments' },

  { slug: PERMISSION.REPORTS_READ, name: 'Read reports', module: 'reports' },
  { slug: PERMISSION.REPORTS_EXPORT, name: 'Export reports', module: 'reports' },

  { slug: PERMISSION.ANALYTICS_EVENTS_READ, name: 'Read analytics events', module: 'analytics' },
  { slug: PERMISSION.ANALYTICS_EVENTS_MANAGE, name: 'Track analytics events', module: 'analytics' },
  { slug: PERMISSION.ANALYTICS_DASHBOARD_READ, name: 'Read dashboard metrics', module: 'analytics' },
  { slug: PERMISSION.ANALYTICS_REPORTS_READ, name: 'Read analytics reports', module: 'analytics' },
  { slug: PERMISSION.ANALYTICS_REPORTS_MANAGE, name: 'Generate analytics reports', module: 'analytics' },

  { slug: PERMISSION.WHATSAPP_SEND, name: 'Send WhatsApp messages', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_ACCOUNTS_READ, name: 'Read WhatsApp accounts', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_ACCOUNTS_MANAGE, name: 'Manage WhatsApp accounts', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_TEMPLATES_READ, name: 'Read WhatsApp templates', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_TEMPLATES_MANAGE, name: 'Manage WhatsApp templates', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_CONTACTS_READ, name: 'Read WhatsApp contacts', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_CONTACTS_MANAGE, name: 'Manage WhatsApp contacts', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_WEBHOOKS_MANAGE, name: 'Manage WhatsApp webhooks', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_ANALYTICS_READ, name: 'Read WhatsApp analytics', module: 'whatsapp' },

  { slug: PERMISSION.CONVERSATIONS_READ, name: 'Read conversations', module: 'conversations' },
  { slug: PERMISSION.CONVERSATIONS_MANAGE, name: 'Manage conversations', module: 'conversations' },
  { slug: PERMISSION.MESSAGES_SEND, name: 'Send messages', module: 'conversations' },
  { slug: PERMISSION.MESSAGES_READ, name: 'Read messages', module: 'conversations' },
  { slug: PERMISSION.PARTICIPANTS_MANAGE, name: 'Manage conversation participants', module: 'conversations' },
  { slug: PERMISSION.ATTACHMENTS_MANAGE, name: 'Manage message attachments', module: 'conversations' },
  { slug: PERMISSION.CONVERSATION_ANALYTICS_READ, name: 'Read conversation analytics', module: 'conversations' },

  { slug: PERMISSION.AI_CHAT, name: 'Use AI assistant', module: 'ai' },
  { slug: PERMISSION.AI_MANAGE, name: 'Manage AI assistant', module: 'ai' },
  { slug: PERMISSION.AI_AGENTS_READ, name: 'Read AI agents', module: 'ai' },
  { slug: PERMISSION.AI_AGENTS_MANAGE, name: 'Manage AI agents', module: 'ai' },
  { slug: PERMISSION.AI_KNOWLEDGE_READ, name: 'Read AI knowledge bases', module: 'ai' },
  { slug: PERMISSION.AI_KNOWLEDGE_MANAGE, name: 'Manage AI knowledge bases', module: 'ai' },
  { slug: PERMISSION.AI_TRAINING_READ, name: 'Read AI training files', module: 'ai' },
  { slug: PERMISSION.AI_TRAINING_MANAGE, name: 'Manage AI training files', module: 'ai' },
  { slug: PERMISSION.AI_PROMPTS_READ, name: 'Read AI prompts', module: 'ai' },
  { slug: PERMISSION.AI_PROMPTS_MANAGE, name: 'Manage AI prompts', module: 'ai' },
  { slug: PERMISSION.AI_CONVERSATIONS_READ, name: 'Read AI conversations', module: 'ai' },
  { slug: PERMISSION.AI_CONVERSATIONS_MANAGE, name: 'Manage AI conversations', module: 'ai' },
  { slug: PERMISSION.AI_HANDOVER_READ, name: 'Read AI handover requests', module: 'ai' },
  { slug: PERMISSION.AI_HANDOVER_MANAGE, name: 'Manage AI handover requests', module: 'ai' },
  { slug: PERMISSION.AI_ANALYTICS_READ, name: 'Read AI analytics', module: 'ai' },

  { slug: PERMISSION.SUBSCRIPTION_READ, name: 'Read subscription', module: 'billing' },
  { slug: PERMISSION.SUBSCRIPTION_MANAGE, name: 'Manage subscription', module: 'billing' },
  { slug: PERMISSION.BILLING_READ, name: 'Read billing & invoices', module: 'billing' },
  { slug: PERMISSION.BILLING_MANAGE, name: 'Manage billing & invoices', module: 'billing' },
  { slug: PERMISSION.USAGE_READ, name: 'Read usage stats', module: 'billing' },
  { slug: PERMISSION.FEATUREFLAG_READ, name: 'Read feature flags', module: 'billing' },
  { slug: PERMISSION.FEATUREFLAG_MANAGE, name: 'Manage feature flags', module: 'billing' },

  { slug: PERMISSION.NOTIFICATIONS_READ, name: 'Read notifications', module: 'notifications' },
  { slug: PERMISSION.NOTIFICATIONS_MANAGE, name: 'Manage notifications', module: 'notifications' },
  { slug: PERMISSION.NOTIFICATION_TEMPLATES_READ, name: 'Read notification templates', module: 'notifications' },
  { slug: PERMISSION.NOTIFICATION_TEMPLATES_MANAGE, name: 'Manage notification templates', module: 'notifications' },
  { slug: PERMISSION.NOTIFICATION_RULES_READ, name: 'Read notification rules', module: 'notifications' },
  { slug: PERMISSION.NOTIFICATION_RULES_MANAGE, name: 'Manage notification rules', module: 'notifications' },

  { slug: PERMISSION.CAMPAIGNS_READ, name: 'Read campaigns', module: 'campaigns' },
  { slug: PERMISSION.CAMPAIGNS_MANAGE, name: 'Manage campaigns', module: 'campaigns' },
  { slug: PERMISSION.CAMPAIGN_RECIPIENTS_READ, name: 'Read campaign recipients', module: 'campaigns' },
  { slug: PERMISSION.CAMPAIGN_RECIPIENTS_MANAGE, name: 'Manage campaign recipients', module: 'campaigns' },
  { slug: PERMISSION.CAMPAIGN_ANALYTICS_READ, name: 'Read campaign analytics', module: 'campaigns' },

  { slug: PERMISSION.PLATFORM_API_KEYS_READ, name: 'Read API keys', module: 'platform' },
  { slug: PERMISSION.PLATFORM_API_KEYS_MANAGE, name: 'Manage API keys', module: 'platform' },
  { slug: PERMISSION.PLATFORM_API_LOGS_READ, name: 'Read API logs', module: 'platform' },
  { slug: PERMISSION.PLATFORM_WEBHOOKS_READ, name: 'Read webhook logs', module: 'platform' },
  { slug: PERMISSION.PLATFORM_WEBHOOKS_MANAGE, name: 'Manage webhook logs', module: 'platform' },
  { slug: PERMISSION.PLATFORM_FILES_READ, name: 'Read file uploads', module: 'platform' },
  { slug: PERMISSION.PLATFORM_FILES_MANAGE, name: 'Manage file uploads', module: 'platform' },
  { slug: PERMISSION.PLATFORM_SETTINGS_READ, name: 'Read system settings', module: 'platform' },
  { slug: PERMISSION.PLATFORM_SETTINGS_MANAGE, name: 'Manage system settings', module: 'platform' },

  { slug: PERMISSION.USERS_MANAGE, name: 'Manage users', module: 'admin' },
  { slug: PERMISSION.ROLES_MANAGE, name: 'Manage roles', module: 'admin' },
  { slug: PERMISSION.TENANTS_MANAGE, name: 'Manage tenants', module: 'admin' },
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
    description: 'Front desk. Handles bookings, customers and WhatsApp replies.',
  },
  {
    slug: ROLE.CUSTOMER,
    name: 'Customer',
    description: 'End user who books appointments and manages their profile.',
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
    PERMISSION.PLATFORM_FILES_READ,
    PERMISSION.PLATFORM_FILES_MANAGE,
  ],

  // Operations manager: appointments + customers + staff + reports.
  // No payment/refund access at all (reporting is its own domain now).
  [ROLE.MANAGER]: [
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
  ],

  // Front desk: books appointments, manages customer records, WhatsApp replies.
  [ROLE.RECEPTIONIST]: [
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
};
