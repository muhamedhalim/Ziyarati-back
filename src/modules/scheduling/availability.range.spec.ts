import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AvailabilityService } from './availability.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlotService } from './calendar-slot.service';
import { BlockedSlotService } from './blocked-slot.service';
import { HolidayService } from './holiday.service';
import { StaffScheduleService } from '../staff/staff-schedule.service';
import { StaffTimeOffService } from '../staff/staff-time-off.service';
import { BookabilityReason } from './scheduling.constants';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const BRANCH = 'b1';
const STAFF = 's1';
/** Riyadh is UTC+3 with no DST — 10:00 local is 07:00Z, all year. */
const ZONE = 'Asia/Riyadh';

/**
 * The behaviours the AI booking assistant depends on, at the layer that
 * actually decides them.
 *
 * Every one of these used to be indistinguishable from the outside: `windows()`
 * returned a bare `windows: []` for a doctor who does not work that day, for a
 * doctor whose day is fully booked, and for a service too long to fit the gap
 * that is left. The assistant could only translate all three into "the doctor
 * is unavailable", and — having no alternative in hand — repeated that sentence
 * for every follow-up question. These tests pin the two properties that fix it:
 * an unavailable day always says WHY, and a range search always finds the next
 * day that works.
 */
describe('AvailabilityService — named outcomes and range search', () => {
  let service: AvailabilityService;
  let appointments: MockRepository;
  let tenantSettings: MockRepository;
  let refs: { getBranch: jest.Mock; getStaff: jest.Mock };
  let slotService: { findAvailableForDay: jest.Mock };
  let blockedService: { findOverlapping: jest.Mock };
  let holidayService: { findForDate: jest.Mock };
  let staffSchedule: { getAvailability: jest.Mock; hasAnySchedule: jest.Mock };
  let staffTimeOff: { isOffOn: jest.Mock };

  /**
   * Roster the doctor 10:00–20:00 local on the given weekdays (0=Sun…6=Sat),
   * exactly as `StaffScheduleService.getAvailability` reports it.
   */
  const rosterOn = (weekdays: number[], start = '10:00', end = '20:00') =>
    staffSchedule.getAvailability.mockImplementation(
      (_t: string, _b: string, dateStr: string) => {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        return Promise.resolve(
          weekdays.includes(dow)
            ? {
                open: true,
                staff: [{ staffId: STAFF, windows: [{ start, end }] }],
              }
            : { open: true, staff: [] },
        );
      },
    );

  const appt = (startIso: string, endIso: string) => ({
    id: `a-${startIso}`,
    start_at: new Date(startIso),
    end_at: new Date(endIso),
  });

  beforeEach(async () => {
    appointments = createMockRepository();
    appointments.find.mockResolvedValue([]);
    tenantSettings = createMockRepository();
    refs = {
      getBranch: jest.fn().mockResolvedValue({ id: BRANCH, timezone: ZONE }),
      getStaff: jest
        .fn()
        .mockResolvedValue({ id: STAFF, is_available_for_booking: true }),
    };
    slotService = { findAvailableForDay: jest.fn().mockResolvedValue([]) };
    blockedService = { findOverlapping: jest.fn().mockResolvedValue([]) };
    holidayService = { findForDate: jest.fn().mockResolvedValue([]) };
    staffSchedule = {
      getAvailability: jest.fn().mockResolvedValue(null),
      hasAnySchedule: jest.fn().mockResolvedValue(true),
    };
    staffTimeOff = { isOffOn: jest.fn().mockResolvedValue(false) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        {
          provide: getRepositoryToken(TenantSetting),
          useValue: tenantSettings,
        },
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

  /** `windows()` takes (tenantId, query, opts) — thin wrapper for readability. */
  const windows = (date: string, slotMinutes?: number, notBefore?: Date) =>
    service.windows(
      TENANT,
      { branchId: BRANCH, staffId: STAFF, date, slotMinutes } as never,
      { notBefore },
    );

  // ── 5/7/15/16: an empty day always says WHY ──────────────────────────────

  it('names "not_working_that_day" when the doctor has no roster that weekday', async () => {
    rosterOn([0, 1, 2]); // Sun/Mon/Tue only
    // 2026-09-04 is a Friday.
    const res = await windows('2026-09-04', 30);
    expect(res.available).toBe(false);
    expect(res.reason).toBe('not_working_that_day');
    expect(res.reasonCode).toBe(BookabilityReason.OUTSIDE_WORKING_HOURS);
  });

  it('names "fully_booked" when the roster exists but every minute is taken', async () => {
    rosterOn([2]); // Tuesday
    appointments.find.mockResolvedValue([
      appt('2026-09-01T07:00:00.000Z', '2026-09-01T17:00:00.000Z'),
    ]);
    const res = await windows('2026-09-01', 30);
    expect(res.available).toBe(false);
    expect(res.reason).toBe('fully_booked');
    expect(res.reasonCode).toBe(BookabilityReason.OCCUPIED);
  });

  it('names "holiday" and "time_off" distinctly', async () => {
    rosterOn([2]);
    holidayService.findForDate.mockResolvedValue([{ id: 'h', name: 'Eid' }]);
    expect((await windows('2026-09-01')).reason).toBe('holiday');

    holidayService.findForDate.mockResolvedValue([]);
    staffTimeOff.isOffOn.mockResolvedValue(true);
    expect((await windows('2026-09-01')).reason).toBe('time_off');
  });

  it('names "staff_inactive" rather than reporting a scheduling accident', async () => {
    rosterOn([2]);
    refs.getStaff.mockResolvedValue({
      id: STAFF,
      is_available_for_booking: false,
    });
    const res = await windows('2026-09-01', 30);
    expect(res.reason).toBe('staff_inactive');
    expect(res.reasonCode).toBe(BookabilityReason.STAFF_INACTIVE);
  });

  // ── 11/14: the service duration decides what counts as a slot ────────────

  it('names "no_gap_long_enough" when free time exists but no gap fits the service', async () => {
    rosterOn([2], '10:00', '11:00'); // one hour local
    appointments.find.mockResolvedValue([
      // Leaves exactly 20 free minutes (10:40–11:00 local = 07:40–08:00Z).
      appt('2026-09-01T07:00:00.000Z', '2026-09-01T07:40:00.000Z'),
    ]);
    const res = await windows('2026-09-01', 45);
    expect(res.available).toBe(false);
    expect(res.reason).toBe('no_gap_long_enough');

    // A shorter service still fits the same gap — proving the reason is about
    // duration, not about the day being unavailable.
    const shorter = await windows('2026-09-01', 20);
    expect(shorter.available).toBe(true);
    expect(shorter.windows).toHaveLength(1);
  });

  it('chunks by service duration and never returns a slot that overruns the day', async () => {
    rosterOn([2], '10:00', '12:00'); // 120 local minutes
    const res = await windows('2026-09-01', 45);
    // 120 / 45 = 2 whole slots; the trailing 30 minutes are correctly dropped.
    expect(res.windows).toHaveLength(2);
    expect(res.windows[0].startTime).toBe('2026-09-01T07:00:00.000Z');
    expect(res.windows[1].startTime).toBe('2026-09-01T07:45:00.000Z');
  });

  // ── 12/13: booked and overlapping appointments are excluded ──────────────

  it('excludes a booked slot and the windows that overlap it', async () => {
    rosterOn([2], '10:00', '13:00'); // 10:00–13:00 local = 07:00–10:00Z
    appointments.find.mockResolvedValue([
      appt('2026-09-01T08:00:00.000Z', '2026-09-01T08:30:00.000Z'),
    ]);
    const res = await windows('2026-09-01', 30);
    const starts = res.windows.map((w) => w.startTime);
    expect(starts).toContain('2026-09-01T07:00:00.000Z'); // 10:00 local
    expect(starts).not.toContain('2026-09-01T08:00:00.000Z'); // 11:00 — booked
    expect(starts).toContain('2026-09-01T08:30:00.000Z'); // 11:30 — free again
  });

  // ── 17: timezone ─────────────────────────────────────────────────────────

  it('interprets the date and the roster in the BRANCH timezone, not the server one', async () => {
    rosterOn([2], '10:00', '11:00');
    const res = await windows('2026-09-01', 60);
    expect(res.timezone).toBe(ZONE);
    // 10:00 in Asia/Riyadh (UTC+3) is 07:00Z — not 10:00Z.
    expect(res.windows[0].startTime).toBe('2026-09-01T07:00:00.000Z');
  });

  // ── past slots ───────────────────────────────────────────────────────────

  it('drops free time that has already passed when notBefore is given', async () => {
    rosterOn([2], '10:00', '13:00');
    // 11:30 local = 08:30Z — everything before it should disappear.
    const res = await windows(
      '2026-09-01',
      30,
      new Date('2026-09-01T08:30:00.000Z'),
    );
    // 08:30Z–10:00Z is 90 minutes → exactly three 30-minute slots, and the
    // three earlier ones (07:00 / 07:30 / 08:00Z) are gone.
    expect(res.windows.map((w) => w.startTime)).toEqual([
      '2026-09-01T08:30:00.000Z',
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T09:30:00.000Z',
    ]);
  });

  it('keeps slots on the clinic grid when "now" falls mid-slot', async () => {
    rosterOn([2], '10:00', '13:00');
    // A request that arrives at 11:12:37 local (08:12:37Z) must NOT slide the
    // grid onto :12:37 — it must simply drop the slots that already started.
    // Those stray instants would otherwise be offered to the patient AND
    // written into `appointments.start_at`.
    const res = await windows(
      '2026-09-01',
      45,
      new Date('2026-09-01T08:12:37.400Z'),
    );
    expect(res.windows.map((w) => w.startTime)).toEqual([
      '2026-09-01T08:30:00.000Z', // 11:30 local — the next grid slot
      '2026-09-01T09:15:00.000Z', // 12:15 local
    ]);
  });

  it('reports "day_already_past" when the whole working day is behind us', async () => {
    rosterOn([2], '10:00', '13:00');
    const res = await windows(
      '2026-09-01',
      30,
      new Date('2026-09-01T20:00:00.000Z'),
    );
    expect(res.available).toBe(false);
    expect(res.reason).toBe('day_already_past');
  });

  // ── 6: nearest available days ────────────────────────────────────────────

  describe('rangeWindows', () => {
    it('finds the next days with real slots when the asked-for day has none', async () => {
      rosterOn([3, 4]); // Wed + Thu only
      // 2026-09-01 is a Tuesday — the doctor does not work it.
      const { days, timezone } = await service.rangeWindows(TENANT, {
        branchId: BRANCH,
        staffId: STAFF,
        fromDate: '2026-09-01',
        toDate: '2026-09-07',
        slotMinutes: 45,
      });
      expect(timezone).toBe(ZONE);

      const tuesday = days.find((d) => d.date === '2026-09-01')!;
      expect(tuesday.available).toBe(false);
      expect(tuesday.reason).toBe('not_working_that_day');

      const bookable = days.filter((d) => d.available).map((d) => d.date);
      expect(bookable).toEqual(['2026-09-02', '2026-09-03']); // Wed, Thu
      expect(
        days.find((d) => d.date === '2026-09-02')!.windows.length,
      ).toBeGreaterThan(0);
    });

    it('stops as soon as maxDaysWithSlots is satisfied (bounded cost)', async () => {
      rosterOn([0, 1, 2, 3, 4, 5, 6]); // every day is bookable
      const { days } = await service.rangeWindows(TENANT, {
        branchId: BRANCH,
        staffId: STAFF,
        fromDate: '2026-09-01',
        toDate: '2026-09-14',
        slotMinutes: 30,
        maxDaysWithSlots: 3,
      });
      // Stopped after the 3rd bookable day rather than scanning all 14.
      expect(days).toHaveLength(3);
      expect(days.every((d) => d.available)).toBe(true);
    });

    it('never scans past the anonymous horizon even when a wider range is asked for', async () => {
      rosterOn([]); // nothing is ever bookable → no early termination
      const { days } = await service.rangeWindows(TENANT, {
        branchId: BRANCH,
        staffId: STAFF,
        fromDate: '2026-09-01',
        toDate: '2027-09-01',
        slotMinutes: 30,
      });
      expect(days).toHaveLength(14); // PUBLIC_AVAILABILITY_HORIZON_DAYS
    });

    it('carries a reason on every empty day so a caller can explain each one', async () => {
      rosterOn([2]); // Tuesday only
      const { days } = await service.rangeWindows(TENANT, {
        branchId: BRANCH,
        staffId: STAFF,
        fromDate: '2026-09-03',
        toDate: '2026-09-05',
        slotMinutes: 30,
      });
      expect(days.filter((d) => !d.available).every((d) => !!d.reason)).toBe(
        true,
      );
    });
  });

  it('publicWindows still returns the flat anonymous-safe projection', async () => {
    rosterOn([2], '10:00', '11:00');
    const res = await service.publicWindows(TENANT, {
      branchId: BRANCH,
      staffId: STAFF,
      fromDate: '2026-09-01',
      toDate: '2026-09-01',
      slotMinutes: 30,
    });
    expect(res.timezone).toBe(ZONE);
    // Exactly `{ startAt, endAt }` — no reason, no ids, nothing else leaks
    // through the delegation to rangeWindows.
    expect(Object.keys(res.windows[0]).sort()).toEqual(['endAt', 'startAt']);
    expect(res.windows).toHaveLength(2);
  });
});
