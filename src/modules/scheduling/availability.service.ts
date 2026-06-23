import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindOptionsWhere,
  In,
  LessThan,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppError, ErrorCode } from '../../common/errors';

import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlotService } from './calendar-slot.service';
import { BlockedSlotService } from './blocked-slot.service';
import { HolidayService } from './holiday.service';
import { StaffScheduleService } from '../staff/staff-schedule.service';
import { StaffTimeOffService } from '../staff/staff-time-off.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import {
  ENFORCE_AVAILABILITY_WHEN_UNDEFINED,
  Interval,
  OCCUPYING_APPOINTMENT_STATUSES,
  chunkIntervals,
  maxDate,
  mergeIntervals,
  minDate,
  subtractIntervals,
  totalMinutes,
} from './scheduling.constants';
import {
  safeZone,
  zonedDayBoundsUtc,
  zonedHhmmToUtc,
  zonedYmd,
} from './timezone.util';

export interface BookabilityConflicts {
  staffInactive: boolean;
  holiday: boolean;
  timeOff: boolean;
  blocked: boolean;
  occupied: boolean;
  outsideAvailability: boolean;
}

export interface BookabilityResult {
  available: boolean;
  reasons: string[];
  conflicts: BookabilityConflicts;
  occupyingAppointmentIds: string[];
}

export interface AssertBookableOptions {
  /** Exclude this appointment from the occupancy check (reschedule / reassign). */
  excludeAppointmentId?: string;
  /** Run the occupancy (double-booking) check inside the caller's transaction. */
  manager?: EntityManager;
}

interface OccupancyOptions {
  staffId?: string;
  excludeAppointmentId?: string;
  manager?: EntityManager;
}

