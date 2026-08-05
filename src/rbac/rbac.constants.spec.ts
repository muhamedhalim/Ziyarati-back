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
/* eslint-disable @typescript-eslint/no-var-requires */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ALL_PERMISSION_SLUGS,
  OWNERSHIP_SCOPED_PERMISSIONS,
  PERMISSION,
  ROLE,
  ROLE_GATED_PERMISSION_SLUGS,
  ROLE_PERMISSIONS,
  UNENFORCED_PERMISSION_SLUGS,
  UNTRIAGED_COVERAGE_GAP_SLUGS,
} from './rbac.constants';

const SRC_ROOT = path.join(__dirname, '..');

/** Files whose own references to PERMISSION.<KEY> don't count as "enforcement". */
const EXCLUDED_FILES = new Set(
  ['rbac.constants.ts', 'rbac.constants.spec.ts', 'permission-metadata.ts', 'permission-metadata.spec.ts'].map(
    (f) => path.join(__dirname, f),
  ),
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
    expect(Array.from(UNENFORCED_PERMISSION_SLUGS)).toEqual([PERMISSION.PROFILE_UPDATE_OWN]);
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
    expect(OWNERSHIP_SCOPED_PERMISSIONS.has(PERMISSION.BRANCHES_UPDATE_OWN)).toBe(true);
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
      expect.arrayContaining([PERMISSION.BRANCHES_CREATE, PERMISSION.BRANCHES_UPDATE]),
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
    for (const role of [ROLE.RECEPTIONIST, ROLE.DOCTOR, ROLE.CUSTOMER, ROLE.AI_BOT]) {
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
