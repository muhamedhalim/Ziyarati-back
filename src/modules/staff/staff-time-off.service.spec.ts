import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffTimeOffService } from './staff-time-off.service';
import { StaffTimeOff } from '../../entities/Staff/StaffTimeOff';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const STAFF = 's1';

describe('StaffTimeOffService', () => {
  let service: StaffTimeOffService;
  let timeOff: MockRepository;
  let staff: MockRepository;

  beforeEach(async () => {
    timeOff = createMockRepository();
    staff = createMockRepository();
    staff.exists.mockResolvedValue(true);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffTimeOffService,
        { provide: getRepositoryToken(StaffTimeOff), useValue: timeOff },
        { provide: getRepositoryToken(StaffProfile), useValue: staff },
      ],
    }).compile();
    service = moduleRef.get(StaffTimeOffService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a time-off record', async () => {
    timeOff.save.mockResolvedValueOnce({ id: 'to1' });
    await expect(
      service.create(TENANT, STAFF, { startDate: '2026-07-01', endDate: '2026-07-05', reason: 'leave' } as any),
    ).resolves.toEqual({ id: 'to1' });
  });

  it('rejects an unknown staff member', async () => {
    staff.exists.mockResolvedValueOnce(false);
    await expect(
      service.create(TENANT, STAFF, { startDate: '2026-07-01', endDate: '2026-07-05' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('rejects an end date before the start date', async () => {
    await expect(
      service.create(TENANT, STAFF, { startDate: '2026-07-05', endDate: '2026-07-01' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('isOffOn delegates to an exists() range check', async () => {
    timeOff.exists.mockResolvedValueOnce(true);
    await expect(service.isOffOn(TENANT, STAFF, '2026-07-03')).resolves.toBe(true);
  });

  it('lists time-off records', async () => {
    timeOff.find.mockResolvedValueOnce([{ id: 'to1' }]);
    await expect(service.list(TENANT, STAFF)).resolves.toHaveLength(1);
  });

  it('removes a record, throwing when nothing was deleted', async () => {
    timeOff.delete.mockResolvedValueOnce({ affected: 1 });
    await expect(service.remove(TENANT, STAFF, 'to1')).resolves.toBeUndefined();

    timeOff.delete.mockResolvedValueOnce({ affected: 0 });
    await expect(service.remove(TENANT, STAFF, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
