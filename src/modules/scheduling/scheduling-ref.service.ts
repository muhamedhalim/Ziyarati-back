import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
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
    @InjectRepository(StaffSchedule)
    private readonly schedules: Repository<StaffSchedule>,
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
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return staff;
  }

  /**
   * F-4 / F-3 — the branch dimension of "may this doctor be booked here?".
   *
   * `StaffProfile` has no branch relation, and `assertStaff` only ever checked
   * the TENANT. The single structural link is `staff_schedules.branchId`, and it
   * was consulted only inside `AvailabilityService.recurringWindows`, which
   * fails OPEN when nothing matches (`ENFORCE_AVAILABILITY_WHEN_UNDEFINED =
   * false`): no schedule at the branch meant "no constraint", i.e. a doctor who
   * works only at branch A was bookable at branch B, at any hour.
   *
   * The rule, mirroring the branch-service rule (D1) — explicit configuration
   * wins:
   *
   *  - a doctor with AT LEAST ONE active schedule anywhere in the clinic MUST
   *    have one at `branchId`; otherwise they do not work there; and
   *  - a doctor with NO schedules at all is unconfigured legacy data, allowed
   *    through so a clinic that books manually without ever filling in
   *    schedules keeps working.
   *
   * `strict` removes that second allowance. The PUBLIC booking flow always
   * passes `strict: true`: an anonymous visitor may only book a doctor whose
   * working hours at that branch are actually known.
   */
  async assertStaffAtBranch(
    tenantId: string,
    branchId: string,
    staffId: string,
    opts: { strict?: boolean } = {},
  ): Promise<StaffProfile> {
    const staff = await this.getStaff(tenantId, staffId);

    if (staff.deleted_at) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    if (!staff.is_available_for_booking) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This staff member is not available for booking',
      });
    }

    const atBranch = await this.schedules.exists({
      where: {
        tenant: { id: tenantId },
        staff: { id: staffId },
        branch: { id: branchId },
        is_active: true,
      },
    });
    if (atBranch) return staff;

    if (!opts.strict) {
      const anywhere = await this.schedules.exists({
        where: {
          tenant: { id: tenantId },
          staff: { id: staffId },
          is_active: true,
        },
      });
      // Nothing configured anywhere → legacy tenant, no branch opinion to enforce.
      if (!anywhere) return staff;
    }

    throw new AppError(ErrorCode.CONFLICT, {
      message: 'This staff member does not work at the selected branch',
      publicContext: { branchId, staffId },
    });
  }
}
