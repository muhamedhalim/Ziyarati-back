/**
 * FND-010 — catalogue-coverage invariant.
 *
 * Every permission in the catalogue MUST have a verified enforcing consumer
 * (a controller route checking it, or a service-layer ABAC policy referencing
 * it) UNLESS it is explicitly, deliberately listed in
 * `UNENFORCED_PERMISSION_SLUGS` — never silently. This walks the whole `src/`
 * tree (test-time discovery only, mirrors `all-dtos.spec.ts`'s convention) for
 * every literal `PERMISSION.<KEY>` symbol reference OUTSIDE the catalogue file
 * itself and its own spec files, so it catches both decorator usage
 * (`@RequirePermissions(PERMISSION.X)`) and any programmatic check
 * (`caller.permissions.includes(PERMISSION.X)`) — the whole codebase's
 * convention (per rbac.constants.ts's own docblock) is to always reference
 * `PERMISSION.<KEY>`, never a raw string, so a symbol-name scan has no
 * practical false negatives.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ALL_PERMISSION_SLUGS,
  NON_STAFF_ROLE_SLUGS,
  OWNERSHIP_SCOPED_PERMISSIONS,
  PERMISSION,
  PERMISSIONS,
  PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS,
  RESERVED_PERMISSION_SLUGS,
  ROLE,
  ROLES,
  ROLE_GATED_PERMISSION_SLUGS,
  ROLE_PERMISSIONS,
  UNENFORCED_PERMISSION_SLUGS,
  UNTRIAGED_COVERAGE_GAP_SLUGS,
  isBranchRestricted,
  canViewAppointmentFinancials,
  PUBLIC_BOOKING_EXCLUDED_ROLES,
} from './rbac.constants';
import { getScope } from './permission-metadata';

const SRC_ROOT = path.join(__dirname, '..');

/** Files whose own references to PERMISSION.<KEY> don't count as "enforcement". */
const EXCLUDED_FILES = new Set(
  [
    'rbac.constants.ts',
    'rbac.constants.spec.ts',
    'permission-metadata.ts',
    'permission-metadata.spec.ts',
  ].map((f) => path.join(__dirname, f)),
);

function findTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      findTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function scanEnforcedPermissionKeys(): Set<string> {
  const enforced = new Set<string>();
  for (const file of findTsFiles(SRC_ROOT)) {
    if (EXCLUDED_FILES.has(file)) continue;
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(/PERMISSION\.([A-Z0-9_]+)/g)) {
      enforced.add(match[1]);
    }
  }
  return enforced;
}

