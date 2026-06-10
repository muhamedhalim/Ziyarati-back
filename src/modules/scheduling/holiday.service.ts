import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { Holiday } from '../../entities/Calendar&Appointments/Holiday';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { AppError, ErrorCode } from '../../common/errors';

import { SchedulingRefService } from './scheduling-ref.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { HolidayFilterDto } from './dto/holiday-filter.dto';
import { toYmd } from './scheduling.constants';

/**
 * Holidays (`holidays`). Tenant-scoped via the `tenant` relation; `branch` is
 * nullable (NULL = company-wide, set = branch-specific). `is_recurring` makes a
 * holiday match the same month/day every year.
 */
@Injectable()
export class HolidayService {
  constructor(
    @InjectRepository(Holiday)
    private readonly holidays: Repository<Holiday>,
    private readonly refs: SchedulingRefService,
  ) {}

  async create(tenantId: string, dto: CreateHolidayDto): Promise<Holiday> {
    if (dto.branchId) await this.refs.assertBranch(tenantId, dto.branchId);
    return this.holidays.save(
      this.holidays.create({
        tenant: { id: tenantId } as Tenant,
        branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
        name: dto.name,
        date: dto.date as unknown as Date,
        is_recurring: dto.isRecurring ?? false,
      }),
    );
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateHolidayDto,
  ): Promise<Holiday> {
    const holiday = await this.findOneOrThrow(tenantId, id);
    if (dto.branchId) {
      await this.refs.assertBranch(tenantId, dto.branchId);
      holiday.branch = { id: dto.branchId } as Branch;
    }
    if (dto.name !== undefined) holiday.name = dto.name;
    if (dto.date) holiday.date = dto.date as unknown as Date;
    if (dto.isRecurring !== undefined) holiday.is_recurring = dto.isRecurring;
    return this.holidays.save(holiday);
  }

  async remove(tenantId: string, id: string) {
    const holiday = await this.findOneOrThrow(tenantId, id);
    await this.holidays.remove(holiday);
    return { id, deleted: true };
  }

  get(tenantId: string, id: string): Promise<Holiday> {
    return this.findOneOrThrow(tenantId, id, true);
  }

  async list(tenantId: string, filter: HolidayFilterDto) {
    const where: FindOptionsWhere<Holiday> = { tenant: { id: tenantId } };
    if (filter.branchId) where.branch = { id: filter.branchId };
    if (filter.isRecurring !== undefined) where.is_recurring = filter.isRecurring;
    if (filter.from && filter.to) {
      where.date = Between(filter.from, filter.to) as any;
    } else if (filter.from) {
      where.date = MoreThanOrEqual(filter.from) as any;
    } else if (filter.to) {
      where.date = LessThanOrEqual(filter.to) as any;
    }

    const [data, total] = await this.holidays.findAndCount({
      where,
      relations: { branch: true },
      order: { date: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  // ───────────────────── Availability-engine helper ──────────────────────── //

  /**
   * Holidays affecting `branch` on a given calendar day. Matches an exact date,
   * or a recurring holiday on the same month/day. Company-wide holidays
   * (branch IS NULL) always apply. Holiday counts are small, so candidates are
   * filtered in memory for the recurring (month/day) comparison.
   */
  async findForDate(
    tenantId: string,
    branchId: string,
    date: Date | string,
  ): Promise<Holiday[]> {
    const ymd = toYmd(date);
    const monthDay = ymd.slice(5);

    const candidates = await this.holidays
      .createQueryBuilder('h')
      .innerJoin('h.tenant', 't')
      .leftJoin('h.branch', 'br')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('(br.id IS NULL OR br.id = :branchId)', { branchId })
      .getMany();

    return candidates.filter((h) => {
      const hYmd = toYmd(h.date);
      if (hYmd === ymd) return true;
      return h.is_recurring && hYmd.slice(5) === monthDay;
    });
  }

  private async findOneOrThrow(
    tenantId: string,
    id: string,
    withRelations = false,
  ): Promise<Holiday> {
    const holiday = await this.holidays.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: withRelations ? { branch: true } : undefined,
    });
    if (!holiday) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Holiday not found' });
    }
    return holiday;
  }
}
