import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { RolesService } from './roles.service';
import { Role } from '../../entities/Auth&RBAC/Role';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { RolePermission } from '../../entities/Auth&RBAC/RolePermission';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { ErrorCode } from '../../common/errors';
import { ROLE } from '../../rbac/rbac.constants';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('RolesService', () => {
  let service: RolesService;
  let roles: MockRepository;
  let permissions: MockRepository;
  let rolePermissions: MockRepository;
  let users: MockRepository;
  let userRoles: MockRepository;

  const TENANT = 'tenant-1';

  beforeEach(async () => {
    roles = createMockRepository();
    permissions = createMockRepository();
    rolePermissions = createMockRepository();
    users = createMockRepository();
    userRoles = createMockRepository();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: getRepositoryToken(Role), useValue: roles },
        { provide: getRepositoryToken(Permission), useValue: permissions },
        { provide: getRepositoryToken(RolePermission), useValue: rolePermissions },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(UserRole), useValue: userRoles },
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

    it('replaces the permission set when all ids exist', async () => {
      roles.findOne
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } }) // assertMutable
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } }); // findOne reload
      permissions.find.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);

      await service.setPermissions('r1', ['p1', 'p2'], TENANT);
      expect(rolePermissions.delete).toHaveBeenCalledWith({ role: { id: 'r1' } });
      expect(rolePermissions.save).toHaveBeenCalled();
    });
  });

  describe('create with permissions', () => {
    it('attaches the given permission slugs on creation', async () => {
      roles.findOne
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ id: 'r1', is_system: false, tenant: { id: TENANT } }); // findOne reload
      roles.save.mockResolvedValueOnce({ id: 'r1' });
      permissions.find.mockResolvedValueOnce([{ id: 'p1' }]);

      await service.create({ slug: 'role', name: 'Role', permissionSlugs: ['a.b'] } as any, TENANT);
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
});
