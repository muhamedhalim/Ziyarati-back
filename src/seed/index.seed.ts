import { DataSource } from 'typeorm';
import { seedPermissions } from './permissions.seed';
import { seedRoles } from './roles.seed';
import { seedRolePermissions } from './role-permissions.seed';
import { seedAdminUser } from './admin.seed';

/**
 * Runs all seeders in dependency order:
 *   permissions → roles → role/permission mapping → admin user.
 * The whole run executes inside a single transaction, so any failure rolls the
 * database back to its prior state.
 */
export async function runSeeders(ds: DataSource): Promise<void> {
  await ds.transaction(async (manager) => {
    await seedPermissions(manager);
    await seedRoles(manager);
    await seedRolePermissions(manager);
    await seedAdminUser(manager);
  });
}
