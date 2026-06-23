import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Supporting validator: confirms a referenced branch / staff belongs to the
 * caller's tenant before it is linked to a scheduling row. Centralized here so
 * tenant-ownership of cross-domain references is enforced consistently (DRY)
 * across all scheduling services — never trusting an id from the request alone.
 */
@Injectable()
export class SchedulingRefService {
  constructor(
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
  ) {}

  async assertBranch(tenantId: string, branchId: string): Promise<void> {
    await this.getBranch(tenantId, branchId);
  }

  /** Loads a tenant-owned branch (incl. `timezone`) or 404. */
  async getBranch(tenantId: string, branchId: string): Promise<Branch> {
    const branch = await this.branches.findOne({
      where: { id: branchId, tenant: { id: tenantId } },
    });
    if (!branch) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
    return branch;
  }

  async assertStaff(tenantId: string, staffId: string): Promise<void> {
    await this.getStaff(tenantId, staffId);
  }

  /** Loads a tenant-owned staff profile (incl. `is_available_for_booking`) or 404. */
  async getStaff(tenantId: string, staffId: string): Promise<StaffProfile> {
    const staff = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!staff) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
    return staff;
  }
}
