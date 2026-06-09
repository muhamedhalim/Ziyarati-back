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

  // Payments (financial — kept strictly separate from reporting)
  PAYMENTS_READ: 'payments.read',
  PAYMENTS_MANAGE: 'payments.manage',
  REFUNDS_MANAGE: 'refunds.manage',

  // Reports / analytics (its own domain — NOT an alias of payments)
  REPORTS_READ: 'reports.read',
  REPORTS_EXPORT: 'reports.export',

  // WhatsApp
  WHATSAPP_SEND: 'whatsapp.send',
  WHATSAPP_TEMPLATES_MANAGE: 'whatsapp.templates.manage',

  // AI
  AI_CHAT: 'ai.chat',
  AI_MANAGE: 'ai.manage',

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

  { slug: PERMISSION.PAYMENTS_READ, name: 'Read payments', module: 'payments' },
  { slug: PERMISSION.PAYMENTS_MANAGE, name: 'Manage payments', module: 'payments' },
  { slug: PERMISSION.REFUNDS_MANAGE, name: 'Manage refunds', module: 'payments' },

  { slug: PERMISSION.REPORTS_READ, name: 'Read reports', module: 'reports' },
  { slug: PERMISSION.REPORTS_EXPORT, name: 'Export reports', module: 'reports' },

  { slug: PERMISSION.WHATSAPP_SEND, name: 'Send WhatsApp messages', module: 'whatsapp' },
  { slug: PERMISSION.WHATSAPP_TEMPLATES_MANAGE, name: 'Manage WhatsApp templates', module: 'whatsapp' },

  { slug: PERMISSION.AI_CHAT, name: 'Use AI assistant', module: 'ai' },
  { slug: PERMISSION.AI_MANAGE, name: 'Manage AI assistant', module: 'ai' },

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
    PERMISSION.PAYMENTS_READ,
    PERMISSION.PAYMENTS_MANAGE,
    PERMISSION.REFUNDS_MANAGE,
    PERMISSION.REPORTS_READ,
    PERMISSION.REPORTS_EXPORT,
    PERMISSION.WHATSAPP_SEND,
    PERMISSION.WHATSAPP_TEMPLATES_MANAGE,
    PERMISSION.AI_CHAT,
    PERMISSION.AI_MANAGE,
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
    PERMISSION.SERVICES_READ,
    PERMISSION.STAFF_CREATE,
    PERMISSION.STAFF_READ,
    PERMISSION.STAFF_UPDATE,
    PERMISSION.STAFF_MANAGE,
    PERMISSION.STAFF_SCHEDULE_MANAGE,
    PERMISSION.STAFF_TIMEOFF_MANAGE,
    PERMISSION.STAFF_COMMISSION_READ,
    PERMISSION.STAFF_RATING_READ,
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
    PERMISSION.REPORTS_READ,
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
    PERMISSION.STAFF_READ,
    PERMISSION.NOTIFICATIONS_READ,
    PERMISSION.NOTIFICATION_TEMPLATES_READ,
    PERMISSION.CAMPAIGNS_READ,
    PERMISSION.CAMPAIGN_RECIPIENTS_READ,
    PERMISSION.CAMPAIGN_ANALYTICS_READ,
    PERMISSION.WHATSAPP_SEND,
  ],

  // End user: self-service only (ownership enforced in the service layer).
  [ROLE.CUSTOMER]: [
    PERMISSION.APPOINTMENTS_CREATE,
    PERMISSION.APPOINTMENTS_READ_OWN,
    PERMISSION.REVIEWS_CREATE,
    PERMISSION.PROFILE_UPDATE_OWN,
  ],
};
