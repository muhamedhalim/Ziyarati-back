import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BranchService } from './branch.service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
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
  let usage: { assertCountWithinLimit: jest.Mock };
  let redis: { application: { get: jest.Mock; set: jest.Mock } };

  beforeEach(async () => {
    branches = createMockRepository();
    branchUsers = createMockRepository();
    appointments = createMockRepository();
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
