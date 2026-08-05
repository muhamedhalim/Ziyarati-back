import { seedRolePermissions } from './role-permissions.seed';
import { PERMISSION, ROLE, ROLE_PERMISSIONS } from '../rbac/rbac.constants';

function fakePermission(slug: string) {
  return { id: `perm-${slug}`, slug };
}

/**
 * M-07 / FND-017 — proves `seedRolePermissions`'s reconciliation is additive
 * for the OWNER/MANAGER branch-permission grants added in this change: given
 * the role's CURRENT stored grants are exactly what they were before this
 * change (i.e. today's desired set minus the new `branches.*` slugs — the
 * real state of any already-deployed database), reconciling to the new
 * desired set must add exactly the new slugs and remove nothing.
 *
 * `roleRepo.findOne` returns `null` for every role except OWNER, so the
 * seeder's own pre-existing "role not found — skip" branch narrows the run
 * to one role without needing to touch the real (much larger) ROLE_PERMISSIONS
 * map or any global built-in.
 */
describe('seedRolePermissions — additive reconciliation (M-07)', () => {
  function buildManagerMock(allSlugs: string[], currentSlugs: string[]) {
    const allPermissionRows = allSlugs.map(fakePermission);
    const permBySlug = new Map(allPermissionRows.map((p) => [p.slug, p]));

    const currentRolePermissionRows = currentSlugs.map((slug) => ({
      permission: permBySlug.get(slug)!,
    }));

    const roleRepo = {
      findOne: jest.fn(({ where }: { where: { slug: string } }) =>
        where.slug === ROLE.OWNER ? { id: 'role-owner', slug: ROLE.OWNER } : null,
      ),
    };
    const permRepo = { find: jest.fn().mockResolvedValue(allPermissionRows) };
    const rpRepo = {
      find: jest.fn().mockResolvedValue(currentRolePermissionRows),
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((v: unknown) => v),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      getRepository: jest.fn((entity: { name: string }) => {
        if (entity.name === 'Role') return roleRepo;
        if (entity.name === 'Permission') return permRepo;
        return rpRepo;
      }),
    };
    return { manager, rpRepo };
  }

  it('adds the new branches.* grants and removes nothing for OWNER, whose other stored grants match the pre-change baseline', async () => {
    const desired = ROLE_PERMISSIONS[ROLE.OWNER] as string[];
    const branchSlugs = [
      PERMISSION.BRANCHES_CREATE,
      PERMISSION.BRANCHES_UPDATE,
      PERMISSION.BRANCHES_DELETE,
    ];
    // Simulates the real pre-existing DB state: everything OWNER holds
    // today, MINUS the branch permissions this change adds.
    const baselineBeforeThisChange = desired.filter((s) => !branchSlugs.includes(s as never));

    const { manager, rpRepo } = buildManagerMock(desired, baselineBeforeThisChange);

    await seedRolePermissions(manager as never);

    expect(rpRepo.remove).not.toHaveBeenCalled();
    const savedRows = (rpRepo.save as jest.Mock).mock.calls[0]?.[0] as Array<{
      permission: { slug: string };
    }>;
    const savedSlugs = savedRows.map((row) => row.permission.slug);
    expect(new Set(savedSlugs)).toEqual(new Set(branchSlugs));
  });

  it('removes a grant that is no longer desired (reconciliation is two-way, not additive-only by accident)', async () => {
    const currentSlugs = [PERMISSION.DASHBOARD_ACCESS, PERMISSION.STAFF_MANAGE];
    const { manager, rpRepo } = buildManagerMock(currentSlugs, currentSlugs);

    // Temporarily present a narrower desired mapping (DASHBOARD_ACCESS only)
    // for OWNER, proving the reconciler removes a grant that drops out of
    // ROLE_PERMISSIONS — the mirror case to the additive proof above.
    const original = ROLE_PERMISSIONS[ROLE.OWNER];
    (ROLE_PERMISSIONS as Record<string, string[] | typeof original>)[ROLE.OWNER] = [
      PERMISSION.DASHBOARD_ACCESS,
    ];
    try {
      await seedRolePermissions(manager as never);
    } finally {
      (ROLE_PERMISSIONS as Record<string, string[] | typeof original>)[ROLE.OWNER] = original;
    }

    expect(rpRepo.remove).toHaveBeenCalledTimes(1);
    const removed = (rpRepo.remove as jest.Mock).mock.calls[0][0];
    expect(removed).toHaveLength(1);
    expect(removed[0].permission.slug).toBe(PERMISSION.STAFF_MANAGE);
  });
});
