/**
 * ============================================================================
 *  PERMISSION METADATA REGISTRY  (audit / classification layer)
 * ============================================================================
 *
 * This file is the DETERMINISTIC source of truth for the *descriptive* and
 * *risk* metadata attached to each permission — the data the Access-Control
 * Audit Center reports on. It sits alongside `rbac.constants.ts` (the
 * authorization contract) and NEVER influences authorization decisions: guards
 * still key off the slug alone. Metadata here is:
 *
 *   - `risk`      — informational classification (low | medium | high | critical)
 *   - `scope`     — the layer a permission operates at (platform | tenant | …)
 *   - `deprecated`— whether the slug is being phased out (kept, not deleted)
 *   - `description` (optional) — human copy for admin dashboards
 *
 * The seeder (`permissions.seed.ts`) copies this metadata onto the persisted
 * `permissions` rows so the audit APIs can filter/sort/aggregate in SQL. Because
 * everything is derived here from a small, reviewed override set (never from
 * fragile per-request string matching), the classification is stable and
 * greppable.
 *
 * DESIGN RULES
 *   1. Unknown / unmapped permissions are NEVER silently classified high-risk.
 *      Reads default to `low`, writes/manage default to `medium`; `high` and
 *      `critical` require an explicit entry in RISK_OVERRIDES.
 *   2. Scope defaults to `tenant`; `platform` is inferred for the platform.*
 *      namespace (+ `tenants.manage`); other scopes require an override.
 *   3. `deprecated` is opt-in via DEPRECATED_SLUGS — deprecation is an explicit
 *      administrative decision, so the set is empty until one is made.
 */

import { PERMISSION, PermissionSlug } from './rbac.constants';

