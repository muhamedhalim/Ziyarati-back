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
    const branch = await this.branches.findOne({
      where: { id: branchId, tenant: { id: tenantId } },
    });
    if (!branch) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
  }

  async assertStaff(tenantId: string, staffId: string): Promise<void> {
    const staff = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!staff) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
  }
}
