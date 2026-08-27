import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import { StaffTimeOff } from '../../entities/Staff/StaffTimeOff';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';

import { AppError, ErrorCode } from '../../common/errors';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { CreateWorkingHoursDto } from './dto/create-working-hours.dto';
import { UpdateWorkingHoursDto } from './dto/update-working-hours.dto';

const MINUTES_PER_DAY = 24 * 60;

/** "HH:MM[:SS]" → minutes since midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}
function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** Half-open overlap of two [start,end) ranges expressed in minutes. */
function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

/**
 * Weekday (0=Sun … 6=Sat) of a 'YYYY-MM-DD' calendar date, computed from the
 * date parts alone.
 *
 * This used to be `new Date(\`${dateStr}T00:00:00Z\`).getUTCDay()`. `dateStr` is
 * already a LOCAL calendar date for the branch, so round-tripping it through an
 * instant re-introduces a timezone the value never had: for a branch in a
 * negative-offset zone the midnight instant can land on the previous UTC day and
 * the schedule lookup picks the wrong weekday. Sakamoto's algorithm answers the
 * question the caller is actually asking — "what weekday is this date?" — with
 * no instant, and therefore no zone, involved.
 */
function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const shift = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const year = m < 3 ? y - 1 : y;
  return (
    (year +
      Math.floor(year / 4) -
      Math.floor(year / 100) +
      Math.floor(year / 400) +
      shift[m - 1] +
      d) %
    7
  );
}

/**
 * Staff weekly schedules (per-staff availability), branch working hours
 * (clinic open/close), and the availability lookup that combines them.
 *
 * Tenant isolation: every query is scoped to `tenant: { id }`; staff and branch
 * references are validated against the tenant before any write.
 */
@Injectable()
export class StaffScheduleService {
  private readonly logger = new Logger(StaffScheduleService.name);

  constructor(
    @InjectRepository(StaffSchedule)
    private readonly schedules: Repository<StaffSchedule>,
    @InjectRepository(WorkingHour)
    private readonly workingHours: Repository<WorkingHour>,
    @InjectRepository(StaffTimeOff)
    private readonly timeOff: Repository<StaffTimeOff>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
  ) {}

  // ─────────────────────────── Staff schedules ───────────────────────────── //

  async createSchedule(
    tenantId: string,
    staffId: string,
    dto: CreateScheduleDto,
  ): Promise<StaffSchedule> {
    await this.assertStaff(tenantId, staffId);
    await this.assertBranch(tenantId, dto.branchId);
    await this.assertStaffAssignedToBranch(tenantId, staffId, dto.branchId);
    this.assertTimeOrder(dto.startTime, dto.endTime);

    await this.assertNoScheduleOverlap(
      tenantId,
      staffId,
      dto.dayOfWeek,
      dto.startTime,
      dto.endTime,
    );

    const row = this.schedules.create({
      staff: { id: staffId } as StaffProfile,
      branch: { id: dto.branchId } as Branch,
      tenant: { id: tenantId } as Tenant,
      day_of_week: dto.dayOfWeek,
      start_time: dto.startTime,
      end_time: dto.endTime,
      is_active: dto.isActive ?? true,
    });
    return this.schedules.save(row);
  }

