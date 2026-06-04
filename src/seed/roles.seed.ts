import { EntityManager, IsNull } from 'typeorm';
import { Role } from '../entities/Auth&RBAC/Role';
import { ROLES } from '../rbac/rbac.constants';
import { logger } from './seed.logger';

/**
 * Seeds the five platform roles as *system* roles: `tenant = NULL` and
 * `is_system = true`, so they are shared/reusable across every tenant.
 * Idempotent — matched by (slug, tenant IS NULL).
 */
export async function seedRoles(manager: EntityManager): Promise<void> {
  logger.step('Seeding roles');
  const repo = manager.getRepository(Role);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const def of ROLES) {
    const existing = await repo.findOne({
      where: { slug: def.slug, tenant: IsNull() },
    });

    if (!existing) {
      await repo.save(
        repo.create({
          slug: def.slug,
          name: def.name,
          description: def.description,
          is_system: true,
        }),
      );
      created++;
      logger.info(`created role "${def.slug}"`);
      continue;
    }

    if (
      existing.name !== def.name ||
      existing.description !== def.description ||
      !existing.is_system
    ) {
      existing.name = def.name;
      existing.description = def.description;
      existing.is_system = true;
      await repo.save(existing);
      updated++;
    } else {
      unchanged++;
    }
  }

  logger.success(
    `Roles: ${created} created, ${updated} updated, ${unchanged} unchanged (${ROLES.length} total)`,
  );
}
