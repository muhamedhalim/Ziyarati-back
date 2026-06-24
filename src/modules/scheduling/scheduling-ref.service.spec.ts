import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SchedulingRefService } from './scheduling-ref.service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('SchedulingRefService', () => {
  let service: SchedulingRefService;
  let branches: MockRepository;
  let staff: MockRepository;

  beforeEach(async () => {
    branches = createMockRepository();
    staff = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulingRefService,
        { provide: getRepositoryToken(Branch), useValue: branches },
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
      ],
    }).compile();
    service = moduleRef.get(SchedulingRefService);
  });

  afterEach(() => jest.clearAllMocks());

  it('getBranch returns a tenant-owned branch', async () => {
    branches.findOne.mockResolvedValueOnce({ id: 'b1', timezone: 'UTC' });
    await expect(service.getBranch(TENANT, 'b1')).resolves.toMatchObject({ id: 'b1' });
  });

  it('assertBranch throws 404 for an unknown branch', async () => {
    branches.findOne.mockResolvedValueOnce(null);
    await expect(service.assertBranch(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('getStaff returns a tenant-owned staff profile', async () => {
    staff.findOne.mockResolvedValueOnce({ id: 's1', is_available_for_booking: true });
    await expect(service.getStaff(TENANT, 's1')).resolves.toMatchObject({ id: 's1' });
  });

  it('assertStaff throws 404 for an unknown staff member', async () => {
    staff.findOne.mockResolvedValueOnce(null);
    await expect(service.assertStaff(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
