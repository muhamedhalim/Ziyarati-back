import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CalendarSlotService } from './calendar-slot.service';
import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlot } from '../../entities/Calendar&Appointments/CalendarSlot';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('CalendarSlotService', () => {
  let service: CalendarSlotService;
  let slots: MockRepository;
  let refs: { assertBranch: jest.Mock; assertStaff: jest.Mock };

  beforeEach(async () => {
    slots = createMockRepository();
    refs = { assertBranch: jest.fn().mockResolvedValue(undefined), assertStaff: jest.fn().mockResolvedValue(undefined) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarSlotService,
        { provide: getRepositoryToken(CalendarSlot), useValue: slots },
        { provide: SchedulingRefService, useValue: refs },
      ],
    }).compile();
    service = moduleRef.get(CalendarSlotService);
  });

  afterEach(() => jest.clearAllMocks());

  const validDto = {
    branchId: 'b1',
    staffId: 's1',
    startTime: '2026-07-01T10:00:00Z',
    endTime: '2026-07-01T12:00:00Z',
  };

  it('creates a slot after validating branch + staff', async () => {
    slots.save.mockResolvedValueOnce({ id: 'sl1' });
    await service.create(TENANT, validDto as any);
    expect(refs.assertBranch).toHaveBeenCalledWith(TENANT, 'b1');
    expect(refs.assertStaff).toHaveBeenCalledWith(TENANT, 's1');
  });

  it('rejects an inverted time range with 422', async () => {
    await expect(
      service.create(TENANT, { ...validDto, startTime: validDto.endTime, endTime: validDto.startTime } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('enable / disable toggle availability', async () => {
    slots.findOne.mockResolvedValue({ id: 'sl1', is_available: false });
    slots.save.mockImplementation(async (s: any) => s);
    expect((await service.enable(TENANT, 'sl1')).is_available).toBe(true);
    expect((await service.disable(TENANT, 'sl1')).is_available).toBe(false);
  });

  it('get throws when the slot does not exist', async () => {
    slots.findOne.mockResolvedValueOnce(null);
    await expect(service.get(TENANT, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('removes a slot', async () => {
    slots.findOne.mockResolvedValueOnce({ id: 'sl1' });
    await expect(service.remove(TENANT, 'sl1')).resolves.toEqual({ id: 'sl1', deleted: true });
  });

  it('lists slots with filters', async () => {
    slots.findAndCount.mockResolvedValueOnce([[{ id: 'sl1' }], 1]);
    const res = await service.list(TENANT, { page: 1, limit: 10, branchId: 'b1', isAvailable: true } as any);
    expect(res.total).toBe(1);
  });

  it('findCovering / findAvailableForDay query available slots', async () => {
    slots.find.mockResolvedValue([{ id: 'sl1' }]);
    await expect(service.findCovering(TENANT, 'b1', 's1', new Date(), new Date())).resolves.toHaveLength(1);
    await expect(service.findAvailableForDay(TENANT, 'b1', new Date(), new Date(), 's1')).resolves.toHaveLength(1);
  });
});
