import { EntityManager } from 'typeorm';
import { Permission } from '../entities/Auth&RBAC/Permission';
import { PERMISSIONS } from '../rbac/rbac.constants';
import { logger } from './seed.logger';

/**
 * Upserts the global permission catalogue by slug. Idempotent: existing
 * permissions are updated in place (name/module), new ones are inserted.
 */
export async function seedPermissions(manager: EntityManager): Promise<void> {
  logger.step('Seeding permissions');
  const repo = manager.getRepository(Permission);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const def of PERMISSIONS) {
    const existing = await repo.findOne({ where: { slug: def.slug } });

    if (!existing) {
      await repo.save(repo.create(def));
      created++;
      continue;
    }

    if (existing.name !== def.name || existing.module !== def.module) {
      existing.name = def.name;
      existing.module = def.module;
      await repo.save(existing);
      updated++;
    } else {
      unchanged++;
    }
  }

  logger.success(
    `Permissions: ${created} created, ${updated} updated, ${unchanged} unchanged (${PERMISSIONS.length} total)`,
  );
}
