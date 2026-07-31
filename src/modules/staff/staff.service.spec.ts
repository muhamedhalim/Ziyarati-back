import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffService } from './staff.service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Service } from '../../entities/Services/Service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AppError, ErrorCode } from '../../common/errors';
import { AuthService } from '../auth/auth.service';
import { RolesService } from '../auth/roles.service';
import { StaffAccessService } from './staff-access.service';
import { StorageService } from '../storage/storage.service';
import { UsageService } from '../subscription-billing/usage.service';
import { CUSTOM_ROLE_SENTINEL, PERMISSION, ROLE } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('StaffService', () => {
  let service: StaffService;
  let staff: MockRepository;
  let staffServices: MockRepository;
  let branchUsers: MockRepository;
  let users: MockRepository;
  let userRoles: MockRepository;
  let auditLogs: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let authService: { createUserWithRole: jest.Mock; revokeAllForUser: jest.Mock };
  let rolesService: {
    findAssignableForStaff: jest.Mock;
    findAssignableRoleBySlug: jest.Mock;
    findAssignableRolePermissions: jest.Mock;
    findGrantableForCaller: jest.Mock;
    validateCustomPermissions: jest.Mock;
    resolveCustomRole: jest.Mock;
    deleteIfOrphanedCustomRole: jest.Mock;
    listUserRoles: jest.Mock;
    findOne: jest.Mock;
  };
  let storage: {
    assertKeyBelongsToTenant: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
    deleteObject: jest.Mock;
  };
  let usage: { assertCountWithinLimit: jest.Mock };
  let staffAccess: { getAccessStates: jest.Mock };

  beforeEach(async () => {
    staff = createMockRepository();
    staffServices = createMockRepository();
    branchUsers = createMockRepository();
    users = createMockRepository();
    userRoles = createMockRepository();
    auditLogs = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    authService = {
      createUserWithRole: jest.fn(),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    rolesService = {
      findAssignableForStaff: jest.fn().mockResolvedValue([]),
      findAssignableRoleBySlug: jest
        .fn()
        .mockResolvedValue({ id: 'role-receptionist', slug: ROLE.RECEPTIONIST, name: 'Receptionist' }),
      findAssignableRolePermissions: jest.fn().mockResolvedValue([]),
      findGrantableForCaller: jest.fn().mockResolvedValue([]),
      validateCustomPermissions: jest.fn(),
      resolveCustomRole: jest.fn(),
      deleteIfOrphanedCustomRole: jest.fn().mockResolvedValue(undefined),
      listUserRoles: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };
    usage = { assertCountWithinLimit: jest.fn().mockResolvedValue(undefined) };
    staffAccess = { getAccessStates: jest.fn().mockResolvedValue(new Map()) };
    storage = {
      assertKeyBelongsToTenant: jest.fn(),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example.com/avatar'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(StaffServiceEntity), useValue: staffServices },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(UserRole), useValue: userRoles },
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
        { provide: getRepositoryToken(Service), useValue: createMockRepository() },
        { provide: getRepositoryToken(Branch), useValue: createMockRepository() },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthService, useValue: authService },
        { provide: RolesService, useValue: rolesService },
        // Only used to decorate read results with derived access state; an
        // empty map keeps `dashboard_access` undefined and leaves the shapes
        // these tests assert on untouched.
        { provide: StaffAccessService, useValue: staffAccess },
        { provide: StorageService, useValue: storage },
        { provide: UsageService, useValue: usage },
      ],
    }).compile();
    service = moduleRef.get(StaffService);
  });

  afterEach(() => jest.clearAllMocks());

  const repo = (entity: unknown) => manager.getRepository(entity) as unknown as MockRepository;

  describe('create', () => {
    it('creates a profile for a tenant user', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1' });
      staff.findOne.mockResolvedValueOnce(null); // no existing profile
      staff.save.mockResolvedValueOnce({ id: 'staff-1' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1' }); // reload
      await expect(service.create(TENANT, { userId: 'u1' } as any)).resolves.toEqual({ id: 'staff-1' });
    });

    it('rejects a user not in the clinic', async () => {
      users.findOne.mockResolvedValueOnce(null);
      await expect(service.create(TENANT, { userId: 'x' } as any)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('rejects a duplicate staff profile for a user', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1' });
      staff.findOne.mockResolvedValueOnce({ id: 'existing' });
      await expect(service.create(TENANT, { userId: 'u1' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('findAll', () => {
    it('returns empty when a branch filter matches no users', async () => {
      branchUsers.find.mockResolvedValueOnce([]); // no users in branch
      const res = await service.findAll(TENANT, { page: 1, limit: 10, branchId: 'b1' } as any);
      expect(res).toEqual({ data: [], total: 0, page: 1, limit: 10 });
    });

    it('lists staff with search + availability filters', async () => {
      staff.findAndCount.mockResolvedValueOnce([[{ id: 'staff-1' }], 1]);
      const res = await service.findAll(TENANT, { page: 1, limit: 10, search: 'dr', isAvailable: 'true' } as any);
      expect(res.total).toBe(1);
    });
  });

  describe('findOne / update / setAvailability / remove', () => {
    it('findOne throws for an unknown staff member', async () => {
      staff.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('update saves changed fields', async () => {
      staff.findOne.mockResolvedValue({ id: 'staff-1', title: 'Old' });
      await service.update(TENANT, 'staff-1', { title: 'New' } as any);
      expect(staff.save).toHaveBeenCalledWith(expect.objectContaining({ title: 'New' }));
    });

    it('setAvailability toggles bookability', async () => {
      staff.findOne.mockResolvedValue({ id: 'staff-1', is_available_for_booking: true });
      await service.setAvailability(TENANT, 'staff-1', false);
      expect(staff.save).toHaveBeenCalledWith(expect.objectContaining({ is_available_for_booking: false }));
    });

    it('remove soft-removes the profile', async () => {
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1' });
      await service.remove(TENANT, 'staff-1');
      expect(staff.softRemove).toHaveBeenCalled();
    });
  });

  describe('avatar handling', () => {
    it('findOne resolves a signed URL when avatar_storage_key is set', async () => {
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 't1/staff-avatar/x.jpg' });
      const result = await service.findOne(TENANT, 'staff-1');
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('t1/staff-avatar/x.jpg');
      expect(result.avatar_url).toBe('https://signed.example.com/avatar');
    });

    it('findOne leaves avatar_url untouched when there is no storage key', async () => {
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1', avatar_url: 'https://legacy.example.com/a.png' });
      const result = await service.findOne(TENANT, 'staff-1');
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(result.avatar_url).toBe('https://legacy.example.com/a.png');
    });

    it('create validates the uploaded key belongs to the tenant', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'u1' });
      staff.findOne.mockResolvedValueOnce(null);
      staff.save.mockResolvedValueOnce({ id: 'staff-1' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1' });

      await service.create(TENANT, { userId: 'u1', avatarStorageKey: `${TENANT}/staff-avatar/x.jpg` } as any);

      expect(storage.assertKeyBelongsToTenant).toHaveBeenCalledWith(`${TENANT}/staff-avatar/x.jpg`, TENANT);
    });

    it('update replaces the avatar and best-effort deletes the old object', async () => {
      staff.findOne
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'old-key.jpg' }) // initial load
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'new-key.jpg' }); // reload

      await service.update(TENANT, 'staff-1', { avatarStorageKey: 'new-key.jpg' } as any);

      expect(storage.assertKeyBelongsToTenant).toHaveBeenCalledWith('new-key.jpg', TENANT);
      expect(staff.save).toHaveBeenCalledWith(expect.objectContaining({ avatar_storage_key: 'new-key.jpg' }));
      expect(storage.deleteObject).toHaveBeenCalledWith('old-key.jpg');
    });

    it('update(null) removes the avatar and best-effort deletes the old object', async () => {
      staff.findOne
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'old-key.jpg' })
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: null });

      await service.update(TENANT, 'staff-1', { avatarStorageKey: null } as any);

      // Must be an explicit `null`, NOT `undefined` — TypeORM's save() skips
      // `undefined` properties on UPDATE, which would silently fail to clear
      // the column (the actual bug this test guards against).
      expect(staff.save).toHaveBeenCalledWith(expect.objectContaining({ avatar_storage_key: null }));
      expect(storage.deleteObject).toHaveBeenCalledWith('old-key.jpg');
    });

    it('update leaves the avatar untouched when avatarStorageKey is omitted', async () => {
      staff.findOne.mockResolvedValue({ id: 'staff-1', avatar_storage_key: 'kept-key.jpg' });

      await service.update(TENANT, 'staff-1', { title: 'New' } as any);

      expect(storage.assertKeyBelongsToTenant).not.toHaveBeenCalled();
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });

    it('never persists a resolved signed URL back into avatar_url (regression)', async () => {
      // Regression guard: `update`/`setAvailability` must load the profile
      // WITHOUT resolving its avatar (loadProfile), not via `findOne` (which
      // mutates avatar_url into a signed URL) — otherwise that presentation-
      // only value gets written to the DB on save. A real repository returns
      // a FRESH object per call, so each mock call gets its own object too
      // (a shared `mockResolvedValue` object would falsely cross-contaminate
      // between the pre-save load and the post-save response resolution).
      staff.findOne
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'kept-key.jpg' }) // loadProfile (update)
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'kept-key.jpg' }); // findOne (update's response)

      await service.update(TENANT, 'staff-1', { title: 'New' } as any);
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledTimes(1);

      const updateSavedArg = staff.save.mock.calls.at(-1)?.[0];
      expect(updateSavedArg.avatar_url).toBeUndefined();

      storage.getSignedDownloadUrl.mockClear();
      staff.save.mockClear();
      staff.findOne
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'kept-key.jpg' }) // loadProfile (setAvailability)
        .mockResolvedValueOnce({ id: 'staff-1', avatar_storage_key: 'kept-key.jpg' }); // findOne (response)

      await service.setAvailability(TENANT, 'staff-1', false);
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledTimes(1);

      const availabilitySavedArg = staff.save.mock.calls.at(-1)?.[0];
      expect(availabilitySavedArg.avatar_url).toBeUndefined();
    });
  });

  describe('assignServices', () => {
    it('replaces qualified services after validating them', async () => {
      staff.findOne.mockResolvedValue({ id: 'staff-1' });
      repo(Service).find.mockResolvedValueOnce([{ id: 'svc1' }]);
      await service.assignServices(TENANT, 'staff-1', { serviceIds: ['svc1'] } as any);
      expect(repo(StaffServiceEntity).delete).toHaveBeenCalledWith({ staff: { id: 'staff-1' } });
      expect(repo(StaffServiceEntity).save).toHaveBeenCalled();
    });

    it('rejects inactive/foreign services with 422', async () => {
      staff.findOne.mockResolvedValue({ id: 'staff-1' });
      repo(Service).find.mockResolvedValueOnce([]); // none valid
      await expect(
        service.assignServices(TENANT, 'staff-1', { serviceIds: ['svc1'] } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });
  });

  describe('assignBranches', () => {
    it('rejects a primaryBranchId not in branchIds', async () => {
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1', user: { id: 'u1' } });
      await expect(
        service.assignBranches(TENANT, 'staff-1', { branchIds: ['b1'], primaryBranchId: 'b2' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects branches not in the clinic with 422', async () => {
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1', user: { id: 'u1' } });
      repo(Branch).find.mockResolvedValueOnce([]); // none valid
      await expect(
        service.assignBranches(TENANT, 'staff-1', { branchIds: ['b1'] } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('replaces branch assignments and returns the new list', async () => {
      staff.findOne.mockResolvedValue({ id: 'staff-1', user: { id: 'u1' } });
      repo(Branch).find.mockResolvedValueOnce([{ id: 'b1' }]);
      branchUsers.find.mockResolvedValueOnce([{ id: 'bu1' }]);
      const res = await service.assignBranches(TENANT, 'staff-1', { branchIds: ['b1'] } as any);
      expect(repo(BranchUser).delete).toHaveBeenCalled();
      expect(res).toEqual([{ id: 'bu1' }]);
    });
  });

  describe('findEligibleUsers', () => {
    it('excludes users who already have a staff profile and maps role info', async () => {
      staff.find.mockResolvedValueOnce([{ id: 'sp1', user: { id: 'u-linked' } }]);
      users.findAndCount.mockResolvedValueOnce([
        [
          {
            id: 'u1',
            full_name: 'Sara',
            email: 's@x.com',
            userRoles: [{ role: { slug: 'receptionist', name: 'Receptionist' } }],
          },
          { id: 'u2', full_name: 'No Role', email: 'n@x.com', userRoles: [] },
        ],
        2,
      ]);

      const res = await service.findEligibleUsers(TENANT, { page: 1, limit: 10 } as any);

      expect(res.total).toBe(2);
      expect(res.data[0]).toEqual({
        id: 'u1',
        fullName: 'Sara',
        email: 's@x.com',
        role: { slug: 'receptionist', name: 'Receptionist' },
      });
      expect(res.data[1].role).toBeNull();
    });

    it('adds a name/email OR filter when search is provided', async () => {
      staff.find.mockResolvedValueOnce([]);
      users.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findEligibleUsers(TENANT, { page: 1, limit: 10, search: 'sara' } as any);

      const [{ where }] = users.findAndCount.mock.calls[0];
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
    });
  });

  describe('createWithNewUser', () => {
    const dto = {
      email: 'New.Staff@Clinic.com',
      fullName: 'New Staff',
      title: 'Nurse',
      bookingBufferMinutes: 15,
    } as any;

    it('rejects a privileged role (delegates to RolesService, which throws FORBIDDEN)', async () => {
      rolesService.findAssignableRoleBySlug.mockRejectedValueOnce(
        new AppError(ErrorCode.FORBIDDEN, { message: 'Role "owner" cannot be assigned to staff' }),
      );

      await expect(
        service.createWithNewUser(TENANT, { ...dto, roleSlug: ROLE.OWNER } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(rolesService.findAssignableRoleBySlug).toHaveBeenCalledWith(ROLE.OWNER, TENANT);
    });

    it('rejects a primaryBranchId not in branchIds', async () => {
      await expect(
        service.createWithNewUser(TENANT, {
          ...dto,
          branchIds: ['b1'],
          primaryBranchId: 'b2',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects a duplicate email within the tenant', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'existing' });

      await expect(service.createWithNewUser(TENANT, dto)).rejects.toMatchObject({
        code: ErrorCode.EMAIL_ALREADY_EXISTS,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('propagates the plan user-limit failure from UsageService', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(10);
      usage.assertCountWithinLimit.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'user limit reached' }),
      );

      await expect(service.createWithNewUser(TENANT, dto)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('creates the user, role and profile atomically and returns a one-time temporary password', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(2);
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-1' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-1' });

      const result = await service.createWithNewUser(TENANT, dto);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(rolesService.findAssignableRoleBySlug).toHaveBeenCalledWith(ROLE.RECEPTIONIST, TENANT);
      expect(authService.createUserWithRole).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ email: 'new.staff@clinic.com', fullName: 'New Staff' }),
        { id: 'role-receptionist', slug: ROLE.RECEPTIONIST, name: 'Receptionist' },
        TENANT,
      );
      expect(result.profile).toEqual({ id: 'staff-1' });
      expect(typeof result.temporaryPassword).toBe('string');
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    });

    it('validates and assigns branches within the same transaction', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-2' });
      repo(Branch).find.mockResolvedValueOnce([{ id: 'b1' }]);
      staff.findOne.mockResolvedValueOnce({ id: 'staff-2' });

      await service.createWithNewUser(TENANT, { ...dto, branchIds: ['b1'] } as any);

      expect(repo(BranchUser).save).toHaveBeenCalled();
    });

    it('rejects a branch that does not belong to the clinic', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-3' });
      repo(Branch).find.mockResolvedValueOnce([]);

      await expect(
        service.createWithNewUser(TENANT, { ...dto, branchIds: ['b1'] } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('creates a doctor via the normal catalogue-role path (no special-casing)', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      rolesService.findAssignableRoleBySlug.mockResolvedValueOnce({
        id: 'role-doctor',
        slug: ROLE.DOCTOR,
        name: 'Doctor',
      });
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-4' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-4' });

      await service.createWithNewUser(TENANT, { ...dto, roleSlug: ROLE.DOCTOR } as any);

      expect(rolesService.findAssignableRoleBySlug).toHaveBeenCalledWith(ROLE.DOCTOR, TENANT);
      expect(rolesService.resolveCustomRole).not.toHaveBeenCalled();
    });

    it('"other": validates permissions up front, then synthesizes the custom role INSIDE the transaction', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      const resolvedPerms = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }];
      rolesService.validateCustomPermissions.mockResolvedValueOnce(resolvedPerms);
      rolesService.resolveCustomRole.mockResolvedValueOnce({
        id: 'role-custom-1',
        slug: 'custom-abc',
        name: 'Custom — New Staff',
      });
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-5' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-5' });

      const callerPermissions = [PERMISSION.APPOINTMENTS_READ, PERMISSION.CUSTOMERS_READ];
      await service.createWithNewUser(
        TENANT,
        { ...dto, roleSlug: CUSTOM_ROLE_SENTINEL, permissionSlugs: [PERMISSION.APPOINTMENTS_READ] } as any,
        callerPermissions,
      );

      expect(rolesService.validateCustomPermissions).toHaveBeenCalledWith(
        [PERMISSION.APPOINTMENTS_READ],
        callerPermissions,
      );
      expect(rolesService.resolveCustomRole).toHaveBeenCalledWith(
        TENANT,
        resolvedPerms,
        null,
        dto.fullName,
        manager,
      );
      expect(rolesService.findAssignableRoleBySlug).not.toHaveBeenCalled();
      expect(authService.createUserWithRole).toHaveBeenCalledWith(
        manager,
        expect.any(Object),
        { id: 'role-custom-1', slug: 'custom-abc', name: 'Custom — New Staff' },
        TENANT,
      );
    });

    it('"other": propagates the privilege-escalation rejection from RolesService WITHOUT opening a transaction', async () => {
      rolesService.validateCustomPermissions.mockRejectedValueOnce(
        new AppError(ErrorCode.FORBIDDEN, { message: 'You cannot grant a permission you do not hold' }),
      );

      await expect(
        service.createWithNewUser(
          TENANT,
          { ...dto, roleSlug: CUSTOM_ROLE_SENTINEL, permissionSlugs: [PERMISSION.BILLING_MANAGE] } as any,
          [PERMISSION.APPOINTMENTS_READ],
        ),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(rolesService.resolveCustomRole).not.toHaveBeenCalled();
    });

    it('writes an audit entry for the role assigned on creation, when an actor is given', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-6' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-6' });

      await service.createWithNewUser(TENANT, dto, [], 'actor-1');

      // `entity_id` is the profile id returned by the transaction itself
      // (the mock EntityManager auto-generates one) — not the `staff-6`
      // reload mock below, which only backs the final response projection.
      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'staff.role.assigned',
          entity_type: 'staff_profile',
          entity_id: 'generated-id',
        }),
      );
    });

    it('never throws when the audit write fails (best-effort)', async () => {
      users.findOne.mockResolvedValueOnce(null);
      users.count.mockResolvedValueOnce(0);
      authService.createUserWithRole.mockResolvedValueOnce({ id: 'new-user-7' });
      staff.findOne.mockResolvedValueOnce({ id: 'staff-7' });
      auditLogs.save.mockRejectedValueOnce(new Error('db down'));

      await expect(
        service.createWithNewUser(TENANT, dto, [], 'actor-1'),
      ).resolves.toEqual(expect.objectContaining({ profile: { id: 'staff-7' } }));
    });
  });

  describe('update — role changes', () => {
    const loadedProfile = { id: 'staff-1', title: 'Old', user: { id: 'u1', full_name: 'Sara' } };

    it('leaves the role untouched and skips the staff.manage check when roleSlug is omitted', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      await service.update(TENANT, 'staff-1', { title: 'New' } as any, []);
      expect(rolesService.listUserRoles).not.toHaveBeenCalled();
    });

    it('rejects a role change from a caller without staff.manage', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      await expect(
        service.update(TENANT, 'staff-1', { roleSlug: ROLE.DOCTOR } as any, [PERMISSION.STAFF_UPDATE]),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
      expect(rolesService.findAssignableRoleBySlug).not.toHaveBeenCalled();
    });

    it('refuses to change the role of an owner/super_admin-held account', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      rolesService.listUserRoles.mockResolvedValueOnce([{ id: 'r-owner', slug: ROLE.OWNER }]);

      await expect(
        service.update(TENANT, 'staff-1', { roleSlug: ROLE.DOCTOR } as any, [PERMISSION.STAFF_MANAGE]),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    });

    it('reassigns user_roles and revokes sessions when the role actually changes', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      rolesService.listUserRoles.mockResolvedValueOnce([
        { id: 'r-recep', slug: ROLE.RECEPTIONIST, is_system: true },
      ]);
      rolesService.findAssignableRoleBySlug.mockResolvedValueOnce({
        id: 'r-doctor',
        slug: ROLE.DOCTOR,
        name: 'Doctor',
      });

      await service.update(TENANT, 'staff-1', { roleSlug: ROLE.DOCTOR } as any, [PERMISSION.STAFF_MANAGE]);

      expect(repo(UserRole).delete).toHaveBeenCalledWith({ user: { id: 'u1' } });
      expect(repo(UserRole).save).toHaveBeenCalled();
      expect(authService.revokeAllForUser).toHaveBeenCalledWith('u1');
    });

    it('is a no-op when the requested CATALOGUE role is already the sole held role — never opens a transaction', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      rolesService.listUserRoles.mockResolvedValueOnce([{ id: 'r-doctor', slug: ROLE.DOCTOR }]);
      rolesService.findAssignableRoleBySlug.mockResolvedValueOnce({
        id: 'r-doctor',
        slug: ROLE.DOCTOR,
        name: 'Doctor',
      });

      await service.update(TENANT, 'staff-1', { roleSlug: ROLE.DOCTOR } as any, [PERMISSION.STAFF_MANAGE]);

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(authService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('"other": validates permissions up front, then resolves the custom role INSIDE the transaction', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      rolesService.listUserRoles.mockResolvedValueOnce([
        { id: 'r-recep', slug: ROLE.RECEPTIONIST, is_system: true },
      ]);
      const resolvedPerms = [{ id: 'p1', slug: PERMISSION.APPOINTMENTS_READ }];
      rolesService.validateCustomPermissions.mockResolvedValueOnce(resolvedPerms);
      rolesService.resolveCustomRole.mockResolvedValueOnce({
        id: 'role-custom-2',
        slug: 'custom-xyz',
        name: 'Custom — Sara',
      });

      const callerPermissions = [PERMISSION.STAFF_MANAGE, PERMISSION.APPOINTMENTS_READ];
      await service.update(
        TENANT,
        'staff-1',
        { roleSlug: CUSTOM_ROLE_SENTINEL, permissionSlugs: [PERMISSION.APPOINTMENTS_READ] } as any,
        callerPermissions,
      );

      expect(rolesService.validateCustomPermissions).toHaveBeenCalledWith(
        [PERMISSION.APPOINTMENTS_READ],
        callerPermissions,
      );
      expect(rolesService.resolveCustomRole).toHaveBeenCalledWith(
        TENANT,
        resolvedPerms,
        'u1',
        'Sara',
        manager,
      );
    });

    it('cleans up the old custom role if it becomes orphaned by the reassignment', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      const oldRole = { id: 'role-old-custom', slug: 'custom-old', is_system: false };
      rolesService.listUserRoles.mockResolvedValueOnce([oldRole]);
      rolesService.findOne.mockResolvedValueOnce({ ...oldRole, name: 'Custom — Sara', rolePermissions: [] });
      rolesService.findAssignableRoleBySlug.mockResolvedValueOnce({
        id: 'r-doctor',
        slug: ROLE.DOCTOR,
        name: 'Doctor',
      });

      await service.update(TENANT, 'staff-1', { roleSlug: ROLE.DOCTOR } as any, [PERMISSION.STAFF_MANAGE]);

      expect(rolesService.deleteIfOrphanedCustomRole).toHaveBeenCalledWith(oldRole, manager);
    });

    it('writes an audit entry with the previous and new role on a real change', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      const oldRole = { id: 'r-recep', slug: ROLE.RECEPTIONIST, is_system: true, name: 'Receptionist' };
      rolesService.listUserRoles.mockResolvedValueOnce([oldRole]);
      rolesService.findAssignableRoleBySlug.mockResolvedValueOnce({
        id: 'r-doctor',
        slug: ROLE.DOCTOR,
        name: 'Doctor',
      });

      await service.update(
        TENANT,
        'staff-1',
        { roleSlug: ROLE.DOCTOR } as any,
        [PERMISSION.STAFF_MANAGE],
        'actor-1',
      );

      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'staff.role.changed',
          entity_type: 'staff_profile',
          entity_id: 'staff-1',
          old_values: expect.objectContaining({
            target_user_id: 'u1',
            role: expect.objectContaining({ slug: ROLE.RECEPTIONIST }),
          }),
          new_values: expect.objectContaining({
            role: expect.objectContaining({ slug: ROLE.DOCTOR }),
          }),
        }),
      );
    });

    it('does not audit a true no-op (same catalogue role reselected)', async () => {
      staff.findOne.mockResolvedValue(loadedProfile);
      rolesService.listUserRoles.mockResolvedValueOnce([{ id: 'r-doctor', slug: ROLE.DOCTOR }]);
      rolesService.findAssignableRoleBySlug.mockResolvedValueOnce({
        id: 'r-doctor',
        slug: ROLE.DOCTOR,
        name: 'Doctor',
      });

      await service.update(
        TENANT,
        'staff-1',
        { roleSlug: ROLE.DOCTOR } as any,
        [PERMISSION.STAFF_MANAGE],
        'actor-1',
      );

      expect(auditLogs.save).not.toHaveBeenCalled();
    });
  });

  describe('findAssignablePermissions', () => {
    it('delegates to RolesService.findGrantableForCaller and projects the assignable-permission view', async () => {
      const perms = [
        {
          id: 'p1',
          slug: PERMISSION.APPOINTMENTS_READ_OWN,
          name: 'Read own appointments',
          module: 'appointments',
          description: 'View only the appointments the current user owns.',
          scope: 'tenant',
        },
      ];
      rolesService.findGrantableForCaller.mockResolvedValueOnce(perms);

      const callerPermissions = [PERMISSION.APPOINTMENTS_READ_OWN];
      await expect(service.findAssignablePermissions(callerPermissions)).resolves.toEqual([
        {
          id: 'p1',
          slug: PERMISSION.APPOINTMENTS_READ_OWN,
          name: 'Read own appointments',
          module: 'appointments',
          description: 'View only the appointments the current user owns.',
          scope: 'tenant',
          isOwnershipScoped: true,
        },
      ]);
      expect(rolesService.findGrantableForCaller).toHaveBeenCalledWith(callerPermissions);
    });
  });

  describe('findAssignableRolePermissions', () => {
    it("delegates to RolesService.findAssignableRolePermissions and projects the role's full permission set", async () => {
      const perms = [
        {
          id: 'p1',
          slug: PERMISSION.APPOINTMENTS_READ_OWN,
          name: 'Read own appointments',
          module: 'appointments',
          description: 'View only the appointments the current user owns.',
          scope: 'tenant',
        },
        {
          id: 'p2',
          slug: PERMISSION.DASHBOARD_ACCESS,
          name: 'Access clinic dashboard',
          module: 'general',
          description: null,
          scope: 'tenant',
        },
      ];
      rolesService.findAssignableRolePermissions.mockResolvedValueOnce(perms);

      await expect(
        service.findAssignableRolePermissions('role-doctor', TENANT),
      ).resolves.toEqual([
        {
          id: 'p1',
          slug: PERMISSION.APPOINTMENTS_READ_OWN,
          name: 'Read own appointments',
          module: 'appointments',
          description: 'View only the appointments the current user owns.',
          scope: 'tenant',
          isOwnershipScoped: true,
        },
        {
          id: 'p2',
          slug: PERMISSION.DASHBOARD_ACCESS,
          name: 'Access clinic dashboard',
          module: 'general',
          description: null,
          scope: 'tenant',
          isOwnershipScoped: false,
        },
      ]);
      expect(rolesService.findAssignableRolePermissions).toHaveBeenCalledWith('role-doctor', TENANT);
    });

    it('returns an empty array when the role grants nothing', async () => {
      rolesService.findAssignableRolePermissions.mockResolvedValueOnce([]);
      await expect(
        service.findAssignableRolePermissions('role-empty', TENANT),
      ).resolves.toEqual([]);
    });
  });

  describe('findAssignableRoles', () => {
    it('delegates to RolesService.findAssignableForStaff', async () => {
      const roles = [{ id: 'r1', slug: 'receptionist', name: 'Receptionist' }];
      rolesService.findAssignableForStaff.mockResolvedValueOnce(roles);

      await expect(service.findAssignableRoles(TENANT)).resolves.toEqual(roles);
      expect(rolesService.findAssignableForStaff).toHaveBeenCalledWith(TENANT);
    });
  });
});