  async listSchedules(tenantId: string, staffId: string): Promise<StaffSchedule[]> {
    await this.assertStaff(tenantId, staffId);
    return this.schedules.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { branch: true },
      order: { day_of_week: 'ASC', start_time: 'ASC' },
    });
  }

  /**
   * Has this staff member been given ANY active weekly schedule (on any day,
   * at any branch)? Used by `AvailabilityService` to decide whether "no
   * schedule row for this particular day" means "unrestricted" (never
   * configured — the pre-existing default-open behaviour) or "not a working
   * day" (the admin explicitly defined a working-days set for this person,
   * so a day outside it must be enforced regardless of the tenant-wide
   * `enforce_staff_working_hours` toggle).
   */
  async hasAnySchedule(tenantId: string, staffId: string): Promise<boolean> {
    return this.schedules.exists({
      where: { staff: { id: staffId }, tenant: { id: tenantId }, is_active: true },
    });
  }

  async updateSchedule(
    tenantId: string,
    staffId: string,
    scheduleId: string,
    dto: UpdateScheduleDto,
  ): Promise<StaffSchedule> {
    await this.assertStaff(tenantId, staffId);
    const row = await this.schedules.findOne({
      where: { id: scheduleId, staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { branch: true },
    });
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Schedule not found' });
    }

    if (dto.branchId) {
      await this.assertBranch(tenantId, dto.branchId);
      await this.assertStaffAssignedToBranch(tenantId, staffId, dto.branchId);
      row.branch = { id: dto.branchId } as Branch;
    }
    if (dto.dayOfWeek !== undefined) row.day_of_week = dto.dayOfWeek;
    if (dto.startTime) row.start_time = dto.startTime;
    if (dto.endTime) row.end_time = dto.endTime;
    if (dto.isActive !== undefined) row.is_active = dto.isActive;

    this.assertTimeOrder(row.start_time, row.end_time);
    if (row.is_active) {
      await this.assertNoScheduleOverlap(
        tenantId,
        staffId,
        row.day_of_week,
        row.start_time,
        row.end_time,
        scheduleId,
      );
    }

    return this.schedules.save(row);
  }

  async removeSchedule(
    tenantId: string,
    staffId: string,
    scheduleId: string,
  ): Promise<void> {
    await this.assertStaff(tenantId, staffId);
    const res = await this.schedules.delete({
      id: scheduleId,
      staff: { id: staffId },
      tenant: { id: tenantId },
    });
    if (!res.affected) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Schedule not found' });
    }
  }

  // ─────────────────────────── Working hours ─────────────────────────────── //

  async createWorkingHours(
    tenantId: string,
    dto: CreateWorkingHoursDto,
  ): Promise<WorkingHour> {
    await this.assertBranch(tenantId, dto.branchId);
    this.assertTimeOrder(dto.startTime, dto.endTime);

    if (!dto.isClosed) {
      await this.assertNoWorkingHoursOverlap(
        tenantId,
        dto.branchId,
        dto.dayOfWeek,
        dto.startTime,
        dto.endTime,
      );
    }

    const row = this.workingHours.create({
      branch: { id: dto.branchId } as Branch,
      tenant: { id: tenantId } as Tenant,
      day_of_week: dto.dayOfWeek,
      start_time: dto.startTime,
      end_time: dto.endTime,
      is_closed: dto.isClosed ?? false,
    });
    return this.workingHours.save(row);
  }

  async listWorkingHours(tenantId: string, branchId: string): Promise<WorkingHour[]> {
    await this.assertBranch(tenantId, branchId);
    return this.workingHours.find({
      where: { branch: { id: branchId }, tenant: { id: tenantId } },
      order: { day_of_week: 'ASC', start_time: 'ASC' },
    });
  }

  async updateWorkingHours(
    tenantId: string,
    id: string,
    dto: UpdateWorkingHoursDto,
  ): Promise<WorkingHour> {
    const row = await this.workingHours.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { branch: true },
    });
    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Working-hours entry not found' });
    }
    if (dto.branchId) {
      await this.assertBranch(tenantId, dto.branchId);
      row.branch = { id: dto.branchId } as Branch;
    }
    if (dto.dayOfWeek !== undefined) row.day_of_week = dto.dayOfWeek;
    if (dto.startTime) row.start_time = dto.startTime;
    if (dto.endTime) row.end_time = dto.endTime;
    if (dto.isClosed !== undefined) row.is_closed = dto.isClosed;

    this.assertTimeOrder(row.start_time, row.end_time);
    if (!row.is_closed) {
      await this.assertNoWorkingHoursOverlap(
        tenantId,
        row.branch.id,
        row.day_of_week,
        row.start_time,
        row.end_time,
        id,
      );
    }
    return this.workingHours.save(row);
  }

  async removeWorkingHours(tenantId: string, id: string): Promise<void> {
    const res = await this.workingHours.delete({ id, tenant: { id: tenantId } });
    if (!res.affected) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Working-hours entry not found' });
    }
  }

  // ─────────────────────────── Availability ──────────────────────────────── //

  /**
   * Which staff are bookable at a branch on a date, with concrete time windows
   * (their active schedule slots intersected with the branch's open hours),
   * excluding unavailable staff and anyone on time off that day.
   */
  async getAvailability(tenantId: string, branchId: string, dateStr: string) {
    await this.assertBranch(tenantId, branchId);

    // `dateStr` is the branch's LOCAL calendar date — see `weekdayOf`.
    const dayOfWeek = weekdayOf(dateStr); // 0=Sun … 6=Sat

    // 1) Is the branch open that day?
    //
    // `Branch.create()` never seeds default `WorkingHour` rows — a clinic
    // starts with NONE configured, for ANY day, until an admin explicitly
    // visits Branches → Working Hours. That means "no WorkingHour row for
    // this day" is an extremely common, entirely normal state — most clinics
    // set up staff schedules first — and it must NOT be conflated with "the
    // branch is explicitly closed", or a correctly-scheduled staff member
    // would show zero availability on their own working day for a reason
    // that has nothing to do with them. Only an explicit `is_closed: true`
    // row is a real closure; the absence of any row for the day means
    // "branch hours aren't configured for this day", so the branch imposes
    // no additional constraint and the staff member's own schedule alone
    // defines the bookable window (still gated by every other check below —
    // is_available_for_booking, time off, blocked slots, existing bookings).
    const allBranchHours = await this.workingHours.find({
      where: { branch: { id: branchId }, tenant: { id: tenantId }, day_of_week: dayOfWeek },
    });
    const explicitlyClosed = allBranchHours.some((w) => w.is_closed);
    if (explicitlyClosed) {
      return { date: dateStr, branchId, dayOfWeek, open: false, staff: [] };
    }
    const branchHours = allBranchHours.filter((w) => !w.is_closed);
    const branchHoursConfigured = branchHours.length > 0;
    // Unconfigured ⇒ a single all-day window, so intersecting a staff slot
    // against it below is a no-op and the staff's own hours pass through
    // untouched. Configured ⇒ the real, admin-set open windows, exactly as
    // before.
    const openWindows = branchHoursConfigured
      ? branchHours.map((w) => ({
          start: toMinutes(w.start_time),
          end: toMinutes(w.end_time),
        }))
      : [{ start: 0, end: MINUTES_PER_DAY }];

    // 2) Active staff schedules at this branch/day.
    //
    // Uses an explicit INNER JOIN to `staff` (and `staff.tenant`), not
    // `.find({ relations: { staff: ... } })`. TypeORM's `relations` option
    // always compiles to a LEFT JOIN, and for a soft-deletable target
    // (`StaffProfile.deleted_at`) it appends `staff.deleted_at IS NULL` to
    // the JOIN CONDITION, not a WHERE clause — so a `StaffSchedule` row left
    // behind by a soft-deleted staff member (soft-delete does not cascade;
    // only a hard DELETE does, via `onDelete: 'CASCADE'`) survives the LEFT
    // JOIN with `staff: null` instead of being dropped. One such row is
    // enough to crash every staff member's availability lookup for that
    // branch/day, since this query returns them all in one batch. An INNER
    // JOIN drops the row when the match fails, which is also the correct
    // business rule: a deleted (or otherwise no-longer-resolvable) staff
    // member is never bookable.
    const slots = await this.schedules
      .createQueryBuilder('schedule')
      .innerJoinAndSelect('schedule.staff', 'staff')
      .leftJoinAndSelect('staff.user', 'user')
      .innerJoin('schedule.branch', 'branch')
      .innerJoin('schedule.tenant', 'tenant')
      .innerJoin('staff.tenant', 'staffTenant')
      .where('branch.id = :branchId', { branchId })
      .andWhere('tenant.id = :tenantId', { tenantId })
      .andWhere('staffTenant.id = :tenantId', { tenantId })
      .andWhere('schedule.day_of_week = :dayOfWeek', { dayOfWeek })
      .andWhere('schedule.is_active = :isActive', { isActive: true })
      .getMany();

    // Defense-in-depth, not the fix: the query above already excludes any
    // schedule whose staff member no longer resolves (soft-deleted, or any
    // future orphaned reference) via an INNER JOIN, so `resolvedSlots` should
    // always equal `slots` in production. This guard means that if that ever
    // stops being true — a future refactor back to `find({ relations })`, a
    // raw-SQL insert, replica lag — one bad row still cannot 500 every OTHER
    // staff member's availability in the same batch; it is just excluded,
    // and logged so the underlying data issue stays visible.
    const resolvedSlots = slots.filter((slot) => {
      if (slot.staff) return true;
      this.logger.warn(
        `Schedule ${slot.id} has no resolvable staff member (branch ${branchId}, tenant ${tenantId}, day ${dayOfWeek}) — skipped`,
      );
      return false;
    });
    if (resolvedSlots.length === 0) {
      return { date: dateStr, branchId, dayOfWeek, open: true, staff: [] };
    }

    // 3) Exclude staff on time off covering the date (date strings compare lexicographically).
    const staffIds = [...new Set(resolvedSlots.map((s) => s.staff.id))];
    const onLeaveStaff = new Set<string>();
    const offs = await this.timeOff.find({
      where: { staff: In(staffIds), tenant: { id: tenantId } },
      relations: { staff: true },
    });
    for (const o of offs) {
      const start = this.dateOnly(o.start_date);
      const end = this.dateOnly(o.end_date);
      if (start <= dateStr && dateStr <= end) onLeaveStaff.add(o.staff.id);
    }

    // 4) Build per-staff bookable windows (schedule ∩ branch open hours).
    const byStaff = new Map<
      string,
      { staffId: string; title?: string; name?: string; windows: { start: string; end: string }[] }
    >();

    for (const slot of resolvedSlots) {
      const staffMember = slot.staff;
      if (!staffMember.is_available_for_booking) continue;
      if (onLeaveStaff.has(staffMember.id)) continue;

      const sStart = toMinutes(slot.start_time);
      const sEnd = toMinutes(slot.end_time);

      const windows: { start: string; end: string }[] = [];
      for (const w of openWindows) {
        const start = Math.max(sStart, w.start);
        const end = Math.min(sEnd, w.end);
        if (start < end) windows.push({ start: toHHMM(start), end: toHHMM(end) });
      }
      if (windows.length === 0) continue;

      const entry =
        byStaff.get(staffMember.id) ?? {
          staffId: staffMember.id,
          title: staffMember.title,
          name: staffMember.user?.full_name ?? undefined,
          windows: [],
        };
      entry.windows.push(...windows);
      byStaff.set(staffMember.id, entry);
    }

    return {
      date: dateStr,
      branchId,
      dayOfWeek,
      open: true,
      // Reports the branch's ACTUAL configured hours — `[]` (not an
      // all-day window) when none exist for this day, so a caller can tell
      // "the branch imposed no constraint because nobody configured it"
      // apart from "the branch is open all day by design".
      branchHours: branchHoursConfigured
        ? openWindows.map((w) => ({ start: toHHMM(w.start), end: toHHMM(w.end) }))
        : [],
      branchHoursConfigured,
      staff: [...byStaff.values()],
    };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private dateOnly(value: Date | string): string {
    return typeof value === 'string'
      ? value.slice(0, 10)
      : new Date(value).toISOString().slice(0, 10);
  }

  private assertTimeOrder(start: string, end: string): void {
    if (toMinutes(end) <= toMinutes(start)) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'endTime must be after startTime',
      });
    }
  }

  private async assertStaff(tenantId: string, staffId: string): Promise<void> {
    const ok = await this.staff.exists({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
  }

  private async assertBranch(tenantId: string, branchId: string): Promise<void> {
    const ok = await this.branches.exists({
      where: { id: branchId, tenant: { id: tenantId } },
    });
    if (!ok) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Branch not found in this clinic',
      });
    }
  }

  /**
   * A weekly schedule at a branch the staff member isn't even assigned to
   * (via `branch_users`) is silently unreachable: the "New Appointment"
   * employee picker filters staff by `branch_users`, so this person would
   * never even be selectable for that branch to begin with, while
   * `AvailabilityService` resolves recurring windows strictly by
   * `StaffSchedule.branch` — the two never meet, and the ONLY symptom is an
   * empty slot grid with no indication why. Rejecting the mismatch here, at
   * write time, is cheaper than ever having to diagnose it from an empty
   * read. A staff member with NO branch assignment at all (legacy data,
   * pre-dating branch assignment, or a single-branch clinic where the
   * assignment step was skipped) is let through — nothing to check against.
   */
  private async assertStaffAssignedToBranch(
    tenantId: string,
    staffId: string,
    branchId: string,
  ): Promise<void> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }

    const assignedAnywhere = await this.branchUsers.exists({
      where: { tenant: { id: tenantId }, user: { id: profile.user.id } },
    });
    // No branch assignment at all — legacy/unconfigured data, nothing to
    // check the schedule's branch against. `createSchedule`/`updateSchedule`
    // already validated `branchId` belongs to this TENANT via `assertBranch`.
    if (!assignedAnywhere) return;

    const assignedHere = await this.branchUsers.exists({
      where: {
        tenant: { id: tenantId },
        user: { id: profile.user.id },
        branch: { id: branchId },
      },
    });
    if (!assignedHere) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'This staff member is not assigned to the selected branch. Assign them to this branch first (Staff → Branches).',
        publicContext: { staffId, branchId },
      });
    }
  }

  private async assertNoScheduleOverlap(
    tenantId: string,
    staffId: string,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.schedules.find({
      where: {
        staff: { id: staffId },
        tenant: { id: tenantId },
        day_of_week: dayOfWeek,
        is_active: true,
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
    });
    const s = toMinutes(startTime);
    const e = toMinutes(endTime);
    for (const row of existing) {
      if (overlaps(s, e, toMinutes(row.start_time), toMinutes(row.end_time))) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'This schedule overlaps an existing slot for the staff member on that day',
          publicContext: { conflictingScheduleId: row.id },
        });
      }
    }
  }

  private async assertNoWorkingHoursOverlap(
    tenantId: string,
    branchId: string,
    dayOfWeek: number,
    startTime: string,
    endTime: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.workingHours.find({
      where: {
        branch: { id: branchId },
        tenant: { id: tenantId },
        day_of_week: dayOfWeek,
        is_closed: false,
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
    });
    const s = toMinutes(startTime);
    const e = toMinutes(endTime);
    for (const row of existing) {
      if (overlaps(s, e, toMinutes(row.start_time), toMinutes(row.end_time))) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: 'These working hours overlap an existing open slot for the branch on that day',
          publicContext: { conflictingWorkingHoursId: row.id },
        });
      }
    }
  }
}
