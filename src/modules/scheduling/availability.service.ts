import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, LessThan, MoreThan, Repository } from 'typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppError, ErrorCode } from '../../common/errors';

import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlotService } from './calendar-slot.service';
import { BlockedSlotService } from './blocked-slot.service';
import { HolidayService } from './holiday.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import {
  Interval,
  OCCUPYING_APPOINTMENT_STATUSES,
  chunkIntervals,
  dayBoundsUtc,
  maxDate,
  mergeIntervals,
  minDate,
  subtractIntervals,
  totalMinutes,
} from './scheduling.constants';

/**
 * Availability engine — the core of the Scheduling domain. Composes the three
 * data sources (calendar slots = positive availability, blocked slots, holidays)
 * with existing appointments to answer availability questions. Tenant-scoped
 * throughout; every branch/staff reference is tenant-validated.
 *
 * Availability model: a window is bookable only if it falls inside an AVAILABLE
 * calendar slot, the date is not a holiday, it does not overlap a blocked period,
 * and it does not overlap an occupying appointment.
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
  ) {}

  /** Availability lookup for a specific window. */
  async check(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'startTime', 'endTime']);
    await this.refs.assertBranch(tenantId, q.branchId);
    await this.refs.assertStaff(tenantId, q.staffId!);
    const { start, end } = this.window(q);

    const ev = await this.evaluate(tenantId, q.branchId, q.staffId!, start, end);
    return {
      available: ev.available,
      window: { startTime: start.toISOString(), endTime: end.toISOString() },
      withinAvailability: ev.withinSlot,
      conflicts: {
        holiday: ev.isHoliday,
        blocked: ev.isBlocked,
        occupied: ev.isOccupied,
      },
      details: {
        holidays: ev.holidays.map((h) => ({ id: h.id, name: h.name, date: h.date })),
        blockedSlots: ev.blocked.map((b) => ({
          id: b.id,
          start_time: b.start_time,
          end_time: b.end_time,
          reason: b.reason,
        })),
        appointments: ev.appts.map((a) => ({
          id: a.id,
          start_at: a.start_at,
          end_at: a.end_at,
          status: a.status,
        })),
      },
    };
  }

  /** Booking validation — returns whether an appointment can be created + why not. */
  async validate(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'startTime', 'endTime']);
    await this.refs.assertBranch(tenantId, q.branchId);
    await this.refs.assertStaff(tenantId, q.staffId!);
    const { start, end } = this.window(q);

    const ev = await this.evaluate(tenantId, q.branchId, q.staffId!, start, end);
    const reasons: string[] = [];
    if (!ev.withinSlot) reasons.push('No available calendar slot covers the requested window');
    if (ev.isHoliday) reasons.push('The requested date is a holiday');
    if (ev.isBlocked) reasons.push('The window overlaps a blocked period');
    if (ev.isOccupied) reasons.push('The window overlaps an existing appointment');

    return {
      valid: reasons.length === 0,
      window: { startTime: start.toISOString(), endTime: end.toISOString() },
      reasons,
    };
  }

  /** Free bookable windows for a staff member on a day. */
  async windows(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['staffId', 'date']);
    await this.refs.assertBranch(tenantId, q.branchId);
    await this.refs.assertStaff(tenantId, q.staffId!);
    const { dayStart, dayEnd } = dayBoundsUtc(q.date!);

    const holidays = await this.holidayService.findForDate(tenantId, q.branchId, q.date!);
    if (holidays.length > 0) {
      return { date: q.date, branchId: q.branchId, staffId: q.staffId, holiday: true, windows: [] };
    }

    const free = await this.computeFree(tenantId, q.branchId, q.staffId, dayStart, dayEnd);
    const windows = q.slotMinutes ? chunkIntervals(free, q.slotMinutes) : free;
    return {
      date: q.date,
      branchId: q.branchId,
      staffId: q.staffId,
      holiday: false,
      windows: windows.map((w) => ({
        startTime: w.start.toISOString(),
        endTime: w.end.toISOString(),
      })),
    };
  }

  /** Availability summary for a day: available / blocked / holiday / occupied. */
  async summary(tenantId: string, q: AvailabilityQueryDto) {
    this.requireFields(q, ['date']);
    await this.refs.assertBranch(tenantId, q.branchId);
    if (q.staffId) await this.refs.assertStaff(tenantId, q.staffId);
    const { dayStart, dayEnd } = dayBoundsUtc(q.date!);

    const [holidays, slots, blocked, appts] = await Promise.all([
      this.holidayService.findForDate(tenantId, q.branchId, q.date!),
      this.slotService.findAvailableForDay(tenantId, q.branchId, dayStart, dayEnd, q.staffId),
      this.blockedService.findOverlapping(tenantId, q.branchId, dayStart, dayEnd, q.staffId),
      this.findOccupying(tenantId, q.branchId, dayStart, dayEnd, q.staffId),
    ]);

    const busy = this.busyIntervals(blocked, appts);
    const free = mergeIntervals(
      slots.flatMap((s) =>
        subtractIntervals(
          { start: maxDate(s.start_time, dayStart), end: minDate(s.end_time, dayEnd) },
          busy,
        ),
      ),
    );

    return {
      date: q.date,
      branchId: q.branchId,
      staffId: q.staffId ?? null,
      holiday: {
        isHoliday: holidays.length > 0,
        items: holidays.map((h) => ({ id: h.id, name: h.name, date: h.date })),
      },
      available: {
        slotCount: slots.length,
        freeWindows: free.length,
        freeMinutes: totalMinutes(free),
      },
      blocked: {
        count: blocked.length,
        minutes: totalMinutes(blocked.map((b) => ({ start: b.start_time, end: b.end_time }))),
      },
      occupied: {
        count: appts.length,
        minutes: totalMinutes(appts.map((a) => ({ start: a.start_at, end: a.end_at }))),
      },
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private async evaluate(
    tenantId: string,
    branchId: string,
    staffId: string,
    start: Date,
    end: Date,
  ) {
    const [holidays, blocked, covering, appts] = await Promise.all([
      this.holidayService.findForDate(tenantId, branchId, start),
      this.blockedService.findOverlapping(tenantId, branchId, start, end, staffId),
      this.slotService.findCovering(tenantId, branchId, staffId, start, end),
      this.findOccupying(tenantId, branchId, start, end, staffId),
    ]);

    const withinSlot = covering.length > 0;
    const isHoliday = holidays.length > 0;
    const isBlocked = blocked.length > 0;
    const isOccupied = appts.length > 0;
    return {
      withinSlot,
      isHoliday,
      isBlocked,
      isOccupied,
      available: withinSlot && !isHoliday && !isBlocked && !isOccupied,
      holidays,
      blocked,
      appts,
    };
  }

  private async computeFree(
    tenantId: string,
    branchId: string,
    staffId: string | undefined,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<Interval[]> {
    const [slots, blocked, appts] = await Promise.all([
      this.slotService.findAvailableForDay(tenantId, branchId, dayStart, dayEnd, staffId),
      this.blockedService.findOverlapping(tenantId, branchId, dayStart, dayEnd, staffId),
      this.findOccupying(tenantId, branchId, dayStart, dayEnd, staffId),
    ]);
    const busy = this.busyIntervals(blocked, appts);
    return mergeIntervals(
      slots.flatMap((s) =>
        subtractIntervals(
          { start: maxDate(s.start_time, dayStart), end: minDate(s.end_time, dayEnd) },
          busy,
        ),
      ),
    );
  }

  private busyIntervals(
    blocked: { start_time: Date; end_time: Date }[],
    appts: { start_at: Date; end_at: Date }[],
  ): Interval[] {
    return [
      ...blocked.map((b) => ({ start: b.start_time, end: b.end_time })),
      ...appts.map((a) => ({ start: a.start_at, end: a.end_at })),
    ];
  }

  /** Active (occupying) appointments overlapping [start, end) for branch (+staff?). */
  private findOccupying(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
    staffId?: string,
  ): Promise<Appointment[]> {
    const where: FindOptionsWhere<Appointment> = {
      tenant: { id: tenantId },
      branch: { id: branchId },
      status: In(OCCUPYING_APPOINTMENT_STATUSES),
      start_at: LessThan(end),
      end_at: MoreThan(start),
    };
    if (staffId) where.staff = { id: staffId };
    return this.appointments.find({ where });
  }

  private window(q: AvailabilityQueryDto): { start: Date; end: Date } {
    const start = new Date(q.startTime!);
    const end = new Date(q.endTime!);
    if (end.getTime() <= start.getTime()) {
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