// ---------------------------------------------------------------------------
// Value types (persisted as plain varchars; no DB enum, matching the codebase)
// ---------------------------------------------------------------------------

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const PERMISSION_SCOPES = ['platform', 'tenant', 'branch', 'system'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export const PERMISSION_STATUSES = ['active', 'deprecated'] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

/** Documented safe default when a write/manage permission has no explicit risk. */
export const DEFAULT_RISK: RiskLevel = 'medium';

// ---------------------------------------------------------------------------
// Explicit high / critical classifications (reviewed by hand)
// ---------------------------------------------------------------------------

/**
 * `critical` — irreversible, cross-tenant, or self-escalating actions. `high` —
 * destructive or money/identity-touching within a tenant. Anything not listed
 * falls back to the derived default (low for reads, medium otherwise).
 */
export const RISK_OVERRIDES: Partial<Record<PermissionSlug, RiskLevel>> = {
  // Low — mere entry to the workspace shell, not a data-access grant.
  [PERMISSION.DASHBOARD_ACCESS]: 'low',

  // Critical — platform integrity & privilege escalation
  [PERMISSION.TENANTS_MANAGE]: 'critical',
  [PERMISSION.ROLES_MANAGE]: 'critical', // can grant any permission to anyone
  [PERMISSION.USERS_MANAGE]: 'critical',
  [PERMISSION.PLATFORM_SETTINGS_MANAGE]: 'critical',
  [PERMISSION.REFUNDS_MANAGE]: 'critical', // moves money out
  [PERMISSION.PLATFORM_API_KEYS_MANAGE]: 'critical', // credential issuance

  // High — destructive / financial / identity-adjacent
  [PERMISSION.SERVICES_DELETE]: 'high',
  [PERMISSION.APPOINTMENTS_MANAGE_ALL]: 'high',
  [PERMISSION.PAYMENTS_MANAGE]: 'high',
  [PERMISSION.SETTLEMENTS_MANAGE]: 'high',
  [PERMISSION.INVOICES_MANAGE]: 'high',
  [PERMISSION.BILLING_MANAGE]: 'high',
  [PERMISSION.SUBSCRIPTION_MANAGE]: 'high',
  [PERMISSION.FEATUREFLAG_MANAGE]: 'high',
  [PERMISSION.BILLING_UPGRADE_MANAGE]: 'high', // triggers a real charge on accept

  [PERMISSION.PLATFORM_WEBHOOKS_MANAGE]: 'high',
  [PERMISSION.STAFF_MANAGE]: 'high',
  [PERMISSION.CUSTOMERS_MANAGE]: 'high',
  [PERMISSION.CRM_CUSTOMERS_MANAGE]: 'high',
  [PERMISSION.AI_MANAGE]: 'high',
  [PERMISSION.WHATSAPP_ACCOUNTS_MANAGE]: 'high',
  [PERMISSION.WHATSAPP_WEBHOOKS_MANAGE]: 'high',
  [PERMISSION.NOTIFICATION_RULES_MANAGE]: 'high',
  [PERMISSION.REPORTS_EXPORT]: 'high', // exfiltration of sensitive data

  // Platform Customer Service support-ticket family — cross-tenant read is
  // more sensitive than an ordinary tenant read (medium, not the derived
  // low); triage/reply mutate cross-tenant state (high); close is critical
  // because it is the one action reserved to super_admin alone.
  [PERMISSION.PLATFORM_SUPPORT_TICKETS_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE]: 'high',
  [PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY]: 'high',
  [PERMISSION.PLATFORM_SUPPORT_TICKETS_CLOSE]: 'critical',

  // Support Operations Console diagnostics. Every read here is CROSS-TENANT,
  // so none may fall back to the derived `low` that `deriveBaseRisk` would
  // otherwise give any slug containing ".read" — same reasoning already
  // applied to PLATFORM_SUPPORT_TICKETS_READ above. The four touching
  // customer-adjacent or money-adjacent domains are `high` even though they
  // are reads, because a projection bug there discloses more than an
  // operational status would.
  [PERMISSION.PLATFORM_SUPPORT_CLINICS_READ_BASIC]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_SUBSCRIPTIONS_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_FEATURES_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_CLINIC_SETTINGS_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_JOBS_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_AUDIT_READ]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_WHATSAPP_READ_DIAGNOSTICS]: 'medium',
  [PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_READ]: 'high', // recipient identifiers
  [PERMISSION.PLATFORM_SUPPORT_APPOINTMENTS_READ_DIAGNOSTICS]: 'high', // patient-adjacent
  [PERMISSION.PLATFORM_SUPPORT_PAYMENTS_READ_DIAGNOSTICS]: 'high', // money-adjacent
  [PERMISSION.PLATFORM_SUPPORT_AI_READ_DIAGNOSTICS]: 'high', // conversation-adjacent

  // Safe actions — writes that trigger a real outbound message or a real
  // provider probe. Idempotent and destination-locked, but still `high`: they
  // cause an externally visible side effect on a clinic's behalf.
  [PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_RETRY]: 'high',
  [PERMISSION.PLATFORM_SUPPORT_EMAIL_RESEND]: 'high',
  [PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_RECHECK]: 'medium',

  // Clinical records — health data; read is high-risk here, not the derived
  // low, because it discloses medical history rather than operational data.
  [PERMISSION.CLINICAL_RECORDS_READ]: 'high',
  [PERMISSION.CLINICAL_RECORDS_MANAGE]: 'high',

  // Accountability log — a read of who-did-what across the tenant, more
  // sensitive than an ordinary operational read but not identity/money
  // touching, so medium rather than the derived low or an escalation to high.
  [PERMISSION.AUDIT_READ]: 'medium',
};

// ---------------------------------------------------------------------------
// Scope overrides (default is derived; override only the exceptions)
// ---------------------------------------------------------------------------

export const SCOPE_OVERRIDES: Partial<Record<PermissionSlug, PermissionScope>> = {
  // (none required today — platform.* + tenants.manage are inferred below)
};

// ---------------------------------------------------------------------------
// Deprecated slugs (explicit administrative decision; empty until one is made)
// ---------------------------------------------------------------------------

export const DEPRECATED_SLUGS: ReadonlySet<PermissionSlug> = new Set<PermissionSlug>([]);

// ---------------------------------------------------------------------------
// Human descriptions (a curated subset; the rest are intentionally undescribed
// so the "missing description" audit finding surfaces real gaps to fill).
// ---------------------------------------------------------------------------

