import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BranchService } from './branch.service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { UsageService } from '../subscription-billing/usage.service';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('BranchService', () => {
  let service: BranchService;
  let branches: MockRepository;
  let usage: { assertCountWithinLimit: jest.Mock };

  beforeEach(async () => {
    branches = createMockRepository();
    usage = { assertCountWithinLimit: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BranchService,
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: UsageService, useValue: usage },
      ],
    }).compile();
    service = moduleRef.get(BranchService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a branch after enforcing the plan branch limit', async () => {
    branches.count.mockResolvedValueOnce(2);
    branches.save.mockResolvedValueOnce({ id: 'b1' });
    await service.create(TENANT, { name: 'Main' } as any);
    expect(usage.assertCountWithinLimit).toHaveBeenCalledWith(TENANT, 'max_branches', 2);
  });

  it('propagates a plan-limit rejection', async () => {
    branches.count.mockResolvedValueOnce(10);
    usage.assertCountWithinLimit.mockRejectedValueOnce(
      Object.assign(new Error('limit'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
    );
    await expect(service.create(TENANT, { name: 'X' } as any)).rejects.toBeDefined();
    expect(branches.save).not.toHaveBeenCalled();
  });

  it('findOne throws for an unknown branch', async () => {
    branches.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('updates and soft-removes', async () => {
    branches.findOne.mockResolvedValue({ id: 'b1', name: 'Old' });
    branches.save.mockImplementation(async (b: any) => b);
    const res = await service.update(TENANT, 'b1', { name: 'New' } as any);
    expect(res.name).toBe('New');

    await service.remove(TENANT, 'b1');
    expect(branches.softRemove).toHaveBeenCalled();
  });
});
