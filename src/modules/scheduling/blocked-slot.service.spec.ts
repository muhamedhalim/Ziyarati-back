import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BlockedSlotService } from './blocked-slot.service';
import { SchedulingRefService } from './scheduling-ref.service';
import { BlockedSlot } from '../../entities/Calendar&Appointments/BlockedSlot';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('BlockedSlotService', () => {
  let service: BlockedSlotService;
  let blocks: MockRepository;
  let refs: { assertBranch: jest.Mock; assertStaff: jest.Mock };

  beforeEach(async () => {
    blocks = createMockRepository();
    refs = { assertBranch: jest.fn().mockResolvedValue(undefined), assertStaff: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BlockedSlotService,
        { provide: getRepositoryToken(BlockedSlot), useValue: blocks },
        { provide: SchedulingRefService, useValue: refs },
      ],
    }).compile();
    service = moduleRef.get(BlockedSlotService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a block after validating branch + staff', async () => {
    blocks.save.mockResolvedValueOnce({ id: 'bl1' });
    await service.create(TENANT, {
      branchId: 'b1',
      staffId: 's1',
      startTime: '2026-07-01T10:00:00Z',
      endTime: '2026-07-01T12:00:00Z',
    } as any);
    expect(refs.assertBranch).toHaveBeenCalledWith(TENANT, 'b1');
    expect(refs.assertStaff).toHaveBeenCalledWith(TENANT, 's1');
  });

  it('rejects an inverted time range with 422', async () => {
    await expect(
      service.create(TENANT, { startTime: '2026-07-01T12:00:00Z', endTime: '2026-07-01T10:00:00Z' } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('updates a block', async () => {
    blocks.findOne.mockResolvedValueOnce({
      id: 'bl1',
      start_time: new Date('2026-07-01T10:00:00Z'),
      end_time: new Date('2026-07-01T12:00:00Z'),
    });
    blocks.save.mockImplementationOnce(async (b: any) => b);
    const res = await service.update(TENANT, 'bl1', { reason: 'maintenance' } as any);
    expect(res).toEqual(expect.objectContaining({ reason: 'maintenance' }));
  });

  it('throws when the block does not exist', async () => {
    blocks.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('lists blocks with filters', async () => {
    blocks.findAndCount.mockResolvedValueOnce([[{ id: 'bl1' }], 1]);
    const res = await service.list(TENANT, { page: 1, limit: 10, branchId: 'b1', from: '2026-07-01', to: '2026-07-31' } as any);
    expect(res.total).toBe(1);
  });

  it('findOverlapping queries via the query builder with a staff predicate', async () => {
    const qb = createMockQueryBuilder();
    qb.getMany.mockResolvedValueOnce([{ id: 'bl1' }]);
    blocks.createQueryBuilder.mockReturnValueOnce(qb);
    const res = await service.findOverlapping(TENANT, 'b1', new Date(), new Date(), 's1');
    expect(res).toHaveLength(1);
    expect(qb.andWhere).toHaveBeenCalled();
  });
});
