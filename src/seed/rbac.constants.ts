/**
 * Canonical RBAC definitions for the clinic SaaS platform.
 *
 * These describe the *system* roles and the global permission catalogue. They
 * are the single source of truth consumed by every seeder, so the seeded state
 * always converges to exactly what is declared here.
 *
 * ⚠️  Slugs are stable identifiers — referenced by guards and business logic.
 *     Never rename a slug; add a new one and migrate instead.
 */

export interface PermissionDef {
  slug: string;
  name: string;
  module: string;
}

export interface RoleDef {
  slug: string;
  name: string;
  description: string;
}

/** The five platform roles, by slug (DO NOT rename). */
export const ROLE_SLUGS = {
  SUPER_ADMIN: 'super_admin',
  OWNER: 'owner',
  MANAGER: 'manager',
  RECEPTIONIST: 'receptionist',
  CUSTOMER: 'customer',
} as const;

export const ROLES: RoleDef[] = [
  {
    slug: ROLE_SLUGS.SUPER_ADMIN,
    name: 'Super Admin',
    description: 'Platform operator. Full control across all tenants.',
  },
  {
    slug: ROLE_SLUGS.OWNER,
    name: 'Clinic Owner',
    description: 'Owns the clinic (tenant). Runs the business end-to-end.',
  },
  {
    slug: ROLE_SLUGS.MANAGER,
    name: 'Operations Manager',
    description: 'Supervises staff, appointments and customers for the clinic.',
  },
  {
    slug: ROLE_SLUGS.RECEPTIONIST,
    name: 'Receptionist',
    description: 'Front desk. Handles bookings, customers and WhatsApp replies.',
  },
  {
    slug: ROLE_SLUGS.CUSTOMER,
    name: 'Customer',
    description: 'End user who books appointments and manages their profile.',
  },
];

/**
 * Global permission catalogue, grouped by domain module.
 *
 * Note: `appointments.read_own` and `profile.update_own` are end-user-scoped
 * variants required by the `customer` role mapping below.
 */
export const PERMISSIONS: PermissionDef[] = [
  // ── Appointments ──────────────────────────────────────────────────────
  { slug: 'appointments.create', name: 'Create appointments', module: 'appointments' },
  { slug: 'appointments.read', name: 'Read appointments', module: 'appointments' },
  { slug: 'appointments.read_own', name: 'Read own appointments', module: 'appointments' },
  { slug: 'appointments.update', name: 'Update appointments', module: 'appointments' },
  { slug: 'appointments.cancel', name: 'Cancel appointments', module: 'appointments' },
  { slug: 'appointments.manage_all', name: 'Manage all appointments', module: 'appointments' },

  // ── Customers ─────────────────────────────────────────────────────────
  { slug: 'customers.create', name: 'Create customers', module: 'customers' },
  { slug: 'customers.read', name: 'Read customers', module: 'customers' },
  { slug: 'customers.update', name: 'Update customers', module: 'customers' },
  { slug: 'customers.manage', name: 'Manage customers', module: 'customers' },

  // ── Profile (self-service) ────────────────────────────────────────────
  { slug: 'profile.update_own', name: 'Update own profile', module: 'profile' },

  // ── Services ──────────────────────────────────────────────────────────
  { slug: 'services.create', name: 'Create services', module: 'services' },
  { slug: 'services.read', name: 'Read services', module: 'services' },
  { slug: 'services.update', name: 'Update services', module: 'services' },
  { slug: 'services.delete', name: 'Delete services', module: 'services' },

  // ── Staff ─────────────────────────────────────────────────────────────
  { slug: 'staff.manage', name: 'Manage staff', module: 'staff' },

  // ── Payments ──────────────────────────────────────────────────────────
  { slug: 'payments.read', name: 'Read payments', module: 'payments' },
  { slug: 'payments.manage', name: 'Manage payments', module: 'payments' },
  { slug: 'refunds.manage', name: 'Manage refunds', module: 'payments' },

  // ── WhatsApp ──────────────────────────────────────────────────────────
  { slug: 'whatsapp.send', name: 'Send WhatsApp messages', module: 'whatsapp' },
  { slug: 'whatsapp.templates.manage', name: 'Manage WhatsApp templates', module: 'whatsapp' },

  // ── AI ────────────────────────────────────────────────────────────────
  { slug: 'ai.chat', name: 'Use AI assistant', module: 'ai' },
  { slug: 'ai.manage', name: 'Manage AI assistant', module: 'ai' },

  // ── Admin / system ────────────────────────────────────────────────────
  { slug: 'users.manage', name: 'Manage users', module: 'admin' },
  { slug: 'roles.manage', name: 'Manage roles', module: 'admin' },
  { slug: 'tenants.manage', name: 'Manage tenants', module: 'admin' },
];

/** Sentinel meaning "every permission in the catalogue". */
export const ALL_PERMISSIONS = '*' as const;

/**
 * Strict role → permission mapping.
 *
 * Re-running the seeder reconciles each role to *exactly* this set (extras are
 * removed, missing ones added).
 */
export const ROLE_PERMISSIONS: Record<string, string[] | typeof ALL_PERMISSIONS> = {
  // Platform operator: everything.
  [ROLE_SLUGS.SUPER_ADMIN]: ALL_PERMISSIONS,

  // Clinic owner: full clinic control, excluding platform internals
  // (`tenants.manage`) and end-user self-service scopes.
  [ROLE_SLUGS.OWNER]: [
    'appointments.create',
    'appointments.read',
    'appointments.update',
    'appointments.cancel',
    'appointments.manage_all',
    'customers.create',
    'customers.read',
    'customers.update',
    'customers.manage',
    'services.create',
    'services.read',
    'services.update',
    'services.delete',
    'staff.manage',
    'payments.read',
    'payments.manage',
    'refunds.manage',
    'whatsapp.send',
    'whatsapp.templates.manage',
    'ai.chat',
    'ai.manage',
    'users.manage',
    'roles.manage',
  ],

  // Operations manager: supervises appointments, customers and staff.
  // Read-only payment visibility for reporting; no payment/refund control.
  [ROLE_SLUGS.MANAGER]: [
    'appointments.create',
    'appointments.read',
    'appointments.update',
    'appointments.cancel',
    'appointments.manage_all',
    'customers.create',
    'customers.read',
    'customers.update',
    'customers.manage',
    'services.read',
    'staff.manage',
    'payments.read',
  ],

  // Front desk: books appointments, manages customer records, replies on WhatsApp.
  [ROLE_SLUGS.RECEPTIONIST]: [
    'appointments.create',
    'appointments.read',
    'appointments.update',
    'appointments.cancel',
    'customers.create',
    'customers.read',
    'customers.update',
    'whatsapp.send',
  ],

  // End user: self-service only.
  [ROLE_SLUGS.CUSTOMER]: [
    'appointments.create',
    'appointments.read_own',
    'profile.update_own',
  ],
};
