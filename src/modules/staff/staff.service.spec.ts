import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffService } from './staff.service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { User } from '../../entities/Auth&RBAC/User';
import { Service } from '../../entities/Services/Service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AppError, ErrorCode } from '../../common/errors';
import { AuthService } from '../auth/auth.service';
import { UsageService } from '../subscription-billing/usage.service';
import { ROLE } from '../../rbac/rbac.constants';
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
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let authService: { createUserWithRole: jest.Mock };
  let usage: { assertCountWithinLimit: jest.Mock };

  beforeEach(async () => {
    staff = createMockRepository();
    staffServices = createMockRepository();
    branchUsers = createMockRepository();
    users = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    authService = { createUserWithRole: jest.fn() };
    usage = { assertCountWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
        { provide: getRepositoryToken(StaffServiceEntity), useValue: staffServices },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Service), useValue: createMockRepository() },
        { provide: getRepositoryToken(Branch), useValue: createMockRepository() },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthService, useValue: authService },
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

    it('rejects a privileged role', async () => {
      await expect(
        service.createWithNewUser(TENANT, { ...dto, roleSlug: ROLE.OWNER } as any),
      ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
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
      expect(authService.createUserWithRole).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ email: 'new.staff@clinic.com', fullName: 'New Staff' }),
        ROLE.RECEPTIONIST,
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
  });
});
