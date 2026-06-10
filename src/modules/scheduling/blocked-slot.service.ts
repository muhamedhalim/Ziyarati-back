import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { BlockedSlot } from '../../entities/Calendar&Appointments/BlockedSlot';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppError, ErrorCode } from '../../common/errors';

import { SchedulingRefService } from './scheduling-ref.service';
import { CreateBlockedSlotDto } from './dto/create-blocked-slot.dto';
import { UpdateBlockedSlotDto } from './dto/update-blocked-slot.dto';
import { BlockedSlotFilterDto } from './dto/blocked-slot-filter.dto';

/**
 * Blocked periods (`blocked_slots`). Tenant-scoped via the `tenant` relation;
 * branch + staff are both nullable, so a block can target a staff, a branch, a
 * staff-at-branch, or be tenant-wide. References are tenant-validated when set.
 */
@Injectable()
export class BlockedSlotService {
  constructor(
    @InjectRepository(BlockedSlot)
    private readonly blocks: Repository<BlockedSlot>,
    private readonly refs: SchedulingRefService,
  ) {}

  async create(tenantId: string, dto: CreateBlockedSlotDto): Promise<BlockedSlot> {
    if (dto.branchId) await this.refs.assertBranch(tenantId, dto.branchId);
    if (dto.staffId) await this.refs.assertStaff(tenantId, dto.staffId);

    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    this.assertRange(start, end);

    return this.blocks.save(
      this.blocks.create({
        tenant: { id: tenantId } as Tenant,
        branch: dto.branchId ? ({ id: dto.branchId } as Branch) : undefined,
        staff: dto.staffId ? ({ id: dto.staffId } as StaffProfile) : undefined,
        start_time: start,
        end_time: end,
        reason: dto.reason,
      }),
    );
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateBlockedSlotDto,
  ): Promise<BlockedSlot> {
    const block = await this.findOneOrThrow(tenantId, id);

    if (dto.branchId) {
      await this.refs.assertBranch(tenantId, dto.branchId);
      block.branch = { id: dto.branchId } as Branch;
    }
    if (dto.staffId) {
      await this.refs.assertStaff(tenantId, dto.staffId);
      block.staff = { id: dto.staffId } as StaffProfile;
    }
    if (dto.startTime) block.start_time = new Date(dto.startTime);
    if (dto.endTime) block.end_time = new Date(dto.endTime);
    if (dto.reason !== undefined) block.reason = dto.reason;

    this.assertRange(block.start_time, block.end_time);
    return this.blocks.save(block);
  }

  async remove(tenantId: string, id: string) {
    const block = await this.findOneOrThrow(tenantId, id);
    await this.blocks.remove(block);
    return { id, deleted: true };
  }

  get(tenantId: string, id: string): Promise<BlockedSlot> {
    return this.findOneOrThrow(tenantId, id, true);
  }

  async list(tenantId: string, filter: BlockedSlotFilterDto) {
    const where: FindOptionsWhere<BlockedSlot> = { tenant: { id: tenantId } };
    if (filter.branchId) where.branch = { id: filter.branchId };
    if (filter.staffId) where.staff = { id: filter.staffId };
    if (filter.from && filter.to) {
      where.start_time = Between(new Date(filter.from), new Date(filter.to));
    } else if (filter.from) {
      where.start_time = MoreThanOrEqual(new Date(filter.from));
    } else if (filter.to) {
      where.start_time = LessThan(new Date(filter.to));
    }

    const [data, total] = await this.blocks.findAndCount({
      where,
      relations: { branch: true, staff: true },
      order: { start_time: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  // ───────────────────── Availability-engine helper ──────────────────────── //

  /**
   * Blocks overlapping [start, end) that apply to (branch, staff?). A block with
   * a NULL branch/staff is tenant-/branch-wide and therefore also applies.
   */
  findOverlapping(
    tenantId: string,
    branchId: string,
    start: Date,
    end: Date,
    staffId?: string,
  ): Promise<BlockedSlot[]> {
    const qb = this.blocks
      .createQueryBuilder('b')
      .innerJoin('b.tenant', 't')
      .leftJoin('b.branch', 'br')
      .leftJoin('b.staff', 'st')
      .where('t.id = :tenantId', { tenantId })
      .andWhere('b.start_time < :end', { end })
      .andWhere('b.end_time > :start', { start })
      .andWhere('(br.id IS NULL OR br.id = :branchId)', { branchId });
    if (staffId) {
      qb.andWhere('(st.id IS NULL OR st.id = :staffId)', { staffId });
    }
    return qb.getMany();
  }

  private async findOneOrThrow(
    tenantId: string,
    id: string,
    withRelations = false,
  ): Promise<BlockedSlot> {
    const block = await this.blocks.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: withRelations ? { branch: true, staff: true } : undefined,
    });
    if (!block) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Blocked slot not found' });
    }
    return block;
  }

  private assertRange(start: Date, end: Date): void {
    if (end.getTime() <= start.getTime()) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'endTime must be after startTime',
      });
    }
  }
}
