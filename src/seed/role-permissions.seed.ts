import { EntityManager, IsNull } from 'typeorm';
import { Permission } from '../entities/Auth&RBAC/Permission';
import { Role } from '../entities/Auth&RBAC/Role';
import { RolePermission } from '../entities/Auth&RBAC/RolePermission';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../rbac/rbac.constants';
import { logger } from './seed.logger';

/**
 * Reconciles each system role's permissions to EXACTLY the set declared in
 * ROLE_PERMISSIONS: missing grants are added, stale grants are removed. This
 * makes the mapping authoritative and the seeder safe to re-run.
 */
export async function seedRolePermissions(manager: EntityManager): Promise<void> {
  logger.step('Seeding role → permission mappings');

  const roleRepo = manager.getRepository(Role);
  const permRepo = manager.getRepository(Permission);
  const rpRepo = manager.getRepository(RolePermission);

  // Resolve the full catalogue once (needed for the "*" / super_admin mapping).
  const allPermissions = await permRepo.find();
  const permBySlug = new Map(allPermissions.map((p) => [p.slug, p]));

  for (const [roleSlug, mapping] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await roleRepo.findOne({
      where: { slug: roleSlug, tenant: IsNull() },
    });
    if (!role) {
      logger.warn(`role "${roleSlug}" not found — run roles seed first; skipping`);
      continue;
    }

    // Desired permission set.
    const desired =
      mapping === ALL_PERMISSIONS
        ? allPermissions
        : mapping.map((slug) => {
            const perm = permBySlug.get(slug);
            if (!perm) {
              throw new Error(
                `Permission "${slug}" referenced by role "${roleSlug}" is not in the catalogue`,
              );
            }
            return perm;
          });
    const desiredIds = new Set(desired.map((p) => p.id));

    // Current state.
    const current = await rpRepo.find({
      where: { role: { id: role.id } },
      relations: { permission: true },
    });
    const currentIds = new Set(current.map((rp) => rp.permission.id));

    // Add missing.
    const toAdd = desired.filter((p) => !currentIds.has(p.id));
    if (toAdd.length) {
      await rpRepo.save(
        toAdd.map((permission) => rpRepo.create({ role, permission })),
      );
    }

    // Remove stale.
    const toRemove = current.filter((rp) => !desiredIds.has(rp.permission.id));
    if (toRemove.length) {
      await rpRepo.remove(toRemove);
    }

    logger.success(
      `${roleSlug}: +${toAdd.length} / -${toRemove.length} → ${desired.length} permissions`,
    );
  }
}