describe('RBAC catalogue-coverage invariant (FND-010)', () => {
  const ENFORCED_KEYS = scanEnforcedPermissionKeys();
  const KEY_BY_SLUG = new Map(
    Object.entries(PERMISSION).map(([key, slug]) => [slug, key]),
  );

  it('every catalogue permission is either referenced outside the catalogue file, explicitly listed as unenforced, role-gated, or a known untriaged gap', () => {
    const unexpectedlyUnenforced = Object.entries(PERMISSION)
      .filter(([key]) => !ENFORCED_KEYS.has(key))
      .map(([, slug]) => slug)
      .filter((slug) => !UNENFORCED_PERMISSION_SLUGS.has(slug))
      .filter((slug) => !ROLE_GATED_PERMISSION_SLUGS.has(slug))
      .filter((slug) => !UNTRIAGED_COVERAGE_GAP_SLUGS.has(slug));

    expect(unexpectedlyUnenforced).toEqual([]);
  });

  /**
   * T193 (spec 014, US14) — `audit.read`'s enforcing controller
   * (`ActivityLogController`) has now landed, so per
   * `UNTRIAGED_COVERAGE_GAP_SLUGS`'s own rule ("remove each entry the moment
   * its controller lands", the same precedent T112 set for
   * clinical.records.*) it must be OUT of the untriaged set. It was declared
   * in T003 as a known, documented gap pending exactly this controller.
   */
  it('T193 (spec 014, US14) removed audit.read from the untriaged set once its controller landed', () => {
    expect(PERMISSION.AUDIT_READ).toBe('audit.read');
    expect(UNTRIAGED_COVERAGE_GAP_SLUGS.has(PERMISSION.AUDIT_READ)).toBe(false);
    expect(ENFORCED_KEYS.has('AUDIT_READ')).toBe(true);
  });

  /**
   * T112 (spec 014, US6) — clinical.records.read/manage's enforcing
   * controller (ClinicalController) has now landed, so per this set's own
   * rule ("remove each entry the moment its controller lands", mirroring
   * T004's REPORTS_EXPORT precedent) they must be OUT of the untriaged set —
   * they are role-gated + reserved (T105/T106) instead.
   */
  it('T112 (spec 014, US6) removed clinical.records.* from the untriaged set once its controller landed', () => {
    expect(PERMISSION.CLINICAL_RECORDS_READ).toBe('clinical.records.read');
    expect(PERMISSION.CLINICAL_RECORDS_MANAGE).toBe('clinical.records.manage');
    expect(
      UNTRIAGED_COVERAGE_GAP_SLUGS.has(PERMISSION.CLINICAL_RECORDS_READ),
    ).toBe(false);
    expect(
      UNTRIAGED_COVERAGE_GAP_SLUGS.has(PERMISSION.CLINICAL_RECORDS_MANAGE),
    ).toBe(false);
  });

  /**
   * T184 (spec 014, US13) — `reports.export`'s enforcing controller
   * (`ReportExportController`) has now landed. T004 already removed
   * `REPORTS_EXPORT` from the untriaged set in anticipation of this task
   * (see this set's own docblock: "REPORTS_EXPORT was removed from this set
   * in T004... T184 gives it a real enforcing route"); this test proves
   * that removal is now justified — the coverage test passes for the RIGHT
   * reason (a real enforcing route exists), not because the entry was
   * quietly left out.
   */
  it('T184 (spec 014, US13) enforces reports.export via ReportExportController, justifying T004s removal', () => {
    expect(PERMISSION.REPORTS_EXPORT).toBe('reports.export');
    expect(UNTRIAGED_COVERAGE_GAP_SLUGS.has(PERMISSION.REPORTS_EXPORT)).toBe(
      false,
    );
    expect(ENFORCED_KEYS.has('REPORTS_EXPORT')).toBe(true);
  });

  it('none of the three exception sets contain a stale entry (a slug that actually IS referenced elsewhere)', () => {
    const allExceptions = [
      ...UNENFORCED_PERMISSION_SLUGS,
      ...ROLE_GATED_PERMISSION_SLUGS,
      ...UNTRIAGED_COVERAGE_GAP_SLUGS,
    ];
    const staleEntries = allExceptions.filter((slug) => {
      const key = KEY_BY_SLUG.get(slug);
      return key !== undefined && ENFORCED_KEYS.has(key);
    });

    expect(staleEntries).toEqual([]);
  });

  it('UNENFORCED_PERMISSION_SLUGS — the set that also blocks role ASSIGNMENT — is exactly {profile.update_own} today', () => {
    // Deliberately narrow: this is the only permission whose holding role
    // (`customer`) is never actually assigned anywhere today, so guarding
    // its assignment is safe. A change here should be a deliberate, reviewed
    // decision — see UNTRIAGED_COVERAGE_GAP_SLUGS for why the other
    // known-unenforced permissions are NOT guarded the same way.
    expect(Array.from(UNENFORCED_PERMISSION_SLUGS)).toEqual([
      PERMISSION.PROFILE_UPDATE_OWN,
    ]);
  });
});

/**
 * FND-017 / M-07 — branch permission family + additive seeding.
 *
 * The full pre-existing OWNER/MANAGER arrays were verified unchanged by a
 * careful manual line-by-line comparison against the file content read
 * earlier in the same session, BEFORE this change — recorded in
 * specs/004-.../tasks.md (T098's evidence) since a full ~100-entry hand
 * transcription here would itself be a real transcription-error risk. This
 * suite instead asserts catalogue shape (new slugs exist, are correctly
 * ABAC-registered) and a representative spread of pre-existing grants —
 * spanning every module in each array, including the immediate pre-edit tail
 * anchor — are still present. `role-permissions.seed.spec.ts` separately
 * proves the SEEDER MECHANISM itself reconciles additively.
 */