export const PERMISSION_DESCRIPTIONS: Partial<Record<PermissionSlug, string>> = {
  [PERMISSION.DASHBOARD_ACCESS]:
    'Entry to the clinic dashboard shell itself — grants no data access on its own; what a role can see/do once inside is governed by its other permissions.',
  [PERMISSION.TENANTS_MANAGE]:
    'Create, suspend and delete tenants (clinics). Platform-level control that spans every tenant.',
  [PERMISSION.ROLES_MANAGE]:
    'Create roles and assign permissions to them. Effectively confers the ability to grant any other permission.',
  [PERMISSION.USERS_MANAGE]:
    'Create, update and deactivate user accounts and their role assignments.',
  [PERMISSION.PLATFORM_SETTINGS_MANAGE]:
    'Change platform-wide system settings, including integration credentials and operational toggles.',
  [PERMISSION.PLATFORM_SETTINGS_READ]:
    'View platform-wide system settings (values may be redacted for secrets).',
  [PERMISSION.REFUNDS_MANAGE]:
    'Issue refunds against captured payments. Directly moves money out of the platform.',
  [PERMISSION.PAYMENTS_MANAGE]:
    'Capture, void and reconcile payments for a tenant.',
  [PERMISSION.PAYMENTS_READ]: 'View payment records and their status.',
  [PERMISSION.SETTLEMENTS_MANAGE]:
    'Generate and manage settlement batches that pay tenants their net balance.',
  [PERMISSION.INVOICES_MANAGE]: 'Create, edit and void customer invoices.',
  [PERMISSION.BILLING_MANAGE]: 'Manage a tenant’s subscription billing and invoices.',
  [PERMISSION.SUBSCRIPTION_MANAGE]: 'Change a tenant’s subscription plan and lifecycle.',
  [PERMISSION.PLATFORM_API_KEYS_MANAGE]:
    'Issue and revoke API keys used for programmatic platform access.',
  [PERMISSION.PLATFORM_WEBHOOKS_MANAGE]: 'Configure outbound webhook endpoints and secrets.',
  [PERMISSION.FEATUREFLAG_MANAGE]: 'Toggle feature flags that gate product capabilities.',
  [PERMISSION.SERVICES_DELETE]: 'Permanently remove a bookable service from a tenant catalogue.',
  [PERMISSION.APPOINTMENTS_MANAGE_ALL]:
    'Full control over every appointment in the tenant, regardless of owner.',
  [PERMISSION.STAFF_MANAGE]: 'Manage staff members, their profiles and employment status.',
  [PERMISSION.CUSTOMERS_MANAGE]: 'Full control over customer records within the tenant.',
  [PERMISSION.CRM_CUSTOMERS_MANAGE]: 'Manage CRM customer records, ownership and lifecycle.',
  [PERMISSION.AI_MANAGE]: 'Configure the AI assistant, its agents, prompts and knowledge bases.',
  [PERMISSION.REPORTS_READ]: 'View operational and financial reports.',
  [PERMISSION.REPORTS_EXPORT]: 'Export reports to file — a potential data-exfiltration path.',
  [PERMISSION.APPOINTMENTS_CREATE]: 'Book new appointments.',
  [PERMISSION.APPOINTMENTS_READ]: 'View any appointment in the tenant.',
  [PERMISSION.APPOINTMENTS_READ_OWN]:
    'View only the appointments the current user owns (ownership enforced in the service layer).',
  [PERMISSION.PROFILE_UPDATE_OWN]:
    'Update the current user’s own profile (ownership enforced in the service layer).',
  [PERMISSION.CUSTOMERS_READ]: 'View customer records.',
  [PERMISSION.SERVICES_READ]: 'View the bookable service catalogue.',
  [PERMISSION.STAFF_READ]: 'View staff members and their profiles.',
};

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

/** Reads (and self-service) are low-risk by default; everything else medium. */
function deriveBaseRisk(slug: string): RiskLevel {
  if (/\.read(_own)?$/.test(slug) || slug.endsWith('_own') || slug.includes('.read')) {
    return 'low';
  }
  return DEFAULT_RISK;
}

export function getRisk(slug: PermissionSlug): RiskLevel {
  return RISK_OVERRIDES[slug] ?? deriveBaseRisk(slug);
}

export function getScope(slug: PermissionSlug): PermissionScope {
  const override = SCOPE_OVERRIDES[slug];
  if (override) return override;
  if (slug.startsWith('platform.')) return 'platform';
  if (slug === PERMISSION.TENANTS_MANAGE) return 'platform';
  return 'tenant';
}

export function isDeprecated(slug: PermissionSlug): boolean {
  return DEPRECATED_SLUGS.has(slug);
}

export interface PermissionMetadata {
  description: string | null;
  scope: PermissionScope;
  risk: RiskLevel;
  deprecated: boolean;
}

/** Resolves the full metadata bundle for a slug (used by the seeder). */
export function getPermissionMetadata(slug: PermissionSlug): PermissionMetadata {
  return {
    description: PERMISSION_DESCRIPTIONS[slug] ?? null,
    scope: getScope(slug),
    risk: getRisk(slug),
    deprecated: isDeprecated(slug),
  };
}
