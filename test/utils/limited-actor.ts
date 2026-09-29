/**
 * A user of an existing tenant holding ONLY the listed RBAC permissions, plus a
 * real access JWT for them. Used to prove the backend — not the UI — enforces
 * permissions (a read-only or under-privileged dashboard user).
 */
import { randomUUID } from 'node:crypto';

import { Permission } from '../../src/entities/Auth&RBAC/Permission';
import { Role } from '../../src/entities/Auth&RBAC/Role';
import { RolePermission } from '../../src/entities/Auth&RBAC/RolePermission';
import { User } from '../../src/entities/Auth&RBAC/User';
import { UserRole } from '../../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';
import type { E2eApp } from './whatsapp-e2e-app';

export async function createLimitedActor(
  e2e: E2eApp,
  tenantId: string,
  slugs: string[],
  label: string,
): Promise<{ userId: string; token: string }> {
  const ds = e2e.dataSource;
  const perms = await ds
    .getRepository(Permission)
    .createQueryBuilder('p')
    .where('p.slug IN (:...slugs)', { slugs })
    .getMany();
  if (perms.length !== slugs.length) {
    throw new Error(
      `Seeded permissions missing for: ${slugs.join(', ')} — run the RBAC seed first.`,
    );
  }

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const roles = ds.getRepository(Role);
  const role = await roles.save(
    roles.create({
      tenant: { id: tenantId } as Tenant,
      name: `Limited ${suffix}`,
      slug: `limited-${suffix}`,
      is_system: false,
    }),
  );
  const rolePermissions = ds.getRepository(RolePermission);
  await rolePermissions.save(
    perms.map((p) => rolePermissions.create({ role, permission: p })),
  );

  const users = ds.getRepository(User);
  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as Tenant,
      email: `${suffix}@example.test`,
      full_name: `Limited ${suffix}`,
      is_active: true,
    }),
  );
  await ds
    .getRepository(UserRole)
    .save({ user: { id: user.id } as User, role: { id: role.id } as Role });

  const token = await e2e.jwt.signAsync(
    { sub: user.id, tenantId, type: 'access' },
    {
      secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
      expiresIn: '15m',
    },
  );
  return { userId: user.id, token };
}
