import { EntityManager } from 'typeorm';
import { Permission } from '../entities/Auth&RBAC/Permission';
import { PERMISSIONS } from '../rbac/rbac.constants';
import { getPermissionMetadata } from '../rbac/permission-metadata';
import { logger } from './seed.logger';

/**
 * Upserts the global permission catalogue by slug. Idempotent: existing
 * permissions are updated in place (name/module + audit metadata), new ones are
 * inserted. Audit metadata (description/scope/risk_level/is_deprecated) is
 * reconciled from the deterministic metadata registry so the persisted rows
 * always match the reviewed classification.
 */
export async function seedPermissions(manager: EntityManager): Promise<void> {
  logger.step('Seeding permissions');
  const repo = manager.getRepository(Permission);

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const def of PERMISSIONS) {
    const meta = getPermissionMetadata(def.slug);
    const existing = await repo.findOne({ where: { slug: def.slug } });

    if (!existing) {
      await repo.save(
        repo.create({
          name: def.name,
          slug: def.slug,
          module: def.module,
          description: meta.description,
          scope: meta.scope,
          risk_level: meta.risk,
          is_deprecated: meta.deprecated,
        }),
      );
      created++;
      continue;
    }

    const changed =
      existing.name !== def.name ||
      existing.module !== def.module ||
      (existing.description ?? null) !== meta.description ||
      existing.scope !== meta.scope ||
      existing.risk_level !== meta.risk ||
      existing.is_deprecated !== meta.deprecated;

    if (changed) {
      existing.name = def.name;
      existing.module = def.module;
      existing.description = meta.description;
      existing.scope = meta.scope;
      existing.risk_level = meta.risk;
      existing.is_deprecated = meta.deprecated;
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
