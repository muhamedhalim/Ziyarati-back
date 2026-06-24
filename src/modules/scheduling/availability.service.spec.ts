import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AvailabilityService } from './availability.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlotService } from './calendar-slot.service';
import { BlockedSlotService } from './blocked-slot.service';
import { HolidayService } from './holiday.service';
import { StaffScheduleService } from '../staff/staff-schedule.service';
import { StaffTimeOffService } from '../staff/staff-time-off.service';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const BRANCH = 'b1';
const STAFF = 's1';
const START = new Date('2026-07-01T10:00:00.000Z');
const END = new Date('2026-07-01T10:30:00.000Z');

describe('AvailabilityService.assertBookable', () => {
  let service: AvailabilityService;
  let appointments: MockRepository;
  let refs: { getBranch: jest.Mock; getStaff: jest.Mock };
  let slotService: { findAvailableForDay: jest.Mock };
  let blockedService: { findOverlapping: jest.Mock };
  let holidayService: { findForDate: jest.Mock };
  let staffSchedule: { getAvailability: jest.Mock };
  let staffTimeOff: { isOffOn: jest.Mock };

  /** A calendar slot covering the whole day → positive availability covers the booking. */
  const fullDaySlot = () =>
    slotService.findAvailableForDay.mockResolvedValue([
      { start_time: new Date('2000-01-01T00:00:00Z'), end_time: new Date('2100-01-01T00:00:00Z') },
    ]);

  beforeEach(async () => {
    appointments = createMockRepository();
    refs = {
      getBranch: jest.fn().mockResolvedValue({ id: BRANCH, timezone: 'UTC' }),
      getStaff: jest.fn().mockResolvedValue({ id: STAFF, is_available_for_booking: true }),
    };
    slotService = { findAvailableForDay: jest.fn().mockResolvedValue([]) };
    blockedService = { findOverlapping: jest.fn().mockResolvedValue([]) };
    holidayService = { findForDate: jest.fn().mockResolvedValue([]) };
    staffSchedule = { getAvailability: jest.fn().mockResolvedValue(null) };
    staffTimeOff = { isOffOn: jest.fn().mockResolvedValue(false) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: SchedulingRefService, useValue: refs },
        { provide: CalendarSlotService, useValue: slotService },
        { provide: BlockedSlotService, useValue: blockedService },
        { provide: HolidayService, useValue: holidayService },
        { provide: StaffScheduleService, useValue: staffSchedule },
        { provide: StaffTimeOffService, useValue: staffTimeOff },
      ],
    }).compile();
    service = moduleRef.get(AvailabilityService);
  });

  afterEach(() => jest.clearAllMocks());

  const assert = (start = START, end = END) =>
    service.assertBookable(TENANT, BRANCH, STAFF, start, end, {});

  it('rejects an invalid window (end <= start) with 422', async () => {
    await expect(assert(END, START)).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
  });

  it('passes when the window is clear and within positive availability', async () => {
    fullDaySlot();
    await expect(assert()).resolves.toBeUndefined();
  });

  it('rejects when the staff member is not bookable', async () => {
    fullDaySlot();
    refs.getStaff.mockResolvedValueOnce({ id: STAFF, is_available_for_booking: false });
    await expect(assert()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('rejects on a holiday', async () => {
    fullDaySlot();
    holidayService.findForDate.mockResolvedValueOnce([{ id: 'h1', name: 'Eid', date: '2026-07-01' }]);
    await expect(assert()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('rejects when the staff member is on time off', async () => {
    fullDaySlot();
    staffTimeOff.isOffOn.mockResolvedValueOnce(true);
    await expect(assert()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('rejects when the window overlaps a blocked period', async () => {
    fullDaySlot();
    blockedService.findOverlapping.mockResolvedValueOnce([
      { start_time: START, end_time: END },
    ]);
    await expect(assert()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('rejects when an occupying appointment overlaps (double-booking)', async () => {
    fullDaySlot();
    appointments.find.mockResolvedValueOnce([{ id: 'occ-1', start_at: START, end_at: END }]);
    await expect(assert()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('uses the transaction manager for the occupancy check when supplied (race-safe)', async () => {
    fullDaySlot();
    const txRepo = createMockRepository();
    txRepo.find.mockResolvedValue([]);
    const mgr = { getRepository: jest.fn().mockReturnValue(txRepo) };

    await service.assertBookable(TENANT, BRANCH, STAFF, START, END, { manager: mgr as any });

    expect(mgr.getRepository).toHaveBeenCalledWith(Appointment);
    expect(txRepo.find).toHaveBeenCalled();
    expect(appointments.find).not.toHaveBeenCalled(); // not the non-tx repo
  });

  describe('read endpoints', () => {
    const q = {
      branchId: BRANCH,
      staffId: STAFF,
      startTime: START.toISOString(),
      endTime: END.toISOString(),
    } as any;

    it('check() returns the evaluated window result', async () => {
      fullDaySlot();
      const res = await service.check(TENANT, q);
      expect(res.available).toBe(true);
      expect(res.window.startTime).toBe(START.toISOString());
    });

    it('validate() returns a boolean validity flag', async () => {
      fullDaySlot();
      const res = await service.validate(TENANT, q);
      expect(res.valid).toBe(true);
    });

    it('rejects missing required query params with VALIDATION_ERROR', async () => {
      await expect(service.check(TENANT, { branchId: BRANCH } as any)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('rejects an inverted time window with 422', async () => {
      await expect(
        service.check(TENANT, { ...q, startTime: END.toISOString(), endTime: START.toISOString() }),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('windows() returns free windows for a clear day', async () => {
      fullDaySlot();
      const res = await service.windows(TENANT, { branchId: BRANCH, staffId: STAFF, date: '2026-07-01' } as any);
      expect(res.available).toBe(true);
      expect(res.windows.length).toBeGreaterThan(0);
    });

    it('windows() short-circuits to unavailable on a holiday', async () => {
      holidayService.findForDate.mockResolvedValueOnce([{ id: 'h1', name: 'Eid', date: '2026-07-01' }]);
      const res = await service.windows(TENANT, { branchId: BRANCH, staffId: STAFF, date: '2026-07-01' } as any);
      expect(res.available).toBe(false);
      expect(res.reason).toBe('holiday');
    });

    it('summary() reports free/blocked/occupied minutes for a staff member', async () => {
      fullDaySlot();
      blockedService.findOverlapping.mockResolvedValueOnce([]);
      const res = await service.summary(TENANT, { branchId: BRANCH, staffId: STAFF, date: '2026-07-01' } as any);
      expect(res.holiday.isHoliday).toBe(false);
      expect(res.available.windows).toBeGreaterThan(0);
      expect(res.occupied.count).toBe(0);
    });

    it('summary() works at branch level (no staff) using calendar slots', async () => {
      fullDaySlot();
      const res = await service.summary(TENANT, { branchId: BRANCH, date: '2026-07-01' } as any);
      expect(res.staffId).toBeNull();
      expect(res.available.windows).toBeGreaterThan(0);
    });

    it('composes recurring working windows from the staff schedule', async () => {
      slotService.findAvailableForDay.mockResolvedValue([]); // no one-off slots
      staffSchedule.getAvailability.mockResolvedValue({
        open: true,
        staff: [{ staffId: STAFF, windows: [{ start: '09:00', end: '17:00' }] }],
      });
      // 10:00–10:30 UTC falls inside the 09:00–17:00 recurring window.
      await expect(assert()).resolves.toBeUndefined();
    });
  });
});
