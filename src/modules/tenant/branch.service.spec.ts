import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BranchService } from './branch.service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { BranchCityService } from './branch-city.service';
import { UsageService } from '../subscription-billing/usage.service';
import { AppRedisService } from '../../queue/app-redis.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('BranchService', () => {
  let service: BranchService;
  let branches: MockRepository;
  let branchUsers: MockRepository;
  let appointments: MockRepository;
  let tenants: MockRepository;
  let cities: {
    resolveByName: jest.Mock;
    exists: jest.Mock;
    loadByIds: jest.Mock;
  };
  let usage: { assertCountWithinLimit: jest.Mock };
  let redis: { application: { get: jest.Mock; set: jest.Mock } };

  beforeEach(async () => {
    branches = createMockRepository();
    branchUsers = createMockRepository();
    appointments = createMockRepository();
    tenants = createMockRepository();
    tenants.findOne.mockResolvedValue({
      id: TENANT,
      default_timezone: 'Africa/Cairo',
      country_id: 3,
    });
    cities = {
      resolveByName: jest.fn().mockResolvedValue('city-1'),
      exists: jest.fn().mockResolvedValue(true),
      loadByIds: jest.fn().mockResolvedValue(new Map()),
    };
    usage = { assertCountWithinLimit: jest.fn().mockResolvedValue(undefined) };
    redis = {
      application: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      },
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BranchService,
        // The REAL BranchScopeService, not a double: the membership lookup +
        // its Redis cache moved there from BranchService, and this suite's
        // FND-017 cases (including the caching assertion below) are the
        // tests that prove that behaviour. Mocking it would delete their
        // coverage rather than relocate it. Its own collaborators stay the
        // same mocks this suite already had.
        BranchScopeService,
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(BranchUser), useValue: branchUsers },
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: getRepositoryToken(Tenant), useValue: tenants },
        { provide: BranchCityService, useValue: cities },
        { provide: UsageService, useValue: usage },
        { provide: AppRedisService, useValue: redis },
        { provide: TenantContextService, useValue: new TenantContextService() },
      ],
    }).compile();
    service = moduleRef.get(BranchService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a branch after enforcing the plan branch limit', async () => {
    branches.count.mockResolvedValueOnce(2);
    branches.save.mockResolvedValueOnce({ id: 'b1' });
    await service.create(TENANT, { name: 'Main' } as any);
    expect(usage.assertCountWithinLimit).toHaveBeenCalledWith(
      TENANT,
      'max_branches',
      2,
    );
  });

  it('propagates a plan-limit rejection', async () => {
    branches.count.mockResolvedValueOnce(10);
    usage.assertCountWithinLimit.mockRejectedValueOnce(
      Object.assign(new Error('limit'), {
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      }),
    );
    await expect(
      service.create(TENANT, { name: 'X' } as any),
    ).rejects.toBeDefined();
    expect(branches.save).not.toHaveBeenCalled();
  });

  describe('city / location', () => {
    beforeEach(() => {
      branches.create.mockImplementation((b: any) => b);
      branches.save.mockImplementation(async (b: any) => ({ id: 'b1', ...b }));
      cities.loadByIds.mockResolvedValue(
        new Map([
          ['city-1', { id: 'city-1', name_ar: null, name_en: 'Riyadh' }],
        ]),
      );
    });

    it('create resolves the typed city and persists it as city_id (reusing branches.city_id)', async () => {
      branches.count.mockResolvedValueOnce(0);
      const res = await service.create(TENANT, {
        name: 'Main',
        city: 'Riyadh',
      } as any);
      expect(cities.resolveByName).toHaveBeenCalledWith('Riyadh', 3);
      expect(branches.save).toHaveBeenCalledWith(
        expect.objectContaining({ city_id: 'city-1' }),
      );
      expect(res.city).toEqual({
        id: 'city-1',
        name_ar: null,
        name_en: 'Riyadh',
      });
    });

    it('create derives the tenant from the argument only and inherits the clinic default timezone', async () => {
      branches.count.mockResolvedValueOnce(0);
      await service.create(TENANT, { name: 'Main', city: 'Riyadh' } as any);
      expect(tenants.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TENANT } }),
      );
      expect(branches.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: { id: TENANT },
          timezone: 'Africa/Cairo',
        }),
      );
    });

    it('an explicit timezone from an API caller still wins over the clinic default', async () => {
      branches.count.mockResolvedValueOnce(0);
      await service.create(TENANT, {
        name: 'Main',
        timezone: 'Asia/Dubai',
      } as any);
      expect(branches.save).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'Asia/Dubai' }),
      );
    });

    it('update changes only the location and keeps the other fields', async () => {
      branches.findOne.mockResolvedValue({
        id: 'b1',
        name: 'Main Branch',
        city_id: 'old',
        timezone: 'UTC',
      });
      const res = await service.update(TENANT, 'b1', {
        city: 'الرياض',
      } as any);
      expect(cities.resolveByName).toHaveBeenCalledWith('الرياض', 3);
      expect(res.name).toBe('Main Branch');
      expect(res.city_id).toBe('city-1');
    });

    it('a partial update without a city never re-resolves or clears it', async () => {
      branches.findOne.mockResolvedValue({
        id: 'b1',
        name: 'Main Branch',
        city_id: 'old',
      });
      const res = await service.update(TENANT, 'b1', {
        isActive: false,
      } as any);
      expect(cities.resolveByName).not.toHaveBeenCalled();
      expect(res.city_id).toBe('old');
    });

    it("update is tenant-scoped: another clinic's branch is a 404 and nothing is written", async () => {
      branches.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update(TENANT, 'foreign', { city: 'Riyadh' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      expect(branches.findOne).toHaveBeenCalledWith({
        where: { id: 'foreign', tenant: { id: TENANT } },
      });
      expect(cities.resolveByName).not.toHaveBeenCalled();
      expect(branches.save).not.toHaveBeenCalled();
    });

    it('update_own callers may not change the location of a branch they are not assigned to', async () => {
      branches.findOne.mockResolvedValue({ id: 'b1', name: 'Main' });
      branchUsers.find.mockResolvedValueOnce([{ branch: { id: 'other' } }]);
      await expect(
        service.update(TENANT, 'b1', { city: 'Riyadh' } as any, {
          id: 'u2',
          permissions: [PERMISSION.BRANCHES_UPDATE_OWN],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
      expect(cities.resolveByName).not.toHaveBeenCalled();
    });

    it('rejects sending both city and cityId', async () => {
      branches.findOne.mockResolvedValue({ id: 'b1', name: 'Main' });
      await expect(
        service.update(TENANT, 'b1', { city: 'Riyadh', cityId: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects a cityId that does not exist', async () => {
      branches.findOne.mockResolvedValue({ id: 'b1', name: 'Main' });
      cities.exists.mockResolvedValueOnce(false);
      await expect(
        service.update(TENANT, 'b1', { cityId: 'missing' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(branches.save).not.toHaveBeenCalled();
    });

    it("findAll attaches each branch's city with a single batched lookup", async () => {
      branches.find.mockResolvedValueOnce([
        { id: 'b1', city_id: 'city-1' },
        { id: 'b2', city_id: null },
      ]);
      const res = await service.findAll(TENANT);
      expect(cities.loadByIds).toHaveBeenCalledTimes(1);
      expect(res[0].city?.name_en).toBe('Riyadh');
      expect(res[1].city).toBeNull();
    });
  });

  it('findOne throws for an unknown branch', async () => {
    branches.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('updates and soft-removes when deletion is safe', async () => {
    branches.findOne.mockResolvedValue({ id: 'b1', name: 'Old' });
    branches.save.mockImplementation(async (b: any) => b);
    const res = await service.update(TENANT, 'b1', { name: 'New' } as any);
    expect(res.name).toBe('New');

    branches.count.mockResolvedValueOnce(2); // not the only branch
    branchUsers.count.mockResolvedValueOnce(0); // no staff assigned
    appointments.count.mockResolvedValueOnce(0); // no upcoming appointments
    await service.remove(TENANT, 'b1');
    expect(branches.softRemove).toHaveBeenCalled();
  });

  describe('FND-017 — branches.update_own ABAC scoping', () => {
    const CALLER_WITH_FULL = {
      id: 'u1',
      permissions: [PERMISSION.BRANCHES_UPDATE],
    };
    const CALLER_OWN_ONLY = {
      id: 'u2',
      permissions: [PERMISSION.BRANCHES_UPDATE_OWN],
    };

    beforeEach(() => {
      branches.findOne.mockResolvedValue({ id: 'b1', name: 'Old' });
      branches.save.mockImplementation(async (b: any) => b);
    });

    it('a caller holding branches.update (tenant-wide) updates any branch with no membership check', async () => {
      const res = await service.update(
        TENANT,
        'b1',
        { name: 'New' } as any,
        CALLER_WITH_FULL,
      );
      expect(res.name).toBe('New');
      expect(branchUsers.find).not.toHaveBeenCalled();
    });

    it('a caller holding only branches.update_own updates a branch they are assigned to', async () => {
      branchUsers.find.mockResolvedValueOnce([{ branch: { id: 'b1' } }]);
      const res = await service.update(
        TENANT,
        'b1',
        { name: 'New' } as any,
        CALLER_OWN_ONLY,
      );
      expect(res.name).toBe('New');
    });

    it('refuses a branches.update_own caller updating a DIFFERENT branch than they are assigned to', async () => {
      branchUsers.find.mockResolvedValueOnce([{ branch: { id: 'b-other' } }]);
      await expect(
        service.update(TENANT, 'b1', { name: 'New' } as any, CALLER_OWN_ONLY),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
      expect(branches.save).not.toHaveBeenCalled();
    });

    it('refuses a branches.update_own caller assigned to no branch at all', async () => {
      branchUsers.find.mockResolvedValueOnce([]);
      await expect(
        service.update(TENANT, 'b1', { name: 'New' } as any, CALLER_OWN_ONLY),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    });

    it('caches the resolved branch membership under a tenant-qualified key, so a second call skips the DB', async () => {
      branchUsers.find.mockResolvedValueOnce([{ branch: { id: 'b1' } }]);
      await service.update(TENANT, 'b1', { name: 'A' } as any, CALLER_OWN_ONLY);
      expect(redis.application.set).toHaveBeenCalledWith(
        `branch-membership:${TENANT}:u2`,
        JSON.stringify(['b1']),
        'EX',
        60,
      );

      redis.application.get.mockResolvedValueOnce(JSON.stringify(['b1']));
      branchUsers.find.mockClear();
      await service.update(TENANT, 'b1', { name: 'B' } as any, CALLER_OWN_ONLY);
      expect(branchUsers.find).not.toHaveBeenCalled();
    });

    it("with no caller supplied (internal/system call), proceeds unrestricted — matches AppointmentsService.findOne's optional-caller convention", async () => {
      const res = await service.update(TENANT, 'b1', { name: 'New' } as any);
      expect(res.name).toBe('New');
      expect(branchUsers.find).not.toHaveBeenCalled();
    });
  });

  describe('safe deletion rules', () => {
    beforeEach(() => {
      branches.findOne.mockResolvedValue({ id: 'b1', name: 'Branch' });
    });

    it("rejects deleting the clinic's only branch", async () => {
      branches.count.mockResolvedValueOnce(1);
      await expect(service.remove(TENANT, 'b1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(branches.softRemove).not.toHaveBeenCalled();
    });

    it('rejects deleting a branch with assigned staff', async () => {
      branches.count.mockResolvedValueOnce(2);
      branchUsers.count.mockResolvedValueOnce(1);
      await expect(service.remove(TENANT, 'b1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(branches.softRemove).not.toHaveBeenCalled();
    });

    it('rejects deleting a branch with upcoming appointments', async () => {
      branches.count.mockResolvedValueOnce(2);
      branchUsers.count.mockResolvedValueOnce(0);
      appointments.count.mockResolvedValueOnce(1);
      await expect(service.remove(TENANT, 'b1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      expect(branches.softRemove).not.toHaveBeenCalled();
    });

    it('allows deletion once safe (other branches exist, no staff, no upcoming appointments)', async () => {
      branches.count.mockResolvedValueOnce(2);
      branchUsers.count.mockResolvedValueOnce(0);
      appointments.count.mockResolvedValueOnce(0);
      await service.remove(TENANT, 'b1');
      expect(branches.softRemove).toHaveBeenCalled();
    });
  });
});
