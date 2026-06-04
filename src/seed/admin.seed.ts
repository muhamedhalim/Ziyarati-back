import { EntityManager, IsNull } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Role } from '../entities/Auth&RBAC/Role';
import { User } from '../entities/Auth&RBAC/User';
import { UserRole } from '../entities/Auth&RBAC/UserRole';
import { ROLE_SLUGS } from './rbac.constants';
import { logger } from './seed.logger';

const BCRYPT_ROUNDS = 12;

/**
 * Creates (or repairs) the platform super-admin user from ADMIN_EMAIL /
 * ADMIN_PASSWORD and guarantees it holds the `super_admin` role.
 *
 * Idempotent:
 *  - matched by email within the super-admin scope (tenant IS NULL);
 *  - never duplicates the user or the role assignment;
 *  - does NOT overwrite an existing password on re-run.
 */
export async function seedAdminUser(manager: EntityManager): Promise<void> {
  logger.step('Seeding super-admin user');

  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    logger.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed');
    return;
  }

  const userRepo = manager.getRepository(User);
  const roleRepo = manager.getRepository(Role);
  const userRoleRepo = manager.getRepository(UserRole);

  const superAdminRole = await roleRepo.findOne({
    where: { slug: ROLE_SLUGS.SUPER_ADMIN, tenant: IsNull() },
  });
  if (!superAdminRole) {
    throw new Error(
      'super_admin role not found — run the roles seed before the admin seed',
    );
  }

  // Super-admins have tenant IS NULL (matches uq_superadmin_email).
  let user = await userRepo.findOne({
    where: { email, tenant: IsNull() },
  });

  if (!user) {
    user = await userRepo.save(
      userRepo.create({
        email,
        full_name: 'Super Admin',
        password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        is_active: true,
      }),
    );
    logger.success(`created super-admin user "${email}"`);
  } else {
    logger.info(`super-admin user "${email}" already exists (password left unchanged)`);
  }

  const existingLink = await userRoleRepo.findOne({
    where: { user: { id: user.id }, role: { id: superAdminRole.id } },
  });
  if (!existingLink) {
    await userRoleRepo.save(
      userRoleRepo.create({ user, role: superAdminRole }),
    );
    logger.success('assigned super_admin role');
  } else {
    logger.info('super_admin role already assigned');
  }
}
