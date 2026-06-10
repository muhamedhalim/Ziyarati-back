import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { CalendarSlot } from '../../entities/Calendar&Appointments/CalendarSlot';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppError, ErrorCode } from '../../common/errors';

import { SchedulingRefService } from './scheduling-ref.service';
import { CreateCalendarSlotDto } from './dto/create-calendar-slot.dto';
import { UpdateCalendarSlotDto } from './dto/update-calendar-slot.dto';
import { CalendarSlotFilterDto } from './dto/calendar-slot-filter.dto';

/**
 * Calendar slots (`calendar_slots`) — concrete availability windows per
 * staff+branch. Tenant-scoped via the `tenant` relation; branch + staff are
 * tenant-validated before linking. The schema has no recurrence fields, so each
 * slot is a single datetime window enabled/disabled via `is_available`.
 */
@Injectable()
export class CalendarSlotService {
  constructor(
    @InjectRepository(CalendarSlot)
    private readonly slots: Repository<CalendarSlot>,
    private readonly refs: SchedulingRefService,
  ) {}

  async create(tenantId: string, dto: CreateCalendarSlotDto): Promise<CalendarSlot> {
    await this.refs.assertBranch(tenantId, dto.branchId);
    await this.refs.assertStaff(tenantId, dto.staffId);

    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    this.assertRange(start, end);

    return this.slots.save(
      this.slots.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: dto.branchId } as Branch,
        staff: { id: dto.staffId } as StaffProfile,
        start_time: start,
        end_time: end,
        is_available: dto.isAvailable ?? true,
      }),
    );
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCalendarSlotDto,
  ): Promise<CalendarSlot> {
    const slot = await this.findOneOrThrow(tenantId, id);

    if (dto.branchId) {
      await this.refs.assertBranch(tenantId, dto.branchId);
      slot.branch = { id: dto.branchId } as Branch;
    }
    if (dto.staffId) {
      await this.refs.assertStaff(tenantId, dto.staffId);
      slot.staff = { id: dto.staffId } as StaffProfile;
    }
    if (dto.startTime) slot.start_time = new Date(dto.startTime);
    if (dto.endTime) slot.end_time = new Date(dto.endTime);
    if (dto.isAvailable !== undefined) slot.is_available = dto.isAvailable;

    this.assertRange(slot.start_time, slot.end_time);
    return this.slots.save(slot);
  }

  async remove(tenantId: string, id: string) {
    const slot = await this.findOneOrThrow(tenantId, id);
    await this.slots.remove(slot);
    return { id, deleted: true };
  }

  async enable(tenantId: string, id: string): Promise<CalendarSlot> {
    const slot = await this.findOneOrThrow(tenantId, id);
    slot.is_available = true;
    return this.slots.save(slot);
  }

  async disable(tenantId: string, id: string): Promise<CalendarSlot> {
    const slot = await this.findOneOrThrow(tenantId, id);
    slot.is_available = false;
    return this.slots.save(slot);
  }

  get(tenantId: string, id: string): Promise<CalendarSlot> {
    return this.findOneOrThrow(tenantId, id, true);
  }

  async list(tenantId: string, filter: CalendarSlotFilterDto) {
    const where: FindOptionsWhere<CalendarSlot> = { tenant: { id: tenantId } };
    if (filter.branchId) where.branch = { id: filter.branchId };
    if (filter.staffId) where.staff = { id: filter.staffId };
    if (filter.isAvailable !== undefined) where.is_available = filter.isAvailable;
    if (filter.from && filter.to) {
      where.start_time = Between(new Date(filter.from), new Date(filter.to));
    } else if (filter.from) {
      where.start_time = MoreThanOrEqual(new Date(filter.from));
    } else if (filter.to) {
      where.start_time = LessThan(new Date(filter.to));
    }

    const [data, total] = await this.slots.findAndCount({
      where,
      relations: { branch: true, staff: true },
      order: { start_time: filter.sort === 'desc' ? 'DESC' : 'ASC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  // ───────────────────── Availability-engine helpers ─────────────────────── //

  /** Available slots that fully cover [start, end] for the given staff+branch. */
  findCovering(
    tenantId: string,
    branchId: string,
    staffId: string,
    start: Date,
    end: Date,
  ): Promise<CalendarSlot[]> {
    return this.slots.find({
      where: {
        tenant: { id: tenantId },
        branch: { id: branchId },
        staff: { id: staffId },
        is_available: true,
        start_time: LessThanOrEqual(start),
        end_time: MoreThanOrEqual(end),
      },
    });
  }

  /** Available slots overlapping a day window (staff optional → all branch staff). */
  findAvailableForDay(
    tenantId: string,
    branchId: string,
    dayStart: Date,
    dayEnd: Date,
    staffId?: string,
  ): Promise<CalendarSlot[]> {
    const where: FindOptionsWhere<CalendarSlot> = {
      tenant: { id: tenantId },
      branch: { id: branchId },
      is_available: true,
      start_time: LessThan(dayEnd),
      end_time: MoreThan(dayStart),
    };
    if (staffId) where.staff = { id: staffId };
    return this.slots.find({ where });
  }

  private async findOneOrThrow(
    tenantId: string,
    id: string,
    withRelations = false,
  ): Promise<CalendarSlot> {
    const slot = await this.slots.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: withRelations ? { branch: true, staff: true } : undefined,
    });
    if (!slot) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Calendar slot not found' });
    }
    return slot;
  }

  private assertRange(start: Date, end: Date): void {
    if (end.getTime() <= start.getTime()) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'endTime must be after startTime',
      });
    }
  }
}
