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
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppError, ErrorCode } from '../../common/errors';

import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlotService } from './calendar-slot.service';
import { BlockedSlotService } from './blocked-slot.service';
import { HolidayService } from './holiday.service';
import { StaffScheduleService } from '../staff/staff-schedule.service';
import { StaffTimeOffService } from '../staff/staff-time-off.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import {
  BookabilityReason,
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

/** S8 abuse control — see {@link AvailabilityService.publicWindows}. */
export const PUBLIC_AVAILABILITY_HORIZON_DAYS = 14;

/** The ENTIRE anonymous-safe shape — nothing else may ever be added here. */
export interface PublicAvailabilityWindow {
  startAt: string;
  endAt: string;
}

/**
 * One branch-local day's availability result.
 *
 * `reason` is present on EVERY unavailable day, not only the two cases that
 * used to carry one. It is the difference between an assistant that can say
 * "Dr. Halim does not work Tuesdays, but he is free Wednesday at 14:00" and one
 * that can only ever say "unavailable" — see `windows()`'s own note.
 */
export interface DayWindows {
  date: string;
  branchId: string;
  staffId?: string;
  /** The BRANCH's IANA zone — the zone `date` and every window is expressed in. */
  timezone: string;
  available: boolean;
  reason?: string;
  reasonCode?: BookabilityReason;
  windows: { startTime: string; endTime: string }[];
}

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
  /** Human-readable prose — for logs and for the AI assistant to relay. */
  reasons: string[];
  /** Stable machine codes — what a client (and a translation) branches on. */
  reasonCodes: BookabilityReason[];
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
  /**
   * Minutes of gap `StaffProfile.booking_buffer_minutes` requires around each
   * existing occupying appointment (AIE-A04) — expands EACH occupying
   * appointment's window to `[start_at - buffer, end_at + buffer)` before
   * testing overlap, so a new booking cannot land closer than `buffer`
   * minutes to an existing one. Only meaningful with a `staffId` (the buffer
   * is a per-staff setting); ignored for the branch-level (no `staffId`)
   * facet, which has no single buffer to apply.
   */
  bufferMinutes?: number;
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
 * Positive-availability gating for a day with NO schedule/calendar-slot
 * coverage is skipped (day is treated as unrestricted) UNLESS either (a) the
 * clinic opted into tenant-wide strict enforcement
 * (`tenant_settings.enforce_staff_working_hours`, default false — see
 * `enforceWorkingHours`), or (b) this specific staff member has an explicit
 * working-days schedule configured at all (`StaffScheduleService.hasAnySchedule`)
 * — in which case a day outside that set is always a violation, so a
 * per-employee working-days assignment is enforced from the moment it exists,
 * independent of the tenant toggle. Every HARD exclusion above is always
 * enforced.
 *
 * Tenant isolation: branch + staff are tenant-validated; every composed query is
 * tenant-scoped.
 *
 * Concurrency: the occupancy check is transaction-aware, but a SELECT-then-INSERT
 * can never be race-safe under READ COMMITTED. The real guarantee is the
 * `appointments_no_overlap` EXCLUSION constraint — two concurrent bookings that
 * both pass this check collide at INSERT and exactly one survives; the loser's
 * 23P01 becomes `SLOT_ALREADY_BOOKED`.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    /** Read-only: the per-clinic working-hours enforcement decision. */
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
    private readonly refs: SchedulingRefService,
    private readonly slotService: CalendarSlotService,
    private readonly blockedService: BlockedSlotService,
    private readonly holidayService: HolidayService,
    private readonly staffSchedule: StaffScheduleService,
    private readonly staffTimeOff: StaffTimeOffService,
  ) {}

  // ───────────────── Booking gate (called by the Appointment module) ─────── //

  /**
   * Throws `AppError(STAFF_NOT_AVAILABLE)` unless [start,end) is truly bookable
   * for (branch, staff). Designed to be called from inside the Appointment
   * booking transaction: pass `manager` so every check reads the transaction's
   * snapshot, and `excludeAppointmentId` when re-validating an existing
   * appointment so it never conflicts with itself.
   *
   * This is the gate EVERY booking source passes through — reception, admin,
   * the WhatsApp bot, the public AI assistant, the integration platform — so a
   * new booking path gets the rule for free by calling `AppointmentsService`.
   */
  async assertBookable(
    tenantId: string,
    branchId: string,
    staffId: string,
    start: Date,
    end: Date,
    opts: AssertBookableOptions = {},
  ): Promise<void> {
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'Appointment end time must be after the start time',
      });
    }

    const result = await this.evaluate(
      tenantId,
      branchId,
      staffId,
      start,
      end,
      opts,
    );
    if (!result.available) {
      // A DEDICATED code, not the generic CONFLICT: a client has to be able to
      // tell "this staff member cannot take this window" apart from every other
      // 409, and `reasonCodes` tells it exactly which rule refused. The prose
      // message stays in `message` for logs and for the AI assistant to relay.
      //
      // `occupyingAppointmentIds` is deliberately NOT surfaced — the caller has
      // no need for other appointments' ids to re-pick a time.
      throw new AppError(ErrorCode.STAFF_NOT_AVAILABLE, {
        message: `The selected time is not available (${result.reasons.join('; ')})`,
        publicContext: {
          conflicts: result.conflicts,
          reasons: result.reasons,
          reasonCodes: result.reasonCodes,
        },
      });
    }
  }

  // ──────────────────────── Read endpoints (controller) ──────────────────── //

  async check(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'startTime', 'endTime']);
    const { start, end } = this.window(q);
    const result = await this.evaluate(
      tenantId,
      q.branchId,
      q.staffId!,
      start,
      end,
    );
    return {
      window: { startTime: start.toISOString(), endTime: end.toISOString() },
      ...result,
    };
  }

  async validate(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'startTime', 'endTime']);
    const { start, end } = this.window(q);
    const result = await this.evaluate(
      tenantId,
      q.branchId,
      q.staffId!,
      start,
      end,
    );
    return {
      valid: result.available,
      window: { startTime: start.toISOString(), endTime: end.toISOString() },
      reasons: result.reasons,
      reasonCodes: result.reasonCodes,
      conflicts: result.conflicts,
    };
  }

  /**
   * Free windows for one staff member on one branch-local calendar day.
   *
   * `opts.notBefore` is an OPT-IN floor: free time entirely before that instant
   * is dropped. Nothing passes it today except the AI/public callers, so every
   * pre-existing caller (the dashboard grid, which legitimately renders a whole
   * past day) keeps its exact current output. Without it, "do you have anything
   * today?" at 15:00 answers with this morning's 10:00.
   */
  async windows(
    tenantId: string,
    q: AvailabilityQueryDto,
    opts: { notBefore?: Date } = {},
  ): Promise<DayWindows> {
    this.requireFields(q, ['staffId', 'date']);
    const branch = await this.refs.getBranch(tenantId, q.branchId);
    const zone = safeZone(branch.timezone);
    const staff = await this.refs.getStaff(tenantId, q.staffId!);

    const dateStr = q.date!; // interpreted as the branch's LOCAL calendar date
    const { dayStart, dayEnd } = zonedDayBoundsUtc(dateStr, zone);

    const empty = (
      reason: string,
      reasonCode?: BookabilityReason,
    ): DayWindows => ({
      date: dateStr,
      branchId: q.branchId,
      staffId: q.staffId,
      timezone: zone,
      available: false,
      reason,
      ...(reasonCode ? { reasonCode } : {}),
      windows: [],
    });

    // A staff member who is not bookable at all is not "fully booked" — say so,
    // or the caller reports a permanent state as a scheduling accident.
    if (!staff.is_available_for_booking) {
      return empty('staff_inactive', BookabilityReason.STAFF_INACTIVE);
    }

    const [holidays, offToday] = await Promise.all([
      this.holidayService.findForDate(tenantId, q.branchId, dateStr),
      this.staffTimeOff.isOffOn(tenantId, q.staffId!, dateStr),
    ]);
    if (holidays.length > 0 || offToday) {
      // `reason` is the pre-existing lowercase string, kept for back-compat;
      // `reasonCode` is the stable enum a client should branch on.
      return holidays.length > 0
        ? empty('holiday', BookabilityReason.HOLIDAY)
        : empty('time_off', BookabilityReason.TIME_OFF);
    }

    const [positive, busy] = await Promise.all([
      this.computePositiveWindows(
        tenantId,
        q.branchId,
        q.staffId!,
        dateStr,
        dayStart,
        dayEnd,
        zone,
      ),
      this.busyIntervals(
        tenantId,
        q.branchId,
        q.staffId!,
        dayStart,
        dayEnd,
        staff.booking_buffer_minutes,
      ),
    ]);

    // WHY THE OUTCOMES ARE NAMED. Until now every one of the cases below
    // returned an identical `windows: []`, so a caller — the AI assistant most
    // of all — could not tell "the doctor does not work Tuesdays" from "the
    // doctor is fully booked" from "your 45-minute service does not fit in the
    // 20 minutes that are still free". It said "unavailable" to all three and
    // had nothing else to offer, which is exactly how the same sentence gets
    // repeated at a patient turn after turn.
    if (positive.length === 0) {
      return empty(
        'not_working_that_day',
        BookabilityReason.OUTSIDE_WORKING_HOURS,
      );
    }

    let free = mergeIntervals(
      positive.flatMap((p) => subtractIntervals(p, busy)),
    );
    if (free.length === 0)
      return empty('fully_booked', BookabilityReason.OCCUPIED);

    if (q.slotMinutes) {
      // CHUNK FIRST, THEN drop the past ones. Clamping the raw window to `now`
      // before chunking would slide the whole grid onto whatever second the
      // request happened to arrive on — a request at 17:15:49 produced slots at
      // 17:15:49, 18:00:49, … which is both an odd thing to offer a patient and
      // an odd instant to write into `appointments.start_at`. Chunking from the
      // window's own start keeps every slot on the clinic's natural grid
      // (10:00, 10:45, 11:30 …); the filter then simply removes the ones that
      // have already begun.
      const chunked = chunkIntervals(free, q.slotMinutes);
      // Free time existed but no CONTIGUOUS block was long enough for the
      // requested duration. A distinct outcome from "fully booked": a shorter
      // service would still fit, and saying so is actionable.
      if (chunked.length === 0) return empty('no_gap_long_enough');

      const upcoming = opts.notBefore
        ? chunked.filter((w) => w.start >= opts.notBefore!)
        : chunked;
      if (upcoming.length === 0) return empty('day_already_past');
      free = upcoming;
    } else if (opts.notBefore) {
      // No fixed slot size: report the remainder of each window, starting at
      // the next whole minute rather than at a stray second.
      const floor = new Date(
        Math.ceil(opts.notBefore.getTime() / 60_000) * 60_000,
      );
      free = free
        .map((w) => ({ start: maxDate(w.start, floor), end: w.end }))
        .filter((w) => w.end > w.start);
      if (free.length === 0) return empty('day_already_past');
    }

    return {
      date: dateStr,
      branchId: q.branchId,
      staffId: q.staffId,
      timezone: zone,
      available: true,
      windows: free.map((w) => ({
        startTime: w.start.toISOString(),
        endTime: w.end.toISOString(),
      })),
    };
  }

  /**
   * The SAME per-day computation as {@link windows}, run across a bounded range
   * of branch-local dates and grouped by day — the shape a caller needs to
   * answer "when is this doctor next free?" rather than only "is he free on
   * this one date?".
   *
   * There is no second availability implementation here: this is a loop over
   * `windows()`, so every rule (schedule ∩ branch hours, holidays, time off,
   * blocked periods, occupancy, per-staff buffer, service duration) applies
   * identically and cannot drift.
   *
   * COST IS BOUNDED TWICE. The range is capped at
   * `PUBLIC_AVAILABILITY_HORIZON_DAYS` (the pre-existing abuse control), and
   * `maxDaysWithSlots` stops the scan as soon as enough days have been found —
   * so the common case ("is Tuesday free?" → yes) costs exactly one day's
   * queries, and only a genuinely booked-out doctor pays for the full horizon.
   */
  async rangeWindows(
    tenantId: string,
    params: {
      branchId: string;
      staffId: string;
      fromDate: string;
      toDate: string;
      slotMinutes?: number;
      /** Stop once this many days have at least one slot. Omit to scan all. */
      maxDaysWithSlots?: number;
      /** Drop free time before this instant (typically "now"). */
      notBefore?: Date;
    },
  ): Promise<{ timezone: string; days: DayWindows[] }> {
    if (
      !params.branchId ||
      !params.staffId ||
      !params.fromDate ||
      !params.toDate
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'branchId, staffId, fromDate and toDate are all required',
      });
    }
    const branch = await this.refs.getBranch(tenantId, params.branchId);
    const zone = safeZone(branch.timezone);

    const dates = this.cappedDateRange(params.fromDate, params.toDate);
    const days: DayWindows[] = [];
    let found = 0;
    for (const dateStr of dates) {
      const day = await this.windows(
        tenantId,
        {
          branchId: params.branchId,
          staffId: params.staffId,
          date: dateStr,
          slotMinutes: params.slotMinutes,
        } as AvailabilityQueryDto,
        { notBefore: params.notBefore },
      );
      days.push(day);
      if (day.available) {
        found += 1;
        if (params.maxDaysWithSlots && found >= params.maxDaysWithSlots) break;
      }
    }
    return { timezone: zone, days };
  }

  /**
   * Spec 014 (Clinic Platform Completion) — S8. Anonymous-safe projection:
   * an unauthenticated caller (the public booking widget) may read WHEN a
   * staff member is free, and NOTHING else. Returns only `{ startAt, endAt }`
   * plus the branch timezone — no appointment ids, customer data, staff
   * contact details, or blocked-slot reasons ever reach this return shape.
   *
   * Delegates entirely to {@link windows} (day-by-day) — the SAME
   * availability computation the authenticated surface uses — so this is
   * provably a subset of its output, never a second implementation of any
   * rule. The horizon cap (`PUBLIC_AVAILABILITY_HORIZON_DAYS`) is an abuse
   * control (bounds how much compute an anonymous request can trigger), not
   * a UX choice — a caller wanting a wider search must ask again.
   */
  async publicWindows(
    tenantId: string,
    params: {
      branchId: string;
      staffId: string;
      fromDate: string;
      toDate: string;
      slotMinutes?: number;
    },
  ): Promise<{ timezone: string; windows: PublicAvailabilityWindow[] }> {
    if (
      !params.branchId ||
      !params.staffId ||
      !params.fromDate ||
      !params.toDate
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'branchId, staffId, fromDate and toDate are all required',
      });
    }

    // Delegates to `rangeWindows` (which owns the day loop and the horizon cap)
    // and flattens — so the two range-shaped callers share ONE loop and cannot
    // drift apart. `notBefore` is deliberately not passed: this projection's
    // existing callers ask for an explicit range and render it themselves.
    const { timezone, days } = await this.rangeWindows(tenantId, params);
    return {
      timezone,
      windows: days.flatMap((d) =>
        d.windows.map((w) => ({ startAt: w.startTime, endAt: w.endTime })),
      ),
    };
  }

  /** Inclusive YYYY-MM-DD date strings from `from`, capped at
   *  `PUBLIC_AVAILABILITY_HORIZON_DAYS` days — never `to` alone, which an
   *  anonymous caller fully controls. */
  private cappedDateRange(from: string, to: string): string[] {
    const start = new Date(`${from}T00:00:00.000Z`);
    const requestedEnd = new Date(`${to}T00:00:00.000Z`);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(requestedEnd.getTime()) ||
      requestedEnd < start
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'toDate must be a valid date on or after fromDate',
      });
    }
    const maxEnd = new Date(start);
    maxEnd.setUTCDate(
      maxEnd.getUTCDate() + PUBLIC_AVAILABILITY_HORIZON_DAYS - 1,
    );
    const end = requestedEnd < maxEnd ? requestedEnd : maxEnd;

    const dates: string[] = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  async summary(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['date']);
    const branch = await this.refs.getBranch(tenantId, q.branchId);
    const zone = safeZone(branch.timezone);
    const staff = q.staffId
      ? await this.refs.getStaff(tenantId, q.staffId)
      : undefined;

    const dateStr = q.date!; // branch LOCAL calendar date
    const { dayStart, dayEnd } = zonedDayBoundsUtc(dateStr, zone);

    const [holidays, blocked, occupying] = await Promise.all([
      this.holidayService.findForDate(tenantId, q.branchId, dateStr),
      this.blockedService.findOverlapping(
        tenantId,
        q.branchId,
        dayStart,
        dayEnd,
        q.staffId,
      ),
      this.findOccupying(tenantId, q.branchId, dayStart, dayEnd, {
        staffId: q.staffId,
        bufferMinutes: staff?.booking_buffer_minutes,
      }),
    ]);

    let positive: Interval[] = [];
    let timeOff = false;
    if (q.staffId) {
      timeOff = await this.staffTimeOff.isOffOn(tenantId, q.staffId, dateStr);
      positive = timeOff
        ? []
        : await this.computePositiveWindows(
            tenantId,
            q.branchId,
            q.staffId,
            dateStr,
            dayStart,
            dayEnd,
            zone,
          );
    } else {
      // Branch-level: recurring availability is per-staff, so use calendar slots.
      const slots = await this.slotService.findAvailableForDay(
        tenantId,
        q.branchId,
        dayStart,
        dayEnd,
      );
      positive = slots.map((s) => ({
        start: maxDate(s.start_time, dayStart),
        end: minDate(s.end_time, dayEnd),
      }));
    }

    const busy = [
      ...blocked.map((b) => ({ start: b.start_time, end: b.end_time })),
      ...occupying.map((a) => ({ start: a.start_at, end: a.end_at })),
    ];
    const free =
      holidays.length > 0
        ? []
        : mergeIntervals(positive.flatMap((p) => subtractIntervals(p, busy)));

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
        minutes: totalMinutes(
          blocked.map((b) => ({ start: b.start_time, end: b.end_time })),
        ),
      },
      occupied: {
        count: occupying.length,
        minutes: totalMinutes(
          occupying.map((a) => ({ start: a.start_at, end: a.end_at })),
        ),
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
    const [branch, staff] = await Promise.all([
      this.refs.getBranch(tenantId, branchId),
      this.refs.getStaff(tenantId, staffId),
    ]);
    const zone = safeZone(branch.timezone);
    const staffInactive = !staff.is_available_for_booking;

    // The LOCAL calendar day of the booking instant (in the branch's timezone)
    // drives holiday/time-off matching and the working-hours window.
    const dateStr = zonedYmd(start, zone);
    const { dayStart, dayEnd } = zonedDayBoundsUtc(dateStr, zone);

    const [
      holidays,
      blocked,
      timeOff,
      occupying,
      positive,
      enforceWhenUndefined,
      staffHasSchedule,
    ] = await Promise.all([
      this.holidayService.findForDate(tenantId, branchId, dateStr),
      this.blockedService.findOverlapping(
        tenantId,
        branchId,
        start,
        end,
        staffId,
      ),
      this.staffTimeOff.isOffOn(tenantId, staffId, dateStr),
      this.findOccupying(tenantId, branchId, start, end, {
        staffId,
        excludeAppointmentId: opts.excludeAppointmentId,
        manager: opts.manager,
        bufferMinutes: staff.booking_buffer_minutes,
      }),
      this.computePositiveWindows(
        tenantId,
        branchId,
        staffId,
        dateStr,
        dayStart,
        dayEnd,
        zone,
      ),
      this.enforceWorkingHours(tenantId, opts.manager),
      this.staffSchedule.hasAnySchedule(tenantId, staffId),
    ]);

    const holiday = holidays.length > 0;
    const isBlocked = blocked.length > 0;
    const occupied = occupying.length > 0;

    let outsideAvailability = false;
    if (positive.length > 0) {
      outsideAvailability =
        subtractIntervals({ start, end }, positive).length > 0;
    } else if (enforceWhenUndefined || staffHasSchedule) {
      // Nothing configured for THIS day. If the clinic enforces working hours
      // tenant-wide, or if this specific staff member has an explicit
      // working-days schedule configured (on other days), an uncovered day is
      // a working-days violation, not an unconfigured/unrestricted staff
      // member — see `hasAnySchedule`. A staff member with no schedule at all
      // keeps the original unrestricted default.
      outsideAvailability = true;
    }

    // Prose and codes are built together so they can never drift apart: the
    // prose is what a human (or the AI assistant) reads, the code is what a
    // client branches on and translates.
    const reasons: string[] = [];
    const reasonCodes: BookabilityReason[] = [];
    const add = (code: BookabilityReason, prose: string): void => {
      reasonCodes.push(code);
      reasons.push(prose);
    };

    if (staffInactive) {
      add(
        BookabilityReason.STAFF_INACTIVE,
        'staff member is not available for booking',
      );
    }
    if (holiday) add(BookabilityReason.HOLIDAY, 'the date is a holiday');
    if (timeOff)
      add(BookabilityReason.TIME_OFF, 'the staff member is on time off');
    if (isBlocked)
      add(BookabilityReason.BLOCKED, 'the window overlaps a blocked period');
    if (occupied) {
      add(
        BookabilityReason.OCCUPIED,
        'the staff member already has an appointment in this window',
      );
    }
    if (outsideAvailability) {
      add(
        BookabilityReason.OUTSIDE_WORKING_HOURS,
        "the window is outside the staff member's working availability",
      );
    }

    return {
      available: reasons.length === 0,
      reasons,
      reasonCodes,
      conflicts: {
        staffInactive,
        holiday,
        timeOff,
        blocked: isBlocked,
        occupied,
        outsideAvailability,
      },
      occupyingAppointmentIds: occupying.map((a) => a.id),
    };
  }

  /**
   * Does THIS clinic require an explicitly configured working window before a
   * staff member can be booked?
   *
   * `tenant_settings.enforce_staff_working_hours` — default `false`, so every
   * existing clinic keeps booking exactly as it did. A clinic that maintains
   * `StaffSchedule` / `WorkingHour` rows turns it on and "no schedule that day"
   * starts meaning "not bookable that day" instead of "no constraint".
   *
   * Read through the caller's `manager` when there is one, so the booking
   * transaction decides on the same snapshot as the rest of its validation. A
   * missing settings row falls back to ENFORCE_AVAILABILITY_WHEN_UNDEFINED
   * rather than inventing an answer.
   */
  private async enforceWorkingHours(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager
      ? manager.getRepository(TenantSetting)
      : this.tenantSettings;
    const row = await repo.findOne({
      where: { tenant: { id: tenantId } },
      select: { id: true, enforce_staff_working_hours: true },
    });
    return (
      row?.enforce_staff_working_hours ?? ENFORCE_AVAILABILITY_WHEN_UNDEFINED
    );
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
      this.slotService.findAvailableForDay(
        tenantId,
        branchId,
        dayStart,
        dayEnd,
        staffId,
      ),
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
    const avail: any = await this.staffSchedule.getAvailability(
      tenantId,
      branchId,
      dateStr,
    );
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
    bufferMinutes?: number,
  ): Promise<Interval[]> {
    const [blocked, occupying] = await Promise.all([
      this.blockedService.findOverlapping(
        tenantId,
        branchId,
        dayStart,
        dayEnd,
        staffId,
      ),
      this.findOccupying(tenantId, branchId, dayStart, dayEnd, {
        staffId,
        bufferMinutes,
      }),
    ]);
    return [
      ...blocked.map((b) => ({ start: b.start_time, end: b.end_time })),
      ...occupying.map((a) => ({ start: a.start_at, end: a.end_at })),
    ];
  }

  /**
   * Occupying appointments overlapping [start,end). Excludes CANCELLED/NO_SHOW +
   * soft-deleted (via OCCUPYING_APPOINTMENT_STATUSES + the default soft-delete
   * filter), matching the Appointment module's conflict rule exactly.
   *
   * SCOPE — deliberately asymmetric, and it matters:
   *  - with a `staffId`, the query is NOT branch-filtered. A person cannot be in
   *    two places at once, so "busy at branch A" must also mean "busy at branch
   *    B". This is exactly what the `appointments_no_overlap` exclusion
   *    constraint enforces (`"staffId" WITH =`, no branch in the key). Filtering
   *    by branch here made the app-level check LOOSER than the database, so a
   *    cross-branch double-booking got past this check and was then rejected by
   *    the constraint with a generic message instead of a specific reason.
   *  - without a `staffId` (the branch-level `summary()` facet), the branch
   *    filter is the whole point — it answers "how busy is this branch today?".
   *
   * Runs inside the caller's transaction when a `manager` is supplied. Note that
   * this alone is NOT race-safe under READ COMMITTED (no gap locks): the actual
   * guarantee against concurrent double-booking is the exclusion constraint,
   * which turns the loser of a race into SQLSTATE 23P01 → SLOT_ALREADY_BOOKED.
   */
  private findOccupying(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
    opts: OccupancyOptions = {},
  ): Promise<Appointment[]> {
    const repo = opts.manager
      ? opts.manager.getRepository(Appointment)
      : this.appointments;
    // AIE-A04: widen each occupying appointment's window by the staff's
    // buffer on both sides — [start_at - buffer, end_at + buffer) — before
    // testing overlap against [start, end). Equivalent to testing
    // start_at < end + buffer AND end_at > start - buffer. A zero (or
    // absent) buffer reduces to the original unbuffered comparison exactly.
    const bufferMs =
      (opts.staffId && opts.bufferMinutes ? opts.bufferMinutes : 0) * 60_000;
    const where: FindOptionsWhere<Appointment> = {
      tenant: { id: tenantId },
      status: In(OCCUPYING_APPOINTMENT_STATUSES),
      start_at: LessThan(new Date(end.getTime() + bufferMs)),
      end_at: MoreThan(new Date(start.getTime() - bufferMs)),
    };
    if (opts.staffId) where.staff = { id: opts.staffId };
    else where.branch = { id: branchId };
    if (opts.excludeAppointmentId) where.id = Not(opts.excludeAppointmentId);
    return repo.find({ where });
  }

  private window(q: AvailabilityQueryDto): { start: Date; end: Date } {
    const start = new Date(q.startTime!);
    const end = new Date(q.endTime!);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
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
