import { ROLE } from '../../../rbac/rbac.constants';

/**
 * Approved MFA policy (P0.5 follow-up).
 *
 *  - `privileged`: Super Admin, platform staff (support, sales), Clinic Owner and
 *    Clinic Admin (manager, branch manager). Any principal without a tenant is a
 *    platform user and is privileged too. Enforced from `MFA_ENFORCE_FROM`.
 *  - `clinical`: everyone else who can read or write patient clinical records —
 *    by role (doctor, nurse) or by holding a clinical-records permission. Enforced
 *    from `MFA_ENFORCE_CLINICAL_FROM`, so it can roll out after the privileged tier.
 *  - `none`: patients (customer role) and clinic staff with no clinical access.
 *    Patient MFA stays optional — an enrolled patient is still challenged at login.
 */
export type MfaTier = 'privileged' | 'clinical' | 'none';

const PRIVILEGED_ROLES: ReadonlySet<string> = new Set([
  ROLE.SUPER_ADMIN,
  ROLE.PLATFORM_SUPPORT,
  ROLE.PLATFORM_SALES,
  ROLE.OWNER,
  ROLE.MANAGER,
  ROLE.BRANCH_MANAGER,
]);

const CLINICAL_ROLES: ReadonlySet<string> = new Set([ROLE.DOCTOR, ROLE.NURSE]);

const CLINICAL_PERMISSIONS: ReadonlySet<string> = new Set([
  'clinical.records.read',
  'clinical.records.manage',
  'clinical.records.nursing',
]);

export interface MfaPrincipal {
  tenantId: string | null;
  roles: string[];
  permissions: string[];
}

export function mfaTier(p: MfaPrincipal): MfaTier {
  if (p.roles.includes(ROLE.AI_BOT)) return 'none';
  if (p.tenantId === null || p.roles.some((r) => PRIVILEGED_ROLES.has(r))) {
    return 'privileged';
  }
  if (
    p.roles.some((r) => CLINICAL_ROLES.has(r)) ||
    p.permissions.some((s) => CLINICAL_PERMISSIONS.has(s))
  ) {
    return 'clinical';
  }
  return 'none';
}

/** The config key holding the enforcement date for a tier, or null when the tier is never enforced. */
export function enforcementKey(tier: MfaTier): string | null {
  if (tier === 'privileged') return 'MFA_ENFORCE_FROM';
  if (tier === 'clinical') return 'MFA_ENFORCE_CLINICAL_FROM';
  return null;
}