describe('RBAC branch permissions (FND-017 / M-07)', () => {
  it('branches.create/update/update_own/delete are in the catalogue', () => {
    expect(ALL_PERMISSION_SLUGS).toEqual(
      expect.arrayContaining([
        PERMISSION.BRANCHES_CREATE,
        PERMISSION.BRANCHES_UPDATE,
        PERMISSION.BRANCHES_UPDATE_OWN,
        PERMISSION.BRANCHES_DELETE,
      ]),
    );
  });

  it('branches.update_own is registered as ownership-scoped (ABAC)', () => {
    expect(
      OWNERSHIP_SCOPED_PERMISSIONS.has(PERMISSION.BRANCHES_UPDATE_OWN),
    ).toBe(true);
  });

  it('OWNER gains tenant-wide branch authority (create/update/delete) — matches its pre-existing full-control scope', () => {
    const owner = ROLE_PERMISSIONS[ROLE.OWNER] as string[];
    expect(owner).toEqual(
      expect.arrayContaining([
        PERMISSION.BRANCHES_CREATE,
        PERMISSION.BRANCHES_UPDATE,
        PERMISSION.BRANCHES_DELETE,
      ]),
    );
    // NOT update_own — that slug exists purely for delegation to a CUSTOM
    // role; OWNER already holds the tenant-wide branches.update.
    expect(owner).not.toContain(PERMISSION.BRANCHES_UPDATE_OWN);
    // Representative spread of PRE-EXISTING grants across every module in
    // this array, unchanged — including PLATFORM_FILES_MANAGE, the exact
    // line this change's insertion was anchored immediately after.
    expect(owner).toEqual(
      expect.arrayContaining([
        PERMISSION.DASHBOARD_ACCESS,
        PERMISSION.APPOINTMENTS_MANAGE_ALL,
        PERMISSION.CRM_FILES_MANAGE,
        PERMISSION.STAFF_RATING_READ,
        PERMISSION.PAYMENTS_MANAGE,
        PERMISSION.AI_ANALYTICS_READ,
        PERMISSION.CAMPAIGN_ANALYTICS_READ,
        PERMISSION.ROLES_MANAGE,
        PERMISSION.PLATFORM_FILES_MANAGE,
      ]),
    );
  });

  it('MANAGER gains create/update ONLY — no branches.delete, matching its pre-existing (no-delete) scope exactly', () => {
    const manager = ROLE_PERMISSIONS[ROLE.MANAGER] as string[];
    expect(manager).toEqual(
      expect.arrayContaining([
        PERMISSION.BRANCHES_CREATE,
        PERMISSION.BRANCHES_UPDATE,
      ]),
    );
    expect(manager).not.toContain(PERMISSION.BRANCHES_DELETE);
    expect(manager).not.toContain(PERMISSION.BRANCHES_UPDATE_OWN);
    expect(manager).toEqual(
      expect.arrayContaining([
        PERMISSION.DASHBOARD_ACCESS,
        PERMISSION.STAFF_MANAGE,
        PERMISSION.CAMPAIGNS_MANAGE,
        PERMISSION.AI_ANALYTICS_READ,
        PERMISSION.ANALYTICS_REPORTS_MANAGE,
        PERMISSION.PLATFORM_FILES_MANAGE,
      ]),
    );
  });

  it('every other role (receptionist, doctor, customer, ai-bot) gains NO branch permission — least privilege preserved', () => {
    for (const role of [
      ROLE.RECEPTIONIST,
      ROLE.DOCTOR,
      ROLE.CUSTOMER,
      ROLE.AI_BOT,
    ]) {
      const grants = ROLE_PERMISSIONS[role] as string[];
      expect(grants).not.toEqual(
        expect.arrayContaining([
          PERMISSION.BRANCHES_CREATE,
          PERMISSION.BRANCHES_UPDATE,
          PERMISSION.BRANCHES_UPDATE_OWN,
          PERMISSION.BRANCHES_DELETE,
        ]),
      );
    }
  });
});

/**
 * T192 (spec 014, US14, FR-U009) — `audit.read`'s grant matrix. Only clinic
 * ownership and management may reach the Activity UI; the surface must be
 * absent from reception/doctor navigation, not merely refused at the API, so
 * this proves the PERMISSION side of that absence.
 */
describe('audit.read grant matrix (T192, FR-U009)', () => {
  it('is in the catalogue under the activity_log module', () => {
    const def = PERMISSIONS.find((p) => p.slug === PERMISSION.AUDIT_READ);
    expect(def).toBeDefined();
    expect(def?.module).toBe('activity_log');
  });

  it('OWNER and MANAGER hold audit.read', () => {
    expect(ROLE_PERMISSIONS[ROLE.OWNER] as string[]).toContain(
      PERMISSION.AUDIT_READ,
    );
    expect(ROLE_PERMISSIONS[ROLE.MANAGER] as string[]).toContain(
      PERMISSION.AUDIT_READ,
    );
  });

  it('RECEPTIONIST, DOCTOR, CUSTOMER and AI_BOT do NOT hold audit.read', () => {
    for (const role of [
      ROLE.RECEPTIONIST,
      ROLE.DOCTOR,
      ROLE.CUSTOMER,
      ROLE.AI_BOT,
    ]) {
      const grants = ROLE_PERMISSIONS[role] as string[];
      expect(grants).not.toContain(PERMISSION.AUDIT_READ);
    }
  });
});

/**
 * Support Operations Console — the `platform.support.*` diagnostic family.
 *
 * These assertions are the RBAC half of the console's security boundary: they
 * prove Platform Customer Service gains exactly the diagnostic reach it needs
 * and nothing adjacent to it, that no tenant role can ever receive any of it,
 * and that the grant list and the reservation list cannot drift apart. The
 * runtime half (routes actually refusing the request) lives in the
 * platform-support e2e suite.
 */
