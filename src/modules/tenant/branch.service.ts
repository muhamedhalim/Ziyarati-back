import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentStatus } from '../../entities/enums';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { AppError, ErrorCode } from '../../common/errors';
import { UsageService } from '../subscription-billing/usage.service';
import { COUNT_LIMIT } from '../subscription-billing/usage-metric';
import { PERMISSION } from '../../rbac/rbac.constants';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';

/** Caller identity for the branches.update_own ownership check (FND-017). */
export interface BranchCaller {
  id: string;
  permissions: string[];
}

/**
 * Branches are a child aggregate of Tenant. EVERY method is scoped to a
 * `tenantId` (supplied by the controller from the authenticated principal), so
 * one clinic can never read or mutate another clinic's branches.
 */
@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    private readonly usage: UsageService,
    private readonly branchScope: BranchScopeService,
  ) {}

  async create(tenantId: string, dto: CreateBranchDto): Promise<Branch> {
    // Plan limit: max_branches. Counts the tenant's existing (non-deleted)
    // branches and rejects (422) when the cap would be exceeded. No-op under
    // free mode / active override.
    const current = await this.branches.count({
      where: { tenant: { id: tenantId } },
    });
    await this.usage.assertCountWithinLimit(
      tenantId,
      COUNT_LIMIT.BRANCHES,
      current,
    );

    const branch = this.branches.create({
      tenant: { id: tenantId } as Tenant,
      name: dto.name,
      address: dto.address,
      city_id: dto.cityId,
      phone: dto.phone,
      whatsapp_phone: dto.whatsappPhone,
      timezone: dto.timezone ?? 'UTC',
      is_active: true,
    });
    return this.branches.save(branch);
  }

  findAll(tenantId: string): Promise<Branch[]> {
    return this.branches.find({
      where: { tenant: { id: tenantId } },
      order: { created_at: 'ASC' },
    });
  }

  async findOne(tenantId: string, id: string): Promise<Branch> {
    const branch = await this.branches.findOne({
      where: { id, tenant: { id: tenantId } },
    });
    if (!branch) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
    return branch;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateBranchDto,
    caller?: BranchCaller,
  ): Promise<Branch> {
    const branch = await this.findOne(tenantId, id);
    // FND-017 — a caller holding only branches.update_own (not the
    // tenant-wide branches.update) may update ONLY a branch they're
    // assigned to. Mirrors the APPOINTMENTS_READ_OWN pattern: the guard
    // only checks flat possession of either slug, so the actual ownership
    // narrowing happens here in the service.
    if (caller && !caller.permissions.includes(PERMISSION.BRANCHES_UPDATE)) {
      await this.assertOwnBranch(tenantId, id, caller.id);
    }
    Object.assign(branch, {
      name: dto.name ?? branch.name,
      address: dto.address ?? branch.address,
      city_id: dto.cityId ?? branch.city_id,
      phone: dto.phone ?? branch.phone,
      whatsapp_phone: dto.whatsappPhone ?? branch.whatsapp_phone,
      timezone: dto.timezone ?? branch.timezone,
      is_active: dto.isActive ?? branch.is_active,
    });
    return this.branches.save(branch);
  }

  /**
   * Deletion is only safe when: (1) it isn't the clinic's last remaining
   * branch — the appointment flow assumes at least one always exists; (2) no
   * staff are currently assigned to it (via `branch_users`) — they must be
   * reassigned first; (3) it has no upcoming, non-cancelled appointments.
   * Historical (past) appointments never block deletion — the soft-delete
   * preserves the branch row for their audit trail.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    const branch = await this.findOne(tenantId, id);

    const totalBranches = await this.branches.count({
      where: { tenant: { id: tenantId } },
    });
    if (totalBranches <= 1) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Cannot delete the only branch. A clinic must have at least one branch.',
      });
    }

    const assignedStaff = await this.branchUsers.count({
      where: { branch: { id }, tenant: { id: tenantId } },
    });
    if (assignedStaff > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Cannot delete a branch with staff assigned to it. Reassign staff to another branch first.',
      });
    }

    const upcomingAppointments = await this.appointments.count({
      where: {
        branch: { id },
        tenant: { id: tenantId },
        start_at: MoreThan(new Date()),
        status: Not(AppointmentStatus.CANCELLED),
      },
    });
    if (upcomingAppointments > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Cannot delete a branch with upcoming appointments. Cancel or reschedule them first.',
      });
    }

    await this.branches.softRemove(branch);
  }

  // ─────────────────────── FND-017: branch ABAC ──────────────────────── //

  /**
   * The membership lookup that used to live here (the `branch_users` query
   * plus its Redis cache) now lives in {@link BranchScopeService} — the one
   * place in the codebase that answers "which branches is this user assigned
   * to". Two other modules had grown their own uncached copies of it;
   * consolidating there removed both and gave them the cache for free.
   *
   * FND-017 semantics are unchanged: possession of the tenant-wide
   * `branches.update` is checked by `update` above, so only a caller holding
   * just `branches.update_own` ever reaches here.
   */
  private async assertOwnBranch(
    tenantId: string,
    branchId: string,
    userId: string,
  ): Promise<void> {
    const ownBranchIds = await this.branchScope.getMembershipBranchIds(
      tenantId,
      userId,
    );
    if (!ownBranchIds.includes(branchId)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, {
        message: 'You can only update a branch you are assigned to',
      });
    }
  }
}
