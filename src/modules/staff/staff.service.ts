import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, In, Repository } from 'typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { User } from '../../entities/Auth&RBAC/User';
import { Service } from '../../entities/Services/Service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

import { AppError, ErrorCode } from '../../common/errors';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { QueryStaffDto } from './dto/query-staff.dto';
import { AssignServicesDto } from './dto/assign-services.dto';
import { AssignBranchesDto } from './dto/assign-branches.dto';

/**
 * Staff profile lifecycle + service/branch assignment.
 *
 * ─── TENANT ISOLATION ───────────────────────────────────────────────────────
 * `tenantId` is always supplied by the controller from the authenticated
 * principal (never the body). It is applied on every read (`tenant: { id }`),
 * stamped on every write, and used to re-validate every referenced resource
 * (user, service, branch) so cross-tenant references are impossible.
 */
@Injectable()
export class StaffService {
  constructor(
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(StaffServiceEntity)
    private readonly staffServices: Repository<StaffServiceEntity>,
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Service) private readonly services: Repository<Service>,
    @InjectRepository(Branch) private readonly branches: Repository<Branch>,
    private readonly dataSource: DataSource,
  ) {}

  // ───────────────────────────── Profile CRUD ────────────────────────────── //

  async create(tenantId: string, dto: CreateStaffDto): Promise<StaffProfile> {
    const user = await this.users.findOne({
      where: { id: dto.userId, tenant: { id: tenantId } },
    });
    if (!user) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'User not found in this clinic',
      });
    }

    const existing = await this.staff.findOne({
      where: { user: { id: dto.userId }, tenant: { id: tenantId } },
    });
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This user already has a staff profile',
      });
    }

    const profile = this.staff.create({
      tenant: { id: tenantId } as Tenant,
      user: { id: dto.userId } as User,
      title: dto.title,
      bio: dto.bio,
      avatar_url: dto.avatarUrl,
      booking_buffer_minutes: dto.bookingBufferMinutes ?? 0,
      is_available_for_booking: true,
    });
    const saved = await this.staff.save(profile);
    return this.findOne(tenantId, saved.id);
  }

  async findAll(tenantId: string, query: QueryStaffDto) {
    const where: Record<string, unknown> = { tenant: { id: tenantId } };

    if (query.search) where.title = ILike(`%${query.search}%`);
    if (query.isAvailable !== undefined) {
      where.is_available_for_booking = query.isAvailable === 'true';
    }

    // Branch filter resolves through the branch_users join.
    if (query.branchId) {
      const links = await this.branchUsers.find({
        where: { branch: { id: query.branchId }, tenant: { id: tenantId } },
        relations: { user: true },
      });
      const userIds = links.map((l) => l.user.id);
      if (userIds.length === 0) {
        return { data: [], total: 0, page: query.page, limit: query.limit };
      }
      where.user = { id: In(userIds) };
    }

    const [data, total] = await this.staff.findAndCount({
      where,
      relations: { user: true },
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  async findOne(tenantId: string, id: string): Promise<StaffProfile> {
    const profile = await this.staff.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: {
        user: true,
        staffServices: { service: true },
      },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found',
      });
    }
    return profile;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateStaffDto,
  ): Promise<StaffProfile> {
    const profile = await this.findOne(tenantId, id);

    if (dto.title !== undefined) profile.title = dto.title;
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.avatarUrl !== undefined) profile.avatar_url = dto.avatarUrl;
    if (dto.bookingBufferMinutes !== undefined) {
      profile.booking_buffer_minutes = dto.bookingBufferMinutes;
    }
    if (dto.isAvailableForBooking !== undefined) {
      profile.is_available_for_booking = dto.isAvailableForBooking;
    }

    await this.staff.save(profile);
    return this.findOne(tenantId, id);
  }

  /** Toggles bookability. `active=false` keeps the record but hides it from booking/availability. */
  async setAvailability(
    tenantId: string,
    id: string,
    active: boolean,
  ): Promise<StaffProfile> {
    const profile = await this.findOne(tenantId, id);
    profile.is_available_for_booking = active;
    await this.staff.save(profile);
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const profile = await this.findOne(tenantId, id);
    await this.staff.softRemove(profile);
  }

  // ─────────────────────────── Service mapping ───────────────────────────── //

  /**
   * Replaces the staff member's qualified services. The "qualification" check
   * is the business-rule hook: a service must belong to the clinic and be
   * active before it can be assigned (extend here for licence/skill checks).
   */
  async assignServices(
    tenantId: string,
    staffId: string,
    dto: AssignServicesDto,
  ): Promise<StaffProfile> {
    await this.findOne(tenantId, staffId); // tenant ownership

    await this.dataSource.transaction(async (manager) => {
      if (dto.serviceIds.length) {
        const found = await manager.getRepository(Service).find({
          where: {
            id: In(dto.serviceIds),
            tenant: { id: tenantId },
            is_active: true,
          },
        });
        if (found.length !== dto.serviceIds.length) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message:
              'One or more services were not found, are inactive, or belong to another clinic',
          });
        }
      }

      const repo = manager.getRepository(StaffServiceEntity);
      await repo.delete({ staff: { id: staffId } });

      if (dto.serviceIds.length) {
        await repo.save(
          dto.serviceIds.map((serviceId) =>
            repo.create({
              staff: { id: staffId } as StaffProfile,
              service: { id: serviceId } as Service,
              tenant: { id: tenantId } as Tenant,
            }),
          ),
        );
      }
    });

    return this.findOne(tenantId, staffId);
  }

  async listServices(tenantId: string, staffId: string) {
    await this.findOne(tenantId, staffId);
    return this.staffServices.find({
      where: { staff: { id: staffId }, tenant: { id: tenantId } },
      relations: { service: true },
      order: { created_at: 'ASC' },
    });
  }

  // ─────────────────────────── Branch assignment ─────────────────────────── //

  /** Replaces the staff member's branch assignments (via `branch_users`). */
  async assignBranches(
    tenantId: string,
    staffId: string,
    dto: AssignBranchesDto,
  ): Promise<BranchUser[]> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
    const userId = profile.user.id;

    if (
      dto.primaryBranchId &&
      !dto.branchIds.includes(dto.primaryBranchId)
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'primaryBranchId must be one of branchIds',
      });
    }

    await this.dataSource.transaction(async (manager) => {
      if (dto.branchIds.length) {
        const found = await manager.getRepository(Branch).find({
          where: { id: In(dto.branchIds), tenant: { id: tenantId } },
        });
        if (found.length !== dto.branchIds.length) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: 'One or more branches were not found in this clinic',
          });
        }
      }

      const repo = manager.getRepository(BranchUser);
      await repo.delete({ user: { id: userId }, tenant: { id: tenantId } });

      if (dto.branchIds.length) {
        const primary = dto.primaryBranchId ?? dto.branchIds[0];
        await repo.save(
          dto.branchIds.map((branchId) =>
            repo.create({
              tenant: { id: tenantId } as Tenant,
              branch: { id: branchId } as Branch,
              user: { id: userId } as User,
              is_primary: branchId === primary,
            }),
          ),
        );
      }
    });

    return this.listBranches(tenantId, staffId);
  }

  async listBranches(tenantId: string, staffId: string): Promise<BranchUser[]> {
    const profile = await this.staff.findOne({
      where: { id: staffId, tenant: { id: tenantId } },
      relations: { user: true },
    });
    if (!profile) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff member not found' });
    }
    return this.branchUsers.find({
      where: { user: { id: profile.user.id }, tenant: { id: tenantId } },
      relations: { branch: true },
      order: { created_at: 'ASC' },
    });
  }
}