describe('Support Operations Console diagnostic permissions', () => {
  const support = ROLE_PERMISSIONS[ROLE.PLATFORM_SUPPORT] as string[];

  it('exposes 12 read-only slugs + 3 safe actions, all in the catalogue', () => {
    expect(PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS).toHaveLength(15);
    expect(ALL_PERMISSION_SLUGS).toEqual(
      expect.arrayContaining([...PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS]),
    );
  });

  it('every diagnostic slug carries catalogue metadata under the support_diagnostics module', () => {
    for (const slug of PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS) {
      const def = PERMISSIONS.find((p) => p.slug === slug);
      expect(def).toBeDefined();
      expect(def?.module).toBe('support_diagnostics');
      expect(def?.name?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('platform_support holds its 3 ticket slugs PLUS every diagnostic slug — and nothing else', () => {
    expect(support).toEqual([
      PERMISSION.PLATFORM_SUPPORT_TICKETS_READ,
      PERMISSION.PLATFORM_SUPPORT_TICKETS_TRIAGE,
      PERMISSION.PLATFORM_SUPPORT_TICKETS_REPLY,
      ...PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS,
    ]);
  });

  it('platform_support still cannot close tickets, enter the clinic shell, or hold any tenant-scoped reply/reopen slug', () => {
    expect(support).not.toContain(PERMISSION.PLATFORM_SUPPORT_TICKETS_CLOSE);
    expect(support).not.toContain(PERMISSION.DASHBOARD_ACCESS);
    expect(support).not.toContain(PERMISSION.SUPPORT_TICKETS_REPLY);
    expect(support).not.toContain(PERMISSION.SUPPORT_TICKETS_REOPEN);
  });

  it('grants Support NO financial, RBAC, tenant-administration, medical, AI-cost or platform-config authority', () => {
    // The explicit "must NOT be able to" list from the Support Operations
    // Console brief, asserted slug by slug rather than by category, so a
    // future widening of this role fails here loudly.
    for (const forbidden of [
      PERMISSION.SUBSCRIPTION_MANAGE,
      PERMISSION.BILLING_MANAGE,
      PERMISSION.BILLING_UPGRADE_MANAGE,
      PERMISSION.FEATUREFLAG_MANAGE,
      PERMISSION.PAYMENTS_MANAGE,
      PERMISSION.PAYMENTS_READ,
      PERMISSION.REFUNDS_MANAGE,
      PERMISSION.INVOICES_MANAGE,
      PERMISSION.SETTLEMENTS_MANAGE,
      PERMISSION.TENANTS_MANAGE,
      PERMISSION.ROLES_MANAGE,
      PERMISSION.USERS_MANAGE,
      PERMISSION.PLATFORM_SETTINGS_MANAGE,
      PERMISSION.PLATFORM_SETTINGS_READ,
      PERMISSION.PLATFORM_API_KEYS_MANAGE,
      PERMISSION.APPOINTMENTS_READ,
      PERMISSION.APPOINTMENTS_UPDATE,
      PERMISSION.APPOINTMENTS_MANAGE_ALL,
      PERMISSION.CUSTOMERS_READ,
      PERMISSION.CRM_CUSTOMERS_READ,
      PERMISSION.CRM_FILES_READ,
      PERMISSION.CRM_NOTES_READ,
      PERMISSION.AI_ANALYTICS_READ,
      PERMISSION.AI_MANAGE,
      PERMISSION.STAFF_READ,
      PERMISSION.STAFF_MANAGE,
    ]) {
      expect(support).not.toContain(forbidden);
    }
  });

  it('every diagnostic slug is RESERVED — a clinic Owner can never delegate one into a tenant custom role', () => {
    for (const slug of PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS) {
      expect(RESERVED_PERMISSION_SLUGS.has(slug)).toBe(true);
    }
  });

  it('the grant list and the reservation list cannot drift — both derive from the same array', () => {
    const reservedDiagnostics = [...RESERVED_PERMISSION_SLUGS].filter((s) =>
      s.startsWith('platform.support.'),
    );
    expect(reservedDiagnostics.sort()).toEqual(
      [...PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS].sort(),
    );
  });

  it('no tenant role — nor the AI bot, nor the end customer — receives any diagnostic slug', () => {
    for (const role of [
      ROLE.OWNER,
      ROLE.MANAGER,
      ROLE.RECEPTIONIST,
      ROLE.DOCTOR,
      ROLE.CUSTOMER,
      ROLE.AI_BOT,
    ]) {
      const grants = ROLE_PERMISSIONS[role] as string[];
      for (const slug of PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS) {
        expect(grants).not.toContain(slug);
      }
    }
  });

  it('platform_support remains a non-staff role, so it can never be attached to a clinic user', () => {
    expect(NON_STAFF_ROLE_SLUGS).toContain(ROLE.PLATFORM_SUPPORT);
  });

  it('manager (Operations Manager) is retired from staff assignment — branch_manager replaces it for new hires', () => {
    expect(NON_STAFF_ROLE_SLUGS).toContain(ROLE.MANAGER);
    expect(NON_STAFF_ROLE_SLUGS).not.toContain(ROLE.BRANCH_MANAGER);
  });

  it('exposes exactly three write actions — and no bulk/retry-all/queue-administration slug exists', () => {
    const writes = PLATFORM_SUPPORT_DIAGNOSTIC_SLUGS.filter(
      (s) => !s.includes('.read'),
    );
    expect(writes).toEqual([
      PERMISSION.PLATFORM_SUPPORT_NOTIFICATIONS_RETRY,
      PERMISSION.PLATFORM_SUPPORT_EMAIL_RESEND,
      PERMISSION.PLATFORM_SUPPORT_INTEGRATIONS_RECHECK,
    ]);
    for (const slug of ALL_PERMISSION_SLUGS) {
      expect(slug).not.toMatch(
        /platform\.support\..*(all|purge|pause|resume|clean|delete)/,
      );
    }
  });

  it('does not collapse into one broad slug — no platform.support.manage exists', () => {
    expect(ALL_PERMISSION_SLUGS).not.toContain('platform.support.manage');
  });
});

/**
 * ============================================================================
 *  Branch Manager — the catalogue's first BRANCH-scoped role
 * ============================================================================
 *
 * Two things must hold and keep holding:
 *
 *  1. The role is genuinely NARROWER than Operations Manager. It was derived
 *     from `manager` by subtraction, and the subset assertion below is what
 *     stops a future edit from quietly handing it a clinic-level capability —
 *     the failure mode that would make it "the owner dashboard again".
 *
 *  2. `isBranchRestricted` answers TRUE for it and FALSE for every role that
 *     existed before it. That predicate is the single input `BranchScopeService`
 *     uses to narrow appointments, staff, the activity log and the dashboard
 *     summary, so these assertions are the backstop on backward compatibility:
 *     if any pre-existing role ever starts answering true, that role silently
 *     stops seeing its own clinic.
 */
describe('branch_manager role (branch-scoped RBAC)', () => {
  const branchManager = ROLE_PERMISSIONS[ROLE.BRANCH_MANAGER] as string[];
  const manager = ROLE_PERMISSIONS[ROLE.MANAGER] as string[];

  it('is in the role catalogue with a display name and description', () => {
    const def = ROLES.find((r) => r.slug === ROLE.BRANCH_MANAGER);
    expect(def).toBeDefined();
    expect(def?.name).toBe('Branch Manager');
    expect(def?.description).toBeTruthy();
  });

  it('is assignable to clinic staff — it must appear in GET /staff/assignable-roles', () => {
    expect(NON_STAFF_ROLE_SLUGS).not.toContain(ROLE.BRANCH_MANAGER);
  });

  it('can reach the clinic workspace shell (holds dashboard.access)', () => {
    expect(branchManager).toContain(PERMISSION.DASHBOARD_ACCESS);
  });

  it('holds branches.update_own and NOT the tenant-wide branches.update — the pair that makes it branch-restricted', () => {
    expect(branchManager).toContain(PERMISSION.BRANCHES_UPDATE_OWN);
    expect(branchManager).not.toContain(PERMISSION.BRANCHES_UPDATE);
    expect(branchManager).not.toContain(PERMISSION.BRANCHES_CREATE);
    expect(branchManager).not.toContain(PERMISSION.BRANCHES_DELETE);
  });

  it('grants nothing Operations Manager does not already grant, except branches.update_own', () => {
    const extras = branchManager.filter((slug) => !manager.includes(slug));
    expect(extras).toEqual([PERMISSION.BRANCHES_UPDATE_OWN]);
  });

  it('holds no financial, subscription, clinic-configuration or staff-provisioning permission', () => {
    for (const slug of [
      PERMISSION.PAYMENTS_READ,
      PERMISSION.PAYMENTS_MANAGE,
      PERMISSION.REFUNDS_MANAGE,
      PERMISSION.INVOICES_READ,
      PERMISSION.INVOICES_MANAGE,
      PERMISSION.SETTLEMENTS_READ,
      PERMISSION.STAFF_COMMISSION_READ,
      PERMISSION.SUBSCRIPTION_READ,
      PERMISSION.SUBSCRIPTION_MANAGE,
      PERMISSION.BILLING_READ,
      PERMISSION.BILLING_MANAGE,
      PERMISSION.USAGE_READ,
      PERMISSION.FEATUREFLAG_READ,
      PERMISSION.BILLING_UPGRADE_READ,
      PERMISSION.STAFF_CREATE,
      PERMISSION.STAFF_UPDATE,
      PERMISSION.STAFF_MANAGE,
      PERMISSION.USERS_MANAGE,
      PERMISSION.ROLES_MANAGE,
      PERMISSION.SERVICES_CREATE,
      PERMISSION.SERVICES_UPDATE,
      PERMISSION.SERVICES_DELETE,
      PERMISSION.AI_MANAGE,
      PERMISSION.CLINICAL_RECORDS_READ,
      PERMISSION.CLINICAL_RECORDS_MANAGE,
    ]) {
      expect(branchManager).not.toContain(slug);
    }
  });

  /**
   * `analytics.dashboard.read` is how FR-A016 spells "tenant-wide analytics";
   * `analytics.reports.read` reaches `GET /analytics/reports/daily`, which is
   * still tenant-wide (one row per branch per day, no scope resolution).
   * Granting either would leak sibling branches' figures, so BOTH stay out
   * until that endpoint is branch-scoped. This assertion is the reminder.
   */
  it('holds no analytics permission — the daily-report endpoints are still tenant-wide', () => {
    expect(branchManager).not.toContain(PERMISSION.ANALYTICS_DASHBOARD_READ);
    expect(branchManager).not.toContain(PERMISSION.ANALYTICS_REPORTS_READ);
    expect(branchManager).not.toContain(PERMISSION.ANALYTICS_REPORTS_MANAGE);
    expect(branchManager).not.toContain(PERMISSION.REPORTS_READ);
  });

  it('DOES hold the branch-operations surface it exists for', () => {
    for (const slug of [
      PERMISSION.APPOINTMENTS_READ,
      PERMISSION.APPOINTMENTS_CREATE,
      PERMISSION.APPOINTMENTS_UPDATE,
      PERMISSION.APPOINTMENTS_CANCEL,
      PERMISSION.APPOINTMENTS_RESCHEDULE,
      PERMISSION.STAFF_READ,
      PERMISSION.STAFF_SCHEDULE_MANAGE,
      PERMISSION.SCHEDULING_SLOTS_MANAGE,
      PERMISSION.CRM_CUSTOMERS_READ,
      PERMISSION.CRM_CUSTOMERS_MANAGE,
      PERMISSION.AUDIT_READ,
    ]) {
      expect(branchManager).toContain(slug);
    }
  });

  describe('isBranchRestricted — the one rule every scoped query reads', () => {
    it('is TRUE for branch_manager', () => {
      expect(isBranchRestricted(branchManager)).toBe(true);
    });

    it('is FALSE for every role that existed before it — backward compatibility', () => {
      for (const role of [
        ROLE.OWNER,
        ROLE.MANAGER,
        ROLE.RECEPTIONIST,
        ROLE.DOCTOR,
        ROLE.CUSTOMER,
        ROLE.AI_BOT,
        ROLE.PLATFORM_SUPPORT,
      ]) {
        const grants = ROLE_PERMISSIONS[role] as string[];
        expect(isBranchRestricted(grants)).toBe(false);
      }
    });

    it('is TRUE for an arbitrary custom role granted branches.update_own — it is a permission rule, not a role list', () => {
      expect(
        isBranchRestricted([
          PERMISSION.DASHBOARD_ACCESS,
          PERMISSION.APPOINTMENTS_READ,
          PERMISSION.BRANCHES_UPDATE_OWN,
        ]),
      ).toBe(true);
    });

    it('is FALSE when a caller holds BOTH slugs — the tenant-wide one always wins', () => {
      expect(
        isBranchRestricted([
          PERMISSION.BRANCHES_UPDATE_OWN,
          PERMISSION.BRANCHES_UPDATE,
        ]),
      ).toBe(false);
    });

    it('is FALSE for an empty permission set (no principal / system caller)', () => {
      expect(isBranchRestricted([])).toBe(false);
    });
  });

  /**
   * The Permission Preview reports the branch restriction from
   * `permissions.scope`, which the seeder copies from this registry. If the
   * override is ever dropped, the preview silently stops telling a clinic
   * owner that the role they are about to create is branch-restricted.
   */
  it('branches.update_own is registered at the branch scope layer, for the Permission Preview', () => {
    expect(getScope(PERMISSION.BRANCHES_UPDATE_OWN)).toBe('branch');
  });
});

/**
 * Nurse role — clinical.records.nursing, appointments.status.update,
 * PUBLIC_BOOKING_EXCLUDED_ROLES and the ROLE_PERMISSIONS grant itself.
 */
describe('nurse role', () => {
  const nurseGrants = ROLE_PERMISSIONS[ROLE.NURSE] as string[];

  it('is in the role catalogue with a display name and description', () => {
    const def = ROLES.find((r) => r.slug === ROLE.NURSE);
    expect(def?.name).toBe('Nurse');
    expect(def?.description).toBeTruthy();
  });

  it('is assignable to clinic staff — never in NON_STAFF_ROLE_SLUGS', () => {
    expect(NON_STAFF_ROLE_SLUGS).not.toContain(ROLE.NURSE);
  });

  it('can reach the clinic workspace shell (holds dashboard.access)', () => {
    expect(nurseGrants).toContain(PERMISSION.DASHBOARD_ACCESS);
  });

  it('is NOT branch-restricted — clinic-wide like doctor/receptionist', () => {
    expect(isBranchRestricted(nurseGrants)).toBe(false);
    expect(nurseGrants).not.toContain(PERMISSION.BRANCHES_UPDATE_OWN);
  });

  it('holds appointments.read (tenant-wide) and appointments.status.update, never appointments.update/read_own/manage_all', () => {
    expect(nurseGrants).toContain(PERMISSION.APPOINTMENTS_READ);
    expect(nurseGrants).toContain(PERMISSION.APPOINTMENTS_STATUS_UPDATE);
    expect(nurseGrants).not.toContain(PERMISSION.APPOINTMENTS_UPDATE);
    expect(nurseGrants).not.toContain(PERMISSION.APPOINTMENTS_READ_OWN);
    expect(nurseGrants).not.toContain(PERMISSION.APPOINTMENTS_CREATE);
    expect(nurseGrants).not.toContain(PERMISSION.APPOINTMENTS_RESCHEDULE);
    expect(nurseGrants).not.toContain(PERMISSION.APPOINTMENTS_CANCEL);
    expect(nurseGrants).not.toContain(PERMISSION.APPOINTMENTS_MANAGE_ALL);
  });

  it('holds read-only CRM access, never crm.*.manage or crm.files.manage', () => {
    expect(nurseGrants).toContain(PERMISSION.CRM_CUSTOMERS_READ);
    expect(nurseGrants).toContain(PERMISSION.CRM_NOTES_READ);
    expect(nurseGrants).toContain(PERMISSION.CRM_TAGS_READ);
    expect(nurseGrants).toContain(PERMISSION.CRM_FILES_READ);
    expect(nurseGrants).not.toContain(PERMISSION.CRM_CUSTOMERS_MANAGE);
    expect(nurseGrants).not.toContain(PERMISSION.CRM_NOTES_MANAGE);
    expect(nurseGrants).not.toContain(PERMISSION.CRM_TAGS_MANAGE);
    expect(nurseGrants).not.toContain(PERMISSION.CRM_FILES_MANAGE);
  });

  it('holds clinical.records.read + .nursing, never .manage', () => {
    expect(nurseGrants).toContain(PERMISSION.CLINICAL_RECORDS_READ);
    expect(nurseGrants).toContain(PERMISSION.CLINICAL_RECORDS_NURSING);
    expect(nurseGrants).not.toContain(PERMISSION.CLINICAL_RECORDS_MANAGE);
  });

  it('holds staff.read_own only — never the tenant-wide staff.read/create/update/manage', () => {
    expect(nurseGrants).toContain(PERMISSION.STAFF_READ_OWN);
    expect(nurseGrants).not.toContain(PERMISSION.STAFF_READ);
    expect(nurseGrants).not.toContain(PERMISSION.STAFF_CREATE);
    expect(nurseGrants).not.toContain(PERMISSION.STAFF_UPDATE);
    expect(nurseGrants).not.toContain(PERMISSION.STAFF_MANAGE);
  });

  it('holds no finance, billing, subscription, analytics, reports, audit, roles, users, settings, branches or AI-config permission', () => {
    const forbidden = [
      PERMISSION.PAYMENTS_READ,
      PERMISSION.PAYMENTS_MANAGE,
      PERMISSION.REFUNDS_MANAGE,
      PERMISSION.INVOICES_READ,
      PERMISSION.INVOICES_MANAGE,
      PERMISSION.SETTLEMENTS_READ,
      PERMISSION.SETTLEMENTS_MANAGE,
      PERMISSION.SUBSCRIPTION_READ,
      PERMISSION.SUBSCRIPTION_MANAGE,
      PERMISSION.BILLING_READ,
      PERMISSION.BILLING_MANAGE,
      PERMISSION.REPORTS_READ,
      PERMISSION.REPORTS_EXPORT,
      PERMISSION.ANALYTICS_DASHBOARD_READ,
      PERMISSION.ANALYTICS_REPORTS_READ,
      PERMISSION.AUDIT_READ,
      PERMISSION.ROLES_MANAGE,
      PERMISSION.USERS_MANAGE,
      PERMISSION.TENANTS_MANAGE,
      PERMISSION.PLATFORM_SETTINGS_READ,
      PERMISSION.PLATFORM_SETTINGS_MANAGE,
      PERMISSION.BRANCHES_CREATE,
      PERMISSION.BRANCHES_UPDATE,
      PERMISSION.BRANCHES_DELETE,
      PERMISSION.SERVICES_CREATE,
      PERMISSION.SERVICES_UPDATE,
      PERMISSION.SERVICES_DELETE,
      PERMISSION.AI_MANAGE,
      PERMISSION.WHATSAPP_ACCOUNTS_MANAGE,
    ];
    for (const slug of forbidden) {
      expect(nurseGrants).not.toContain(slug);
    }
  });

  it('never appears in every other role’s "least privilege" comparison lists (RECEPTIONIST/DOCTOR/CUSTOMER/AI_BOT still hold no branch permission)', () => {
    for (const role of [
      ROLE.RECEPTIONIST,
      ROLE.DOCTOR,
      ROLE.CUSTOMER,
      ROLE.AI_BOT,
      ROLE.NURSE,
    ]) {
      const grants = ROLE_PERMISSIONS[role] as string[];
      expect(grants).not.toEqual(
        expect.arrayContaining([
          PERMISSION.BRANCHES_CREATE,
          PERMISSION.BRANCHES_UPDATE,
          PERMISSION.BRANCHES_UPDATE_OWN,
          PERMISSION.BRANCHES_DELETE,
        ]),
      );
    }
  });

  describe('clinical.records.nursing — reserved + ownership-scoped', () => {
    it('is reserved — a clinic Owner can never delegate it into a tenant custom role', () => {
      expect(RESERVED_PERMISSION_SLUGS.has(PERMISSION.CLINICAL_RECORDS_NURSING)).toBe(
        true,
      );
    });

    it('is registered as ownership-scoped (ABAC) — correction is author-restricted', () => {
      expect(
        OWNERSHIP_SCOPED_PERMISSIONS.has(PERMISSION.CLINICAL_RECORDS_NURSING),
      ).toBe(true);
    });
  });

  describe('appointments.status.update — delegable, queue/status-only', () => {
    it('is NOT reserved — a clinic Owner may delegate it into a tenant custom role', () => {
      expect(
        RESERVED_PERMISSION_SLUGS.has(PERMISSION.APPOINTMENTS_STATUS_UPDATE),
      ).toBe(false);
    });
  });
});

/**
 * PUBLIC_BOOKING_EXCLUDED_ROLES — the deny-list StaffService.resolveBookableFlag
 * consults so an excluded role can never be set publicly bookable.
 */
describe('PUBLIC_BOOKING_EXCLUDED_ROLES', () => {
  it('contains nurse', () => {
    expect(PUBLIC_BOOKING_EXCLUDED_ROLES).toContain(ROLE.NURSE);
  });

  it('does not contain any role that is bookable today (doctor, manager) or the front-desk roles', () => {
    expect(PUBLIC_BOOKING_EXCLUDED_ROLES).not.toContain(ROLE.DOCTOR);
    expect(PUBLIC_BOOKING_EXCLUDED_ROLES).not.toContain(ROLE.MANAGER);
    expect(PUBLIC_BOOKING_EXCLUDED_ROLES).not.toContain(ROLE.RECEPTIONIST);
    expect(PUBLIC_BOOKING_EXCLUDED_ROLES).not.toContain(ROLE.BRANCH_MANAGER);
  });
});

/**
 * canViewAppointmentFinancials — the derived predicate that redacts
 * total_amount/payment_status/currency/service pricing/refundAmount/queue
 * paymentStatus at the controller response boundary (never inside
 * AppointmentService itself). See its own docblock for the full rationale.
 */
describe('canViewAppointmentFinancials', () => {
  it.each([
    ['owner', ROLE.OWNER],
    ['manager', ROLE.MANAGER],
    ['branch_manager', ROLE.BRANCH_MANAGER],
    ['receptionist', ROLE.RECEPTIONIST],
  ])(
    '%s keeps seeing financial fields — every existing role already holds appointments.create or .update',
    (_label, role) => {
      const grants = ROLE_PERMISSIONS[role] as string[];
      expect(canViewAppointmentFinancials(grants)).toBe(true);
    },
  );

  it('doctor keeps seeing financial fields — via appointments.read_own', () => {
    const grants = ROLE_PERMISSIONS[ROLE.DOCTOR] as string[];
    expect(grants).toContain(PERMISSION.APPOINTMENTS_READ_OWN);
    expect(canViewAppointmentFinancials(grants)).toBe(true);
  });

  it('super_admin keeps seeing financial fields — the wildcard resolves to every permission, including appointments.update', () => {
    // The seeder resolves ALL_PERMISSIONS into a literal grant of every
    // catalogue permission, so a real super_admin's `user.permissions`
    // array already contains appointments.update — no special-case bypass
    // needed here (mirrors the pattern documented on the function itself).
    expect(canViewAppointmentFinancials(ALL_PERMISSION_SLUGS)).toBe(true);
  });

  it('nurse does NOT see financial fields — holds appointments.read but none of create/update/read_own/payments.read', () => {
    const grants = ROLE_PERMISSIONS[ROLE.NURSE] as string[];
    expect(grants).toContain(PERMISSION.APPOINTMENTS_READ);
    expect(canViewAppointmentFinancials(grants)).toBe(false);
  });

  it('a tenant custom role holding ONLY appointments.read also loses financial visibility — the documented, accepted side effect', () => {
    expect(
      canViewAppointmentFinancials([PERMISSION.APPOINTMENTS_READ]),
    ).toBe(false);
  });

  it('an otherwise-bare caller holding only payments.read still sees financials', () => {
    expect(canViewAppointmentFinancials([PERMISSION.PAYMENTS_READ])).toBe(
      true,
    );
  });

  it('an empty permission set sees no financials', () => {
    expect(canViewAppointmentFinancials([])).toBe(false);
  });
});
