import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { StaffTimeOff } from '../../entities/Staff/StaffTimeOff';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AppError, ErrorCode } from '../../common/errors';
import { CreateTimeOffDto } from './dto/create-time-off.dto';

/**
 * Staff time-off records.
 *
 * ⚠️ Schema reality: `staff_time_off` has only `start_date / end_date / reason`.
 * There is no `status` / `approved_by` column, so (honoring the "do not change
 * the schema" constraint) a persisted row IS the committed absence. A
 * pending→approved→rejected workflow would require a 2-column migration and is
 * out of scope. Endpoints are: create (admin time off / approved leave), list,
 * delete.
 *
 * Tenant isolation: scoped by `tenant: { id }` on every query; the staff member
 * is validated to belong to the tenant.
 */
@Injectable()
export class StaffTimeOffService {
  constructor(
    @InjectRepository(StaffTimeOff)
    private readonly timeOff: Repository<StaffTimeOff>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
  ) {}

  async create(
    tenantId: string,
    staffId: string,
    dto: CreateTimeOffDto,
  ): Promise<StaffTimeOff> {
    await this.assertStaff(tenantId, staffId);

    if (dto.endDate < dto.startDate) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'endDate must be on or after startDate',
      });
    }

    const row = this.timeOff.create({
      staff: { id: staffId } as StaffProfile,
      tenant: { id: tenantId } as Tenant,
      start_date: new Date(dto.startDate),
      end_date: new Date(dto.endDate),
      reason: dto.reason,
    });
    return this.timeOff.save(row);
  }

  /**
   * Is the staff member on time off on a given calendar day ('YYYY-MM-DD')?
   * Reused by the unified availability engine so time-off logic stays in the
   * Staff domain. `start_date`/`end_date` are inclusive `date` columns.
   */
  isOffOn(tenantId: string, staffId: string, dateStr: string): Promise<boolean> {
    return this.timeOff.exists({
      where: {
        staff: { id: staffId },
        tenant: { id: tenantId },
        start_date: LessThanOrEqual(dateStr as unknown as Date),
        end_date: MoreThanOrEqual(dateStr as unknown as Date),
      },
    });
  }

  async list(tenantId: string, staffId: string): Promise<StaffTimeOff[]> {
    await this.assertStaff(tenantId, staffId);
    return this.timeOff.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      order: { start_date: 'DESC' },
    });
  }

  async remove(tenantId: string, staffId: string, timeOffId: string): Promise<void> {
    await this.assertStaff(tenantId, staffId);
    const res = await this.timeOff.delete({
      id: timeOffId,
      staff: { id: staffId },
      tenant: { id: tenantId },
    });
    if (!res.affected) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Time-off record not found' });
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
}