/**
 * THE unified availability engine — the single source of truth for "can an
 * appointment exist at this time?".
 *
 * It does NOT own a parallel model; it COMPOSES every existing source:
 *  - recurring working availability  → reused from Staff: `StaffSchedule` ∩
 *    branch `WorkingHour` (via StaffScheduleService.getAvailability);
 *  - one-off availability windows    → Scheduling `CalendarSlot` (is_available);
 *  - blocked periods                 → Scheduling `BlockedSlot`;
 *  - holidays                        → Scheduling `Holiday`;
 *  - staff time off                  → reused from Staff: `StaffTimeOff`;
 *  - staff bookable flag             → `StaffProfile.is_available_for_booking`;
 *  - existing appointment conflicts  → tenant+branch+staff overlap (active rows).
 *
 * Availability model (per staff, for a window [start,end)):
 *   bookable ⇔ staff is active AND not a holiday AND not on time off AND not
 *   inside a blocked period AND not overlapping an occupying appointment AND
 *   (the window is covered by the POSITIVE availability set — recurring windows
 *   ∪ calendar slots — when that set is defined).
 *
 * Positive-availability gating is conditional (see ENFORCE_AVAILABILITY_WHEN_UNDEFINED):
 * if a staff member has no schedule and no calendar slot for the day, the
 * "within working hours" gate is skipped (migration-safe) while every HARD
 * exclusion above is still enforced.
 *
 * Tenant isolation: branch + staff are tenant-validated; every composed query is
 * tenant-scoped. The occupancy check is transaction-aware so the booking write
 * path is race-safe against concurrent double-bookings.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly refs: SchedulingRefService,
    private readonly slotService: CalendarSlotService,
    private readonly blockedService: BlockedSlotService,
    private readonly holidayService: HolidayService,
    private readonly staffSchedule: StaffScheduleService,
    private readonly staffTimeOff: StaffTimeOffService,
  ) {}

  // ───────────────── Booking gate (called by the Appointment module) ─────── //

  /**
   * Throws `AppError(CONFLICT)` unless [start,end) is truly bookable for
   * (branch, staff). Designed to be called from inside the Appointment booking
   * transaction: pass `manager` so the occupancy check is race-safe, and
   * `excludeAppointmentId` when re-validating an existing appointment.
   */
  async assertBookable(
    tenantId: string,
    branchId: string,
    staffId: string,
    start: Date,
    end: Date,
    opts: AssertBookableOptions = {},
  ): Promise<void> {
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Appointment end time must be after the start time',
      });
    }

    const result = await this.evaluate(tenantId, branchId, staffId, start, end, opts);
    if (!result.available) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `The selected time is not available (${result.reasons.join('; ')})`,
        context: { conflicts: result.conflicts, reasons: result.reasons },
      });
    }
  }

  // ──────────────────────── Read endpoints (controller) ──────────────────── //

  async check(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'startTime', 'endTime']);
    const { start, end } = this.window(q);
    const result = await this.evaluate(tenantId, q.branchId, q.staffId!, start, end);
    return {
      window: { startTime: start.toISOString(), endTime: end.toISOString() },
      ...result,
    };
  }

  async validate(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'startTime', 'endTime']);
    const { start, end } = this.window(q);
    const result = await this.evaluate(tenantId, q.branchId, q.staffId!, start, end);
    return {
      valid: result.available,
      window: { startTime: start.toISOString(), endTime: end.toISOString() },
      reasons: result.reasons,
      conflicts: result.conflicts,
    };
  }

  async windows(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'date']);
    const branch = await this.refs.getBranch(tenantId, q.branchId);
    const zone = safeZone(branch.timezone);
    await this.refs.getStaff(tenantId, q.staffId!);

    const dateStr = q.date!; // interpreted as the branch's LOCAL calendar date
    const { dayStart, dayEnd } = zonedDayBoundsUtc(dateStr, zone);

    const [holidays, offToday] = await Promise.all([
      this.holidayService.findForDate(tenantId, q.branchId, dateStr),
      this.staffTimeOff.isOffOn(tenantId, q.staffId!, dateStr),
    ]);
    if (holidays.length > 0 || offToday) {
      return {
        date: dateStr,
        branchId: q.branchId,
        staffId: q.staffId,
        available: false,
        reason: holidays.length > 0 ? 'holiday' : 'time_off',
        windows: [],
      };
    }

    const positive = await this.computePositiveWindows(
      tenantId,
      q.branchId,
      q.staffId!,
      dateStr,
      dayStart,
      dayEnd,
      zone,
    );
    const busy = await this.busyIntervals(tenantId, q.branchId, q.staffId!, dayStart, dayEnd);
    let free = mergeIntervals(positive.flatMap((p) => subtractIntervals(p, busy)));
    if (q.slotMinutes) free = chunkIntervals(free, q.slotMinutes);

    return {
      date: dateStr,
      branchId: q.branchId,
      staffId: q.staffId,
      available: free.length > 0,
      windows: free.map((w) => ({
        startTime: w.start.toISOString(),
        endTime: w.end.toISOString(),
      })),
    };
  }

  async summary(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['date']);
    const branch = await this.refs.getBranch(tenantId, q.branchId);
    const zone = safeZone(branch.timezone);
    if (q.staffId) await this.refs.getStaff(tenantId, q.staffId);

    const dateStr = q.date!; // branch LOCAL calendar date
    const { dayStart, dayEnd } = zonedDayBoundsUtc(dateStr, zone);

    const [holidays, blocked, occupying] = await Promise.all([
      this.holidayService.findForDate(tenantId, q.branchId, dateStr),
      this.blockedService.findOverlapping(tenantId, q.branchId, dayStart, dayEnd, q.staffId),
      this.findOccupying(tenantId, q.branchId, dayStart, dayEnd, { staffId: q.staffId }),
    ]);

    let positive: Interval[] = [];
    let timeOff = false;
    if (q.staffId) {
      timeOff = await this.staffTimeOff.isOffOn(tenantId, q.staffId, dateStr);
      positive = timeOff
        ? []
        : await this.computePositiveWindows(tenantId, q.branchId, q.staffId, dateStr, dayStart, dayEnd, zone);
    } else {
      // Branch-level: recurring availability is per-staff, so use calendar slots.
      const slots = await this.slotService.findAvailableForDay(tenantId, q.branchId, dayStart, dayEnd);
      positive = slots.map((s) => ({
        start: maxDate(s.start_time, dayStart),
        end: minDate(s.end_time, dayEnd),
      }));
    }

    const busy = [
      ...blocked.map((b) => ({ start: b.start_time, end: b.end_time })),
      ...occupying.map((a) => ({ start: a.start_at, end: a.end_at })),
    ];
    const free = holidays.length > 0 ? [] : mergeIntervals(positive.flatMap((p) => subtractIntervals(p, busy)));

    return {
      date: dateStr,
      branchId: q.branchId,
      staffId: q.staffId ?? null,
      holiday: {
        isHoliday: holidays.length > 0,
        items: holidays.map((h) => ({ id: h.id, name: h.name, date: h.date })),
      },
      timeOff,
      available: { windows: free.length, minutes: totalMinutes(free) },
      blocked: {
        count: blocked.length,
        minutes: totalMinutes(blocked.map((b) => ({ start: b.start_time, end: b.end_time }))),
      },
      occupied: {
        count: occupying.length,
        minutes: totalMinutes(occupying.map((a) => ({ start: a.start_at, end: a.end_at }))),
      },
    };
  }

  // ─────────────────────────── Core evaluation ───────────────────────────── //

  private async evaluate(
    tenantId: string,
    branchId: string,
    staffId: string,
    start: Date,
    end: Date,
    opts: AssertBookableOptions = {},
  ): Promise<BookabilityResult> {
    const branch = await this.refs.getBranch(tenantId, branchId);
    const zone = safeZone(branch.timezone);
    const staff = await this.refs.getStaff(tenantId, staffId);
    const staffInactive = !staff.is_available_for_booking;

    // The LOCAL calendar day of the booking instant (in the branch's timezone)
    // drives holiday/time-off matching and the working-hours window.
    const dateStr = zonedYmd(start, zone);
    const { dayStart, dayEnd } = zonedDayBoundsUtc(dateStr, zone);

    const [holidays, blocked, timeOff, occupying, positive] = await Promise.all([
      this.holidayService.findForDate(tenantId, branchId, dateStr),
      this.blockedService.findOverlapping(tenantId, branchId, start, end, staffId),
      this.staffTimeOff.isOffOn(tenantId, staffId, dateStr),
      this.findOccupying(tenantId, branchId, start, end, {
        staffId,
        excludeAppointmentId: opts.excludeAppointmentId,
        manager: opts.manager,
      }),
      this.computePositiveWindows(tenantId, branchId, staffId, dateStr, dayStart, dayEnd, zone),
    ]);

    const holiday = holidays.length > 0;
    const isBlocked = blocked.length > 0;
    const occupied = occupying.length > 0;

    let outsideAvailability = false;
    if (positive.length > 0) {
      outsideAvailability = subtractIntervals({ start, end }, positive).length > 0;
    } else if (ENFORCE_AVAILABILITY_WHEN_UNDEFINED) {
      outsideAvailability = true;
    }

    const reasons: string[] = [];
    if (staffInactive) reasons.push('staff member is not available for booking');
    if (holiday) reasons.push('the date is a holiday');
    if (timeOff) reasons.push('the staff member is on time off');
    if (isBlocked) reasons.push('the window overlaps a blocked period');
    if (occupied) reasons.push('the staff member already has an appointment in this window');
    if (outsideAvailability) reasons.push("the window is outside the staff member's working availability");

    return {
      available: reasons.length === 0,
      reasons,
      conflicts: { staffInactive, holiday, timeOff, blocked: isBlocked, occupied, outsideAvailability },
      occupyingAppointmentIds: occupying.map((a) => a.id),
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** POSITIVE availability = recurring (StaffSchedule ∩ WorkingHour) ∪ CalendarSlots. */
  private async computePositiveWindows(
    tenantId: string,
    branchId: string,
    staffId: string,
    dateStr: string,
    dayStart: Date,
    dayEnd: Date,
    zone: string,
  ): Promise<Interval[]> {
    const [recurring, slots] = await Promise.all([
      this.recurringWindows(tenantId, branchId, staffId, dateStr, zone),
      this.slotService.findAvailableForDay(tenantId, branchId, dayStart, dayEnd, staffId),
    ]);
    const slotWindows = slots.map((s) => ({
      start: maxDate(s.start_time, dayStart),
      end: minDate(s.end_time, dayEnd),
    }));
    return mergeIntervals([...recurring, ...slotWindows]);
  }

  /**
   * Recurring working windows for a staff member on a date — REUSES the Staff
   * module's availability (schedule ∩ branch working hours), converted to
   * absolute UTC datetime intervals. No re-implementation of that logic here.
   */
  private async recurringWindows(
    tenantId: string,
    branchId: string,
    staffId: string,
    dateStr: string,
    zone: string,
  ): Promise<Interval[]> {
    const avail: any = await this.staffSchedule.getAvailability(tenantId, branchId, dateStr);
    if (!avail?.open || !Array.isArray(avail.staff)) return [];
    const mine = avail.staff.find((s: any) => s.staffId === staffId);
    if (!mine) return [];
    // Working-hours 'HH:MM' are LOCAL wall-clock for the branch; convert each to
    // an absolute UTC instant on the local date (DST-correct).
    return mine.windows.map((w: { start: string; end: string }) => ({
      start: zonedHhmmToUtc(dateStr, w.start, zone),
      end: zonedHhmmToUtc(dateStr, w.end, zone),
    }));
  }

  private async busyIntervals(
    tenantId: string,
    branchId: string,
    staffId: string,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<Interval[]> {
    const [blocked, occupying] = await Promise.all([
      this.blockedService.findOverlapping(tenantId, branchId, dayStart, dayEnd, staffId),
      this.findOccupying(tenantId, branchId, dayStart, dayEnd, { staffId }),
    ]);
    return [
      ...blocked.map((b) => ({ start: b.start_time, end: b.end_time })),
      ...occupying.map((a) => ({ start: a.start_at, end: a.end_at })),
    ];
  }

  /**
   * Occupying appointments overlapping [start,end) for branch (+staff). Excludes
   * CANCELLED/NO_SHOW + soft-deleted (via OCCUPYING_APPOINTMENT_STATUSES + default
   * soft-delete filter), matching the Appointment module's conflict rule exactly.
   * Runs inside the caller's transaction when a `manager` is supplied (race-safe).
   */
  private findOccupying(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
    opts: OccupancyOptions = {},
  ): Promise<Appointment[]> {
    const repo = opts.manager ? opts.manager.getRepository(Appointment) : this.appointments;
    const where: FindOptionsWhere<Appointment> = {
      tenant: { id: tenantId },
      branch: { id: branchId },
      status: In(OCCUPYING_APPOINTMENT_STATUSES),
      start_at: LessThan(end),
      end_at: MoreThan(start),
    };
    if (opts.staffId) where.staff = { id: opts.staffId };
    if (opts.excludeAppointmentId) where.id = Not(opts.excludeAppointmentId);
    return repo.find({ where });
  }

  private window(q: AvailabilityQueryDto): { start: Date; end: Date } {
    const start = new Date(q.startTime!);
    const end = new Date(q.endTime!);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'endTime must be after startTime',
      });
    }
    return { start, end };
  }

  private requireFields(q: AvailabilityQueryDto, fields: string[]): void {
    const missing = fields.filter((f) => {
      const v = (q as any)[f];
      return v === undefined || v === null || v === '';
    });
    if (missing.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Missing required query params: ${missing.join(', ')}`,
      });
    }
  }
}
