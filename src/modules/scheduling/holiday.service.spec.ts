import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { HolidayService } from './holiday.service';
import { SchedulingRefService } from './scheduling-ref.service';
import { Holiday } from '../../entities/Calendar&Appointments/Holiday';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('HolidayService', () => {
  let service: HolidayService;
  let holidays: MockRepository;
  let refs: { assertBranch: jest.Mock; assertStaff: jest.Mock };

  beforeEach(async () => {
    holidays = createMockRepository();
    refs = { assertBranch: jest.fn().mockResolvedValue(undefined), assertStaff: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        HolidayService,
        { provide: getRepositoryToken(Holiday), useValue: holidays },
        { provide: SchedulingRefService, useValue: refs },
      ],
    }).compile();
    service = moduleRef.get(HolidayService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a branch-specific holiday after validating the branch', async () => {
    holidays.save.mockResolvedValueOnce({ id: 'h1' });
    await service.create(TENANT, { name: 'Eid', date: '2026-07-01', branchId: 'b1' } as any);
    expect(refs.assertBranch).toHaveBeenCalledWith(TENANT, 'b1');
  });

  it('creates a company-wide holiday without a branch check', async () => {
    holidays.save.mockResolvedValueOnce({ id: 'h1' });
    await service.create(TENANT, { name: 'NY', date: '2026-01-01' } as any);
    expect(refs.assertBranch).not.toHaveBeenCalled();
  });

  it('updates a holiday', async () => {
    holidays.findOne.mockResolvedValueOnce({ id: 'h1', name: 'Old' });
    holidays.save.mockImplementationOnce(async (h: any) => h);
    const res = await service.update(TENANT, 'h1', { name: 'New' } as any);
    expect(res).toEqual(expect.objectContaining({ name: 'New' }));
  });

  it('throws when the holiday does not exist', async () => {
    holidays.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('lists holidays with a date range filter', async () => {
    holidays.findAndCount.mockResolvedValueOnce([[{ id: 'h1' }], 1]);
    const res = await service.list(TENANT, { page: 1, limit: 10, from: '2026-01-01', to: '2026-12-31' } as any);
    expect(res.total).toBe(1);
  });

  describe('findForDate (availability helper)', () => {
    it('matches an exact date and a recurring month/day', async () => {
      const qb = createMockQueryBuilder();
      qb.getMany.mockResolvedValueOnce([
        { id: 'exact', date: '2026-07-01', is_recurring: false },
        { id: 'recurring', date: '2020-07-01', is_recurring: true }, // same MM-DD, different year
        { id: 'other', date: '2020-12-25', is_recurring: true },
      ]);
      holidays.createQueryBuilder.mockReturnValueOnce(qb);

      const result = await service.findForDate(TENANT, 'b1', '2026-07-01');
      expect(result.map((h) => h.id)).toEqual(['exact', 'recurring']);
    });
  });
});
