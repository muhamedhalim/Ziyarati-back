import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { DataSource, ILike, In, Not, Repository } from 'typeorm';

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
import { EligibleUsersQueryDto } from './dto/eligible-users-query.dto';
import { CreateStaffWithNewUserDto } from './dto/create-staff-with-new-user.dto';

import { AuthService } from '../auth/auth.service';
import { ASSIGNABLE_STAFF_ROLES } from '../auth/dto/register-user.dto';
import { UsageService } from '../subscription-billing/usage.service';
import { COUNT_LIMIT } from '../subscription-billing/usage-metric';
import { ROLE } from '../../rbac/rbac.constants';

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
    private readonly authService: AuthService,
    private readonly usage: UsageService,
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
      is_available_for_booking: dto.isAvailableForBooking ?? true,
    });
    const saved = await this.staff.save(profile);
    return this.findOne(tenantId, saved.id);
  }

  /**
   * "Create new staff user" — the Add Staff Member path that provisions the
   * User account AND the StaffProfile together, atomically. Reuses
   * `AuthService.createUserWithRole` for the account/role half so the exact
   * same hashing, role-assignment and tenant-scoping logic that
   * `POST /auth/register-user` uses applies here too — no duplicated
   * business logic.
   *
   * The temporary password is generated server-side and returned ONCE in the
   * response; it is never stored in plaintext and can't be retrieved again
   * (mirrors how every other credential in this codebase is handled — see
   * AuthService.validateCredentials).
   */
  async createWithNewUser(
    tenantId: string,
    dto: CreateStaffWithNewUserDto,
  ): Promise<{ profile: StaffProfile; temporaryPassword: string }> {
    const roleSlug = dto.roleSlug ?? ROLE.RECEPTIONIST;
    if (!ASSIGNABLE_STAFF_ROLES.includes(roleSlug)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: `Role "${roleSlug}" cannot be assigned to staff`,
      });
    }

    if (
      dto.primaryBranchId &&
      !(dto.branchIds ?? []).includes(dto.primaryBranchId)
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'primaryBranchId must be one of branchIds',
      });
    }

    const email = dto.email.trim().toLowerCase();
    const existing = await this.users.findOne({
      where: { email, tenant: { id: tenantId } },
    });
    if (existing) {
      throw new AppError(ErrorCode.EMAIL_ALREADY_EXISTS);
    }

    // Plan limit: max_users — same rule POST /auth/register-user enforces.
    const currentUsers = await this.users.count({
      where: { tenant: { id: tenantId } },
    });
    await this.usage.assertCountWithinLimit(
      tenantId,
      COUNT_LIMIT.USERS,
      currentUsers,
    );

    const temporaryPassword = randomBytes(9).toString('base64url'); // 12 chars

    const profileId = await this.dataSource.transaction(async (manager) => {
      const user = await this.authService.createUserWithRole(
        manager,
        {
          email,
          password: temporaryPassword,
          fullName: dto.fullName,
          phone: dto.phone,
        },
        roleSlug,
        tenantId,
      );

      const profile = await manager.save(
        manager.getRepository(StaffProfile).create({
          tenant: { id: tenantId } as Tenant,
          user: { id: user.id } as User,
          title: dto.title,
          bio: dto.bio,
          avatar_url: dto.avatarUrl,
          booking_buffer_minutes: dto.bookingBufferMinutes ?? 0,
          is_available_for_booking: dto.isAvailableForBooking ?? true,
        }),
      );

      if (dto.branchIds?.length) {
        const found = await manager.getRepository(Branch).find({
          where: { id: In(dto.branchIds), tenant: { id: tenantId } },
        });
        if (found.length !== dto.branchIds.length) {
          throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
            message: 'One or more branches were not found in this clinic',
          });
        }

        const primary = dto.primaryBranchId ?? dto.branchIds[0];
        await manager.getRepository(BranchUser).save(
          dto.branchIds.map((branchId) =>
            manager.getRepository(BranchUser).create({
              tenant: { id: tenantId } as Tenant,
              branch: { id: branchId } as Branch,
              user: { id: user.id } as User,
              is_primary: branchId === primary,
            }),
          ),
        );
      }

      return profile.id;
    });

    return {
      profile: await this.findOne(tenantId, profileId),
      temporaryPassword,
    };
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

  /**
   * Users this tenant can turn into staff via "Link existing user": active,
   * belong to the tenant, and don't already have a (non-deleted) staff
   * profile. Two plain queries rather than a NOT EXISTS/anti-join — simple,
   * fully typed, and staff/user counts per clinic are small enough that this
   * never becomes a bottleneck.
   */
  async findEligibleUsers(tenantId: string, query: EligibleUsersQueryDto) {
    const linked = await this.staff.find({
      where: { tenant: { id: tenantId } },
      relations: { user: true },
      select: { id: true, user: { id: true } },
    });
    const linkedIds = linked.map((sp) => sp.user.id);

    const base: Record<string, unknown> = {
      tenant: { id: tenantId },
      is_active: true,
      ...(linkedIds.length ? { id: Not(In(linkedIds)) } : {}),
    };

    const where = query.search
      ? [
          { ...base, full_name: ILike(`%${query.search}%`) },
          { ...base, email: ILike(`%${query.search}%`) },
        ]
      : base;

    const [data, total] = await this.users.findAndCount({
      where,
      relations: { userRoles: { role: true } },
      order: { full_name: 'ASC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return {
      data: data.map((user) => ({
        id: user.id,
        fullName: user.full_name ?? null,
        email: user.email ?? null,
        role: user.userRoles?.[0]?.role
          ? { slug: user.userRoles[0].role.slug, name: user.userRoles[0].role.name }
          : null,
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
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
