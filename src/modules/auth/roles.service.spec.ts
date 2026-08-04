import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RolesService } from './roles.service';
import { Role } from '../../entities/Auth&RBAC/Role';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { RolePermission } from '../../entities/Auth&RBAC/RolePermission';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ErrorCode } from '../../common/errors';
import { CUSTOM_ROLE_SENTINEL, PERMISSION, ROLE } from '../../rbac/rbac.constants';
import {
  createMockEntityManager,
  createMockRepository,
  MockEntityManager,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('RolesService', () => {
  let service: RolesService;
  let roles: MockRepository;
  let permissions: MockRepository;
  let rolePermissions: MockRepository;
  let users: MockRepository;
  let userRoles: MockRepository;
  let auditLogs: MockRepository;
  let tenantContext: {
    getTenantId: jest.Mock;
    getUser: jest.Mock;
    getCorrelationId: jest.Mock;
  };

  const TENANT = 'tenant-1';

  beforeEach(async () => {
    roles = createMockRepository();
    permissions = createMockRepository();
    rolePermissions = createMockRepository();
    users = createMockRepository();
    userRoles = createMockRepository();
    auditLogs = createMockRepository();
    tenantContext = {
      getTenantId: jest.fn().mockReturnValue(TENANT),
      getUser: jest.fn().mockReturnValue({ id: 'actor-1' }),
      getCorrelationId: jest.fn().mockReturnValue('corr-1'),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: getRepositoryToken(Role), useValue: roles },
        { provide: getRepositoryToken(Permission), useValue: permissions },
        { provide: getRepositoryToken(RolePermission), useValue: rolePermissions },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(UserRole), useValue: userRoles },
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
        { provide: TenantContextService, useValue: tenantContext },
      ],
    }).compile();
    service = moduleRef.get(RolesService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates a tenant role and returns it', async () => {
      roles.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } }); // findOne()
      roles.save.mockResolvedValueOnce({ id: 'r1' });

      const result = await service.create({ slug: 'front-desk', name: 'Front Desk' } as any, TENANT);
      expect(result).toEqual(expect.objectContaining({ id: 'r1' }));
    });

    it('rejects a duplicate slug within the tenant', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create({ slug: 'dup' } as any, TENANT)).rejects.toMatchObject({
        code: ErrorCode.ROLE_ALREADY_EXISTS,
      });
    });

    it('rejects the reserved "other" slug without a DB lookup', async () => {
      await expect(
        service.create({ slug: CUSTOM_ROLE_SENTINEL, name: 'Other' } as any, TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(roles.findOne).not.toHaveBeenCalled();
    });
  });

  describe('findOne visibility', () => {
    it('returns a role owned by the tenant', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } });
      await expect(service.findOne('r1', TENANT)).resolves.toEqual(expect.objectContaining({ id: 'r1' }));
    });

    it('returns a shared system role to any tenant', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'sys', is_system: true, tenant: null });
      await expect(service.findOne('sys', TENANT)).resolves.toEqual(expect.objectContaining({ id: 'sys' }));
    });

    it('hides a role owned by another tenant (404)', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: 'other' } });
      await expect(service.findOne('r1', TENANT)).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND });
    });

    it('throws when the role does not exist', async () => {
      roles.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne('nope', TENANT)).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND });
    });
  });

  describe('assignRoleToUser', () => {
    const assignableRole = { id: 'r-rec', slug: ROLE.RECEPTIONIST, is_system: false, tenant: { id: TENANT } };

    it('assigns an allowed role to a user in the tenant', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } }); // assertUserInTenant
      roles.findOne.mockResolvedValueOnce(assignableRole); // findOne()
      userRoles.findOne.mockResolvedValueOnce(null); // no existing link
      userRoles.save.mockResolvedValueOnce({ id: 'ur1' });

      await expect(service.assignRoleToUser('u1', 'r-rec', TENANT)).resolves.toEqual({ id: 'ur1' });
    });

    it('BLOCKS assigning a privileged role (owner) through the API', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      roles.findOne.mockResolvedValueOnce({ id: 'r-owner', slug: ROLE.OWNER, is_system: true, tenant: null });

      await expect(service.assignRoleToUser('u1', 'r-owner', TENANT)).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    });

    it('rejects a duplicate role assignment', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      roles.findOne.mockResolvedValueOnce(assignableRole);
      userRoles.findOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(service.assignRoleToUser('u1', 'r-rec', TENANT)).rejects.toMatchObject({
        code: ErrorCode.ROLE_ASSIGNMENT_EXISTS,
      });
    });

    it('rejects when the target user is not in the caller tenant', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: 'other' } });
      await expect(service.assignRoleToUser('u1', 'r-rec', TENANT)).rejects.toMatchObject({
        code: ErrorCode.USER_NOT_FOUND,
      });
    });
  });

  describe('update (assertMutable)', () => {
    it('rejects mutating a role owned by another tenant', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: 'other' } });
      await expect(service.update('r1', { name: 'x' } as any, TENANT)).rejects.toMatchObject({
        code: ErrorCode.ROLE_IMMUTABLE,
      });
    });

    it('rejects a tenant mutating a system role', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'sys', is_system: true, tenant: { id: TENANT } });
      await expect(service.update('sys', { name: 'x' } as any, TENANT)).rejects.toMatchObject({
        code: ErrorCode.ROLE_IMMUTABLE,
      });
    });
  });

  describe('removeRoleFromUser', () => {
    it('throws when the assignment does not exist', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      userRoles.findOne.mockResolvedValueOnce(null);
      await expect(service.removeRoleFromUser('u1', 'r1', TENANT)).rejects.toMatchObject({
        code: ErrorCode.ROLE_ASSIGNMENT_NOT_FOUND,
      });
    });
  });

  describe('setPermissions', () => {
    it('rejects when one or more permission ids do not exist', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } });
      permissions.find.mockResolvedValueOnce([{ id: 'p1' }]); // only 1 of 2 found
      await expect(service.setPermissions('r1', ['p1', 'p2'], TENANT)).rejects.toMatchObject({
        code: ErrorCode.PERMISSION_NOT_FOUND,
      });
    });

    it('replaces the permission set when all ids exist and the caller holds every granted slug', async () => {
      roles.findOne
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT }, rolePermissions: [] }) // assertMutable
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } }); // findOne reload
      permissions.find.mockResolvedValueOnce([
        { id: 'p1', slug: PERMISSION.APPOINTMENTS_READ },
        { id: 'p2', slug: PERMISSION.APPOINTMENTS_CREATE },
      ]);

      await (service as any).setPermissions(
        'r1',
        ['p1', 'p2'],
        TENANT,
        [PERMISSION.APPOINTMENTS_READ, PERMISSION.APPOINTMENTS_CREATE],
      );
      expect(rolePermissions.delete).toHaveBeenCalledWith({ role: { id: 'r1' } });
      expect(rolePermissions.save).toHaveBeenCalled();
    });
  });

  describe('create with permissions', () => {
    it('attaches the given permission slugs on creation when the caller holds them', async () => {
      roles.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } }); // findOne reload
      roles.save.mockResolvedValueOnce({ id: 'r1' });
      permissions.find.mockResolvedValueOnce([{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }]);

      await (service as any).create(
        { slug: 'role', name: 'Role', permissionSlugs: [PERMISSION.APPOINTMENTS_READ] },
        TENANT,
        [PERMISSION.APPOINTMENTS_READ],
      );
      expect(permissions.find).toHaveBeenCalled();
      expect(rolePermissions.save).toHaveBeenCalled();
    });
  });

  describe('findAll / update / remove', () => {
    it('lists tenant + system roles', async () => {
      roles.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'sys' }]);
      await expect(service.findAll(TENANT)).resolves.toHaveLength(2);
    });

    it('updates a mutable tenant role', async () => {
      roles.findOne
        .mockResolvedValueOnce({ id: 'r1', name: 'old', is_system: false, tenant: { id: TENANT } }) // assertMutable
        .mockResolvedValueOnce({ id: 'r1', name: 'new', is_system: false, tenant: { id: TENANT } }); // reload
      const result = await service.update('r1', { name: 'new' } as any, TENANT);
      expect(roles.save).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ name: 'new' }));
    });

    it('soft-removes a mutable role', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } });
      await service.remove('r1', TENANT);
      expect(roles.softRemove).toHaveBeenCalled();
    });
  });

  describe('findAssignableForStaff', () => {
    it('excludes owner/super_admin/customer/ai-bot but keeps everything else', async () => {
      roles.find.mockResolvedValueOnce([
        { id: 'r1', slug: ROLE.MANAGER },
        { id: 'r2', slug: ROLE.RECEPTIONIST },
        { id: 'r3', slug: ROLE.OWNER },
        { id: 'r4', slug: ROLE.SUPER_ADMIN },
        { id: 'r5', slug: ROLE.CUSTOMER },
        { id: 'r6', slug: ROLE.AI_BOT },
        { id: 'r7', slug: 'front-desk' }, // tenant custom role
      ]);

      const result = await service.findAssignableForStaff(TENANT);

      expect(result.map((r) => r.slug)).toEqual([
        ROLE.MANAGER,
        ROLE.RECEPTIONIST,
        'front-desk',
      ]);
    });
  });

  describe('findAssignableRoleBySlug', () => {
    it('rejects super_admin/owner/customer/ai-bot without a DB lookup', async () => {
      await expect(
        service.findAssignableRoleBySlug(ROLE.OWNER, TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(roles.findOne).not.toHaveBeenCalled();
    });

    it('resolves a tenant custom role or a system role', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', slug: 'front-desk' });
      await expect(
        service.findAssignableRoleBySlug('front-desk', TENANT),
      ).resolves.toEqual({ id: 'r1', slug: 'front-desk' });
    });

    it('throws ROLE_NOT_FOUND for an unknown slug', async () => {
      roles.findOne.mockResolvedValueOnce(null);
      await expect(
        service.findAssignableRoleBySlug('nonexistent', TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND });
    });
  });

  describe('findAssignableRolePermissions', () => {
    it("returns the role's full permission set, sorted by module then name", async () => {
      roles.findOne.mockResolvedValueOnce({
        id: 'role-doctor',
        slug: ROLE.DOCTOR,
        tenant: null,
        is_system: true,
        rolePermissions: [
          {
            permission: {
              id: 'p2',
              slug: PERMISSION.DASHBOARD_ACCESS,
              name: 'Access clinic dashboard',
              module: 'general',
            },
          },
          {
            permission: {
              id: 'p1',
              slug: PERMISSION.APPOINTMENTS_READ_OWN,
              name: 'Read own appointments',
              module: 'appointments',
            },
          },
        ],
      });

      const result = await service.findAssignableRolePermissions('role-doctor', TENANT);

      expect(result.map((p) => p.slug)).toEqual([
        PERMISSION.APPOINTMENTS_READ_OWN,
        PERMISSION.DASHBOARD_ACCESS,
      ]);
    });

    it('rejects a role that cannot be assigned to staff (e.g. owner/super_admin)', async () => {
      roles.findOne.mockResolvedValueOnce({
        id: 'role-owner',
        slug: ROLE.OWNER,
        tenant: null,
        is_system: true,
        rolePermissions: [],
      });

      await expect(
        service.findAssignableRolePermissions('role-owner', TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('throws ROLE_NOT_FOUND when the role is not visible to this tenant', async () => {
      roles.findOne.mockResolvedValueOnce(null);

      await expect(
        service.findAssignableRolePermissions('nonexistent', TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.ROLE_NOT_FOUND });
    });
  });

  describe('user-role assignments', () => {
    it('lists a user roles', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      userRoles.find.mockResolvedValueOnce([{ role: { id: 'r1' } }, { role: { id: 'r2' } }]);
      await expect(service.listUserRoles('u1', TENANT)).resolves.toEqual([{ id: 'r1' }, { id: 'r2' }]);
    });

    it('removes an existing role assignment', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      userRoles.findOne.mockResolvedValueOnce({ id: 'ur1' });
      await service.removeRoleFromUser('u1', 'r1', TENANT);
      expect(userRoles.remove).toHaveBeenCalledWith({ id: 'ur1' });
    });
  });

  describe('findGrantableForCaller', () => {
    it('returns [] without a query when the caller holds no permissions', async () => {
      await expect(service.findGrantableForCaller([])).resolves.toEqual([]);
      expect(permissions.find).not.toHaveBeenCalled();
    });

    it('looks up the catalogue rows matching the caller\'s permission slugs', async () => {
      const found = [{ id: 'p1', slug: 'appointments.read' }];
      permissions.find.mockResolvedValueOnce(found);

      await expect(
        service.findGrantableForCaller(['appointments.read']),
      ).resolves.toEqual(found);
      expect(permissions.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: expect.anything() } }),
      );
    });

    it('excludes dashboard.access and reserved permissions even when the caller holds them', async () => {
      permissions.find.mockResolvedValueOnce([]);

      await service.findGrantableForCaller([
        PERMISSION.APPOINTMENTS_READ,
        PERMISSION.DASHBOARD_ACCESS,
        PERMISSION.ROLES_MANAGE,
        PERMISSION.USERS_MANAGE,
        PERMISSION.TENANTS_MANAGE,
      ]);

      const [{ where }] = permissions.find.mock.calls[0];
      expect(where.slug.value).toEqual([PERMISSION.APPOINTMENTS_READ]);
    });

    it('returns [] without a query when only reserved/implicit permissions are held', async () => {
      await expect(
        service.findGrantableForCaller([PERMISSION.DASHBOARD_ACCESS, PERMISSION.ROLES_MANAGE]),
      ).resolves.toEqual([]);
      expect(permissions.find).not.toHaveBeenCalled();
    });
  });

  describe('validateCustomPermissions ("Other" role)', () => {
    const CALLER = [PERMISSION.APPOINTMENTS_READ, PERMISSION.CUSTOMERS_READ];

    it('rejects an empty permission selection', async () => {
      await expect(
        service.validateCustomPermissions([], CALLER),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(permissions.find).not.toHaveBeenCalled();
    });

    it('rejects a reserved permission (owner/super_admin-only) even if the caller holds it', async () => {
      const ownerLikeCaller = [PERMISSION.APPOINTMENTS_READ, PERMISSION.ROLES_MANAGE];
      await expect(
        service.validateCustomPermissions(
          [PERMISSION.APPOINTMENTS_READ, PERMISSION.ROLES_MANAGE],
          ownerLikeCaller,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(permissions.find).not.toHaveBeenCalled();
    });

    it('rejects an unknown permission slug', async () => {
      permissions.find.mockResolvedValueOnce([{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }]); // only 1 of 2 found
      await expect(
        service.validateCustomPermissions(
          [PERMISSION.APPOINTMENTS_READ, 'not.a.real.permission'],
          CALLER,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_NOT_FOUND });
    });

    it('BLOCKS granting a permission the caller does not themselves hold (privilege escalation)', async () => {
      permissions.find.mockResolvedValueOnce([
        { id: 'p1', slug: PERMISSION.APPOINTMENTS_READ },
        { id: 'p2', slug: PERMISSION.BILLING_MANAGE },
      ]);

      await expect(
        service.validateCustomPermissions(
          [PERMISSION.APPOINTMENTS_READ, PERMISSION.BILLING_MANAGE],
          CALLER, // does not include billing.manage
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('returns the resolved Permission entities on success', async () => {
      const found = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }];
      permissions.find.mockResolvedValueOnce(found);
      await expect(
        service.validateCustomPermissions([PERMISSION.APPOINTMENTS_READ], CALLER),
      ).resolves.toEqual(found);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FND-009 — reserved-permission enforcement on create/update/setPermissions
  // /assignment. `(service as any)` casts below call the NOT-YET-EXISTING
  // 3rd/4th `callerPermissions` parameter — this is deliberate: the red
  // phase proves these entry points currently accept a reserved permission
  // at all, regardless of arity. The pre-existing tests above are untouched
  // and must keep passing unmodified (TR-002).
  // ═══════════════════════════════════════════════════════════════════════
  describe('FND-009 — create() rejects reserved/unheld permissions', () => {
    const HELD = [PERMISSION.APPOINTMENTS_READ, PERMISSION.APPOINTMENTS_CREATE];

    it('rejects a reserved permission even when the caller holds it', async () => {
      roles.findOne.mockResolvedValueOnce(null); // duplicate check
      const callerHoldsReserved = [...HELD, PERMISSION.ROLES_MANAGE];

      await expect(
        (service as any).create(
          { slug: 'escalate', name: 'Escalate', permissionSlugs: [PERMISSION.ROLES_MANAGE] },
          TENANT,
          callerHoldsReserved,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      // A refused request must create NOTHING at all.
      expect(roles.save).not.toHaveBeenCalled();
    });

    it('rejects a permission the caller does not hold', async () => {
      roles.findOne.mockResolvedValueOnce(null);

      await expect(
        (service as any).create(
          { slug: 'over-reach', name: 'Over Reach', permissionSlugs: [PERMISSION.BILLING_MANAGE] },
          TENANT,
          HELD, // does not include billing.manage
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(roles.save).not.toHaveBeenCalled();
    });

    it('succeeds when every requested permission is non-reserved and held by the caller', async () => {
      roles.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT }, rolePermissions: [] });
      roles.save.mockResolvedValueOnce({ id: 'r1' });
      permissions.find.mockResolvedValueOnce([{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }]);

      await expect(
        (service as any).create(
          { slug: 'front-desk-2', name: 'Front Desk 2', permissionSlugs: [PERMISSION.APPOINTMENTS_READ] },
          TENANT,
          HELD,
        ),
      ).resolves.toEqual(expect.objectContaining({ id: 'r1' }));
      expect(roles.save).toHaveBeenCalled();
    });

    it('writes a safe audit record on refusal, naming the role-less rejection and never a credential', async () => {
      roles.findOne.mockResolvedValueOnce(null);

      await expect(
        (service as any).create(
          { slug: 'escalate-2', name: 'Escalate 2', permissionSlugs: [PERMISSION.USERS_MANAGE] },
          TENANT,
          HELD,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

      expect(auditLogs.save).toHaveBeenCalledTimes(1);
      const saved = JSON.stringify(auditLogs.save.mock.calls[0][0]);
      expect(saved).toContain(PERMISSION.USERS_MANAGE);
      expect(saved).not.toMatch(/password|token|secret/i);
    });
  });

  describe('FND-009 — update() reserved permissions, and the empty-vs-omitted rule', () => {
    const HELD = [PERMISSION.APPOINTMENTS_READ, PERMISSION.APPOINTMENTS_CREATE];
    const mutableRole = () => ({
      id: 'r1',
      name: 'Front Desk',
      is_system: false,
      tenant: { id: TENANT },
      rolePermissions: [],
    });

    it('rejects adding a reserved permission even when the caller holds it', async () => {
      roles.findOne.mockResolvedValueOnce(mutableRole()); // assertMutable
      const callerHoldsReserved = [...HELD, PERMISSION.TENANTS_MANAGE];

      await expect(
        (service as any).update(
          'r1',
          { permissionSlugs: [PERMISSION.TENANTS_MANAGE] },
          TENANT,
          callerHoldsReserved,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(rolePermissions.delete).not.toHaveBeenCalled();
    });

    it('an OMITTED permissionSlugs field leaves the stored permission set unchanged (metadata-only edit still succeeds)', async () => {
      roles.findOne
        .mockResolvedValueOnce(mutableRole()) // assertMutable
        .mockResolvedValueOnce({ ...mutableRole(), name: 'Renamed' }); // reload

      await expect(
        (service as any).update('r1', { name: 'Renamed' }, TENANT, HELD),
      ).resolves.toEqual(expect.objectContaining({ name: 'Renamed' }));
      expect(rolePermissions.delete).not.toHaveBeenCalled();
      expect(roles.save).toHaveBeenCalled(); // the name change itself still applies
    });

    it('an EXPLICITLY EMPTY permissionSlugs list still clears all permissions and is exempt from any rule', async () => {
      roles.findOne
        .mockResolvedValueOnce(mutableRole())
        .mockResolvedValueOnce({ ...mutableRole(), rolePermissions: [] });

      await (service as any).update('r1', { permissionSlugs: [] }, TENANT, []); // caller holds NOTHING
      expect(rolePermissions.delete).toHaveBeenCalledWith({ role: { id: 'r1' } });
      expect(permissions.find).not.toHaveBeenCalled(); // no lookup needed for an empty set
    });
  });

  describe('FND-009 — setPermissions() derives slugs from already-loaded rows, no extra query', () => {
    const HELD = [PERMISSION.APPOINTMENTS_READ];
    const mutableRole = () => ({
      id: 'r1',
      is_system: false,
      tenant: { id: TENANT },
      rolePermissions: [],
    });

    it('rejects a reserved permission resolved from the supplied permission ids', async () => {
      roles.findOne.mockResolvedValueOnce(mutableRole()); // assertMutable
      permissions.find.mockResolvedValueOnce([
        { id: 'p-reserved', slug: PERMISSION.ROLES_MANAGE },
      ]);

      await expect(
        (service as any).setPermissions('r1', ['p-reserved'], TENANT, [
          ...HELD,
          PERMISSION.ROLES_MANAGE,
        ]),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(rolePermissions.delete).not.toHaveBeenCalled();
    });

    it('rejects a permission the caller does not hold', async () => {
      roles.findOne.mockResolvedValueOnce(mutableRole());
      permissions.find.mockResolvedValueOnce([
        { id: 'p-billing', slug: PERMISSION.BILLING_MANAGE },
      ]);

      await expect(
        (service as any).setPermissions('r1', ['p-billing'], TENANT, HELD),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('an empty permissionIds array still clears without any permission lookup', async () => {
      roles.findOne
        .mockResolvedValueOnce(mutableRole())
        .mockResolvedValueOnce({ ...mutableRole(), rolePermissions: [] });

      await (service as any).setPermissions('r1', [], TENANT, []);
      expect(permissions.find).not.toHaveBeenCalled();
      expect(rolePermissions.delete).toHaveBeenCalledWith({ role: { id: 'r1' } });
    });
  });

  describe('FND-009 — the platform exemption applies ONLY when BOTH sides are platform-scoped', () => {
    it('EXEMPTS a platform caller (tenantId=null) creating a GLOBAL role with a reserved permission', async () => {
      roles.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ id: 'sys-new', is_system: true, tenant: null, rolePermissions: [] });
      roles.save.mockResolvedValueOnce({ id: 'sys-new' });
      permissions.find.mockResolvedValueOnce([{ id: 'p1', slug: PERMISSION.ROLES_MANAGE }]);

      await expect(
        (service as any).create(
          { slug: 'platform-role', name: 'Platform Role', permissionSlugs: [PERMISSION.ROLES_MANAGE] },
          null, // platform caller
          [], // caller holds nothing — irrelevant on the exempt path
        ),
      ).resolves.toEqual(expect.objectContaining({ id: 'sys-new' }));
    });

    it('a TENANT caller on a truly GLOBAL role (tenant=null) is refused by the EXISTING assertMutable — not the new reserved-permission error', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'sys', is_system: true, tenant: null, rolePermissions: [] });

      await expect(
        (service as any).update('sys', { name: 'x' }, TENANT, []),
      ).rejects.toMatchObject({ code: ErrorCode.ROLE_IMMUTABLE });
    });

    it('a PLATFORM caller (tenantId=null) on a TENANT-SCOPED role is refused by the EXISTING assertMutable — not the new reserved-permission error', async () => {
      roles.findOne.mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT }, rolePermissions: [] });

      await expect(
        (service as any).update('r1', { name: 'x' }, null, []),
      ).rejects.toMatchObject({ code: ErrorCode.ROLE_IMMUTABLE });
    });
  });

  describe('FND-009 — assignment cannot bypass the restriction (defence in depth)', () => {
    it('refuses to assign a role that already carries a reserved permission', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      roles.findOne.mockResolvedValueOnce({
        id: 'r-bad',
        slug: 'somehow-reserved',
        is_system: false,
        tenant: { id: TENANT },
        rolePermissions: [{ permission: { slug: PERMISSION.ROLES_MANAGE } }],
      });

      await expect(
        service.assignRoleToUser('u1', 'r-bad', TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(userRoles.save).not.toHaveBeenCalled();
    });

    it('still allows assigning a legitimate role holding no reserved permission', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1', tenant: { id: TENANT } });
      roles.findOne.mockResolvedValueOnce({
        id: 'r-rec',
        slug: ROLE.RECEPTIONIST,
        is_system: false,
        tenant: { id: TENANT },
        rolePermissions: [{ permission: { slug: PERMISSION.APPOINTMENTS_READ } }],
      });
      userRoles.findOne.mockResolvedValueOnce(null);
      userRoles.save.mockResolvedValueOnce({ id: 'ur1' });

      await expect(service.assignRoleToUser('u1', 'r-rec', TENANT)).resolves.toEqual({ id: 'ur1' });
    });
  });

  describe('FND-009 — an existing stored role already holding a reserved permission is detected on mutation, never silently altered', () => {
    const affectedRole = () => ({
      id: 'r-legacy',
      name: 'Legacy Role',
      is_system: false,
      tenant: { id: TENANT },
      rolePermissions: [{ permission: { slug: PERMISSION.ROLES_MANAGE } }],
    });

    it('refuses even a metadata-only (name) update, and writes a safe audit record', async () => {
      roles.findOne.mockResolvedValueOnce(affectedRole());

      await expect(
        (service as any).update('r-legacy', { name: 'Renamed' }, TENANT, []),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

      // The stored permission is untouched — no delete/save of role_permissions.
      expect(rolePermissions.delete).not.toHaveBeenCalled();
      expect(roles.save).not.toHaveBeenCalled();
      expect(auditLogs.save).toHaveBeenCalledTimes(1);
    });

    it('does NOT apply to the platform path — a platform caller may still mutate a GLOBAL role holding a reserved permission (e.g. owner/super_admin)', async () => {
      // Must be a genuinely global role (tenant: null) for a platform caller
      // (tenantId=null) to pass assertMutable's tenant-match check at all —
      // this mirrors the real owner/super_admin system rows.
      const globalReservedRole = () => ({
        id: 'sys-owner',
        name: 'Owner',
        is_system: true,
        tenant: null,
        rolePermissions: [{ permission: { slug: PERMISSION.ROLES_MANAGE } }],
      });
      roles.findOne
        .mockResolvedValueOnce(globalReservedRole())
        .mockResolvedValueOnce({ ...globalReservedRole(), name: 'Renamed' });

      await expect(
        (service as any).update('sys-owner', { name: 'Renamed' }, null, []),
      ).resolves.toEqual(expect.objectContaining({ name: 'Renamed' }));
    });
  });

  describe('resolveCustomRole ("Other" role — transactional write phase)', () => {
    let manager: MockEntityManager;
    let mRoles: MockRepository;
    let mPermissions: MockRepository;
    let mRolePermissions: MockRepository;
    let mUserRoles: MockRepository;
    const DASHBOARD_PERM = { id: 'p-dash', slug: PERMISSION.DASHBOARD_ACCESS };

    beforeEach(() => {
      manager = createMockEntityManager();
      mRoles = manager.getRepository(Role) as unknown as MockRepository;
      mPermissions = manager.getRepository(Permission) as unknown as MockRepository;
      mRolePermissions = manager.getRepository(RolePermission) as unknown as MockRepository;
      mUserRoles = manager.getRepository(UserRole) as unknown as MockRepository;
      mPermissions.findOne.mockResolvedValue(DASHBOARD_PERM); // implicit dashboard.access lookup
    });

    it('creates a fresh custom role scoped to the tenant when there is no user to reuse from', async () => {
      const perms = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }] as any;
      mRoles.save.mockResolvedValueOnce({ id: 'role-new', is_system: false, tenant: { id: TENANT } });

      const result = await service.resolveCustomRole(
        TENANT,
        perms,
        null,
        'Sara Al-Amin',
        manager as any,
      );

      expect(mRoles.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Custom — Sara Al-Amin', is_system: false }),
      );
      // The implicit dashboard.access permission is always included alongside
      // whatever was explicitly granted.
      const savedPerms = mRolePermissions.save.mock.calls[0][0];
      expect(savedPerms.map((rp: any) => rp.permission.slug)).toEqual(
        expect.arrayContaining([PERMISSION.APPOINTMENTS_READ, PERMISSION.DASHBOARD_ACCESS]),
      );
      expect(result).toEqual(expect.objectContaining({ id: 'role-new' }));
    });

    it('reuses (updates in place) the sole custom role already held only by this user', async () => {
      const perms = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }] as any;
      mUserRoles.find.mockResolvedValueOnce([
        { role: { id: 'role-existing', is_system: false, tenant: { id: TENANT } } },
      ]);
      mUserRoles.count.mockResolvedValueOnce(1); // sole holder

      const result = await service.resolveCustomRole(
        TENANT,
        perms,
        'user-1',
        undefined,
        manager as any,
      );

      expect(mRolePermissions.delete).toHaveBeenCalledWith({ role: { id: 'role-existing' } });
      expect(mRoles.save).not.toHaveBeenCalled(); // no NEW role created
      expect(result).toEqual(expect.objectContaining({ id: 'role-existing' }));
    });

    it('creates a fresh role instead of mutating a custom role shared by another user', async () => {
      const perms = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }] as any;
      mUserRoles.find.mockResolvedValueOnce([
        { role: { id: 'role-shared', is_system: false, tenant: { id: TENANT } } },
      ]);
      mUserRoles.count.mockResolvedValueOnce(2); // shared with another user
      mRoles.save.mockResolvedValueOnce({ id: 'role-new-2', is_system: false, tenant: { id: TENANT } });

      await service.resolveCustomRole(TENANT, perms, 'user-1', undefined, manager as any);

      expect(mRoles.save).toHaveBeenCalled(); // a NEW role was created, not the shared one mutated
    });

    it('two employees given identical permission sets independently get two distinct roles (never reused by matching permissions)', async () => {
      const perms = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }] as any;
      mRoles.save.mockResolvedValueOnce({ id: 'role-employee-a', is_system: false, tenant: { id: TENANT } });
      const roleA = await service.resolveCustomRole(TENANT, perms, null, 'Employee A', manager as any);

      mRoles.save.mockResolvedValueOnce({ id: 'role-employee-b', is_system: false, tenant: { id: TENANT } });
      const roleB = await service.resolveCustomRole(TENANT, perms, null, 'Employee B', manager as any);

      expect(roleA.id).not.toEqual(roleB.id);
      expect(mRoles.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteIfOrphanedCustomRole', () => {
    let manager: MockEntityManager;

    beforeEach(() => {
      manager = createMockEntityManager();
    });

    it('soft-removes a tenant custom role with zero remaining holders', async () => {
      const role = { id: 'role-1', is_system: false } as any;
      (manager.getRepository(UserRole) as unknown as MockRepository).count.mockResolvedValueOnce(0);

      await service.deleteIfOrphanedCustomRole(role, manager as any);

      expect((manager.getRepository(Role) as unknown as MockRepository).softRemove).toHaveBeenCalledWith(role);
    });

    it('leaves a custom role alone while it still has a holder', async () => {
      const role = { id: 'role-1', is_system: false } as any;
      (manager.getRepository(UserRole) as unknown as MockRepository).count.mockResolvedValueOnce(1);

      await service.deleteIfOrphanedCustomRole(role, manager as any);

      expect((manager.getRepository(Role) as unknown as MockRepository).softRemove).not.toHaveBeenCalled();
    });

    it('never touches a system role, even with zero holders', async () => {
      const role = { id: 'role-sys', is_system: true } as any;

      await service.deleteIfOrphanedCustomRole(role, manager as any);

      expect((manager.getRepository(UserRole) as unknown as MockRepository).count).not.toHaveBeenCalled();
      expect((manager.getRepository(Role) as unknown as MockRepository).softRemove).not.toHaveBeenCalled();
    });
  });
});
