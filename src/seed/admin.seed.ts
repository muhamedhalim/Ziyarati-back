import { EntityManager, IsNull } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Role } from '../entities/Auth&RBAC/Role';
import { User } from '../entities/Auth&RBAC/User';
import { UserRole } from '../entities/Auth&RBAC/UserRole';
import { ROLE } from '../rbac/rbac.constants';
import { logger } from './seed.logger';

const BCRYPT_ROUNDS = 12;

/**
 * DEV ONLY — local development fallback credentials.
 * Used solely when ADMIN_EMAIL / ADMIN_PASSWORD are unset AND the process is
 * not running in production. Never relied upon in production: there, missing
 * env vars cause the seed to skip rather than create a known-password admin.
 */
const DEV_ONLY_FALLBACK = {
  email: 'admin@local.test',
  password: 'admin123',
} as const;

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

  const isProduction = process.env.NODE_ENV === 'production';
  const envEmail = process.env.ADMIN_EMAIL?.trim();
  const envPassword = process.env.ADMIN_PASSWORD;

  // Outside production, fall back to DEV-ONLY placeholders so a fresh local
  // database always has a usable super-admin. In production we never fabricate
  // credentials — we skip instead.
  const usingFallback = !isProduction && (!envEmail || !envPassword);
  const email = envEmail || (!isProduction ? DEV_ONLY_FALLBACK.email : undefined);
  const password =
    envPassword || (!isProduction ? DEV_ONLY_FALLBACK.password : undefined);

  if (!email || !password) {
    logger.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed');
    return;
  }

  if (usingFallback) {
    logger.warn(
      `Using DEV-ONLY fallback admin credentials ("${DEV_ONLY_FALLBACK.email}") — set ADMIN_EMAIL / ADMIN_PASSWORD to override`,
    );
  }

  const userRepo = manager.getRepository(User);
  const roleRepo = manager.getRepository(Role);
  const userRoleRepo = manager.getRepository(UserRole);

  const superAdminRole = await roleRepo.findOne({
    where: { slug: ROLE.SUPER_ADMIN, tenant: IsNull() },
  });
  if (!superAdminRole) {
    throw new Error(
      'super_admin role not found — run the roles seed before the admin seed',
    );
  }

  // Super-admins have tenant IS NULL. Email uniqueness is enforced globally
  // (D7 — uq_user_email_global), not by a platform-scoped constraint.
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
    // LSA-12: never the address — this line reaches the migrate/app log groups.
    logger.success('Super admin created successfully');
  } else {
    logger.info('Super admin already exists (password left unchanged)');
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
