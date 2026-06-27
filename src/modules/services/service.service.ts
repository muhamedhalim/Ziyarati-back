import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  ILike,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';

import { Service, PricingType } from '../../entities/Services/Service';
import { ServiceCategory } from '../../entities/Services/ServiceCategory';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppointmentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { QueryServicesDto } from './dto/query-services.dto';
import { LookupServicesDto } from './dto/lookup-services.dto';
import { AvailableServicesDto } from './dto/available-services.dto';
import { ServiceCategoryService } from './service-category.service';

/** Aggregate catalog counts for dashboards (avoids paginated list queries). */
export interface ServiceStats {
  total: number;
  active: number;
  inactive: number;
  categories: number;
}

/** Terminal appointment states — a service in only these is safe to delete. */
const TERMINAL_APPOINTMENT_STATUSES = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

/**
 * Compact projection returned by the lookup endpoint (selectors / dropdowns).
 * Derived from the entity so the types never drift. NOTE: like everywhere in the
 * codebase, the decimal `base_price` is serialised as a string at runtime.
 */
export type ServiceLookupItem = Pick<
  Service,
  'id' | 'name' | 'duration_minutes' | 'base_price'
>;

/**
 * Services — the central catalog of bookable offerings, and the single source of
 * truth consumed (read-only) by Appointments (price/duration snapshot) and Staff
 * (qualified-service assignment).
 *
 * Tenant isolation: every query filters `where: { tenant: { id: tenantId } }` and
 * the tenant always comes from TenantContext (never from input). Soft delete via
 * `deleted_at` — soft-deleting preserves historical `appointment_services`
 * snapshots and is therefore safe for past appointments. `name` is unique per
 * (non-deleted) tenant.
 *
 * DTO casing follows the project-wide convention: camelCase request fields are
 * mapped here to the entity's snake_case columns.
 */
@Injectable()
export class ServiceService {
  constructor(
    @InjectRepository(Service)
    private readonly services: Repository<Service>,
    @InjectRepository(AppointmentServiceEntity)
    private readonly appointmentServices: Repository<AppointmentServiceEntity>,
    @InjectRepository(StaffServiceEntity)
    private readonly staffServices: Repository<StaffServiceEntity>,
    private readonly categoriesSvc: ServiceCategoryService,
  ) {}

  async create(tenantId: string, dto: CreateServiceDto): Promise<Service> {
    await this.assertNameUnique(tenantId, dto.name);
    if (dto.categoryId) await this.assertCategoryUsable(tenantId, dto.categoryId);

    const service = this.services.create({
      tenant: { id: tenantId } as Tenant,
      category: dto.categoryId ? ({ id: dto.categoryId } as ServiceCategory) : undefined,
      name: dto.name,
      description: dto.description,
      duration_minutes: dto.durationMinutes,
      pricing_type: dto.pricingType ?? PricingType.FIXED,
      base_price: dto.basePrice,
      is_active: dto.isActive ?? true,
    });
    const saved = await this.services.save(service);
    return this.findOneOrThrow(tenantId, saved.id);
  }

  async update(tenantId: string, id: string, dto: UpdateServiceDto): Promise<Service> {
    const service = await this.findOneOrThrow(tenantId, id);

    if (dto.name && dto.name !== service.name) {
      await this.assertNameUnique(tenantId, dto.name, id);
      service.name = dto.name;
    }
    if (dto.categoryId !== undefined) {
      if (dto.categoryId) {
        await this.assertCategoryUsable(tenantId, dto.categoryId);
        service.category = { id: dto.categoryId } as ServiceCategory;
      } else {
        service.category = undefined;
      }
    }
    if (dto.description !== undefined) service.description = dto.description;
    if (dto.durationMinutes !== undefined) service.duration_minutes = dto.durationMinutes;
    if (dto.pricingType !== undefined) service.pricing_type = dto.pricingType;
    if (dto.basePrice !== undefined) service.base_price = dto.basePrice;
    if (dto.isActive !== undefined) service.is_active = dto.isActive;

    await this.services.save(service);
    return this.findOneOrThrow(tenantId, id);
  }

  /**
   * Soft-deletes a service, but ONLY when it is safe to retire:
   *  - no upcoming (future, non-terminal) appointments reference it, and
   *  - no staff member is still assigned to it.
   * Otherwise rejects with 409 and steers the caller to deactivate instead — the
   * normal lifecycle operation. Mirrors the category "owns services" guard.
   */
  async remove(tenantId: string, id: string): Promise<{ id: string; deleted: boolean }> {
    await this.findOneOrThrow(tenantId, id);

    const upcoming = await this.appointmentServices.count({
      where: {
        tenant: { id: tenantId },
        service: { id },
        appointment: {
          start_at: MoreThanOrEqual(new Date()),
          status: Not(In(TERMINAL_APPOINTMENT_STATUSES)),
        },
      },
    });
    if (upcoming > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Cannot delete a service with upcoming appointments. Deactivate it instead so it stays bookable history.',
        context: { upcomingAppointments: upcoming },
      });
    }

    const assigned = await this.staffServices.count({
      where: { tenant: { id: tenantId }, service: { id } },
    });
    if (assigned > 0) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Cannot delete a service that is still assigned to staff. Unassign it from all staff (or deactivate it) first.',
        context: { staffAssignments: assigned },
      });
    }

    await this.services.softDelete(id);
    return { id, deleted: true };
  }

  async setActive(tenantId: string, id: string, active: boolean): Promise<Service> {
    const service = await this.findOneOrThrow(tenantId, id);
    service.is_active = active;
    await this.services.save(service);
    return this.findOneOrThrow(tenantId, id);
  }

  async list(tenantId: string, query: QueryServicesDto) {
    const where: FindOptionsWhere<Service> = { tenant: { id: tenantId } };
    if (query.isActive !== undefined) where.is_active = query.isActive;
    if (query.categoryId) where.category = { id: query.categoryId };
    if (query.search) where.name = ILike(`%${query.search}%`);

    const duration = this.range(query.minDuration, query.maxDuration);
    if (duration) where.duration_minutes = duration;

    const price = this.range(query.minPrice, query.maxPrice);
    if (price) where.base_price = price;

    const [data, total] = await this.services.findAndCount({
      where,
      relations: { category: true },
      order: { [query.sortBy]: query.sortOrder },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Compact, active-only projection for service selectors (Appointments, Staff
   * assignment, and any future booking UI). Not paginated; capped via `limit`.
   */
  async lookup(tenantId: string, dto: LookupServicesDto): Promise<ServiceLookupItem[]> {
    const where: FindOptionsWhere<Service> = {
      tenant: { id: tenantId },
      is_active: true,
    };
    if (dto.search) where.name = ILike(`%${dto.search}%`);

    return this.services.find({
      where,
      select: { id: true, name: true, duration_minutes: true, base_price: true },
      order: { name: 'ASC' },
      take: dto.limit,
    });
  }

  /**
   * Booking-availability selector: active services, optionally narrowed to those
   * a given staff member can perform (`staff_services`) and/or a category. The
   * preferred selector for Appointment / AI / WhatsApp booking flows.
   */
  async available(tenantId: string, dto: AvailableServicesDto): Promise<ServiceLookupItem[]> {
    const where: FindOptionsWhere<Service> = {
      tenant: { id: tenantId },
      is_active: true,
    };
    if (dto.categoryId) where.category = { id: dto.categoryId };
    if (dto.search) where.name = ILike(`%${dto.search}%`);

    if (dto.staffId) {
      const assigned = await this.staffServices.find({
        where: { tenant: { id: tenantId }, staff: { id: dto.staffId } },
        relations: { service: true },
      });
      const ids = assigned.map((a) => a.service.id);
      if (ids.length === 0) return [];
      where.id = In(ids);
    }

    return this.services.find({
      where,
      select: { id: true, name: true, duration_minutes: true, base_price: true },
      order: { name: 'ASC' },
      take: dto.limit,
    });
  }

  /** Aggregate counts for dashboards — total / active / inactive / categories. */
  async stats(tenantId: string): Promise<ServiceStats> {
    const [total, active, categories] = await Promise.all([
      this.services.count({ where: { tenant: { id: tenantId } } }),
      this.services.count({ where: { tenant: { id: tenantId }, is_active: true } }),
      this.categoriesSvc.count(tenantId),
    ]);
    return { total, active, inactive: total - active, categories };
  }

  /** Detail view including the owning category. */
  async getDetails(tenantId: string, id: string): Promise<Service> {
    return this.findOneOrThrow(tenantId, id);
  }

  /** Bare ownership/existence check (includes the owning category). */
  async findOneOrThrow(tenantId: string, id: string): Promise<Service> {
    const service = await this.services.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { category: true },
    });
    if (!service) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Service not found' });
    }
    return service;
  }

  /** Builds a Between / >= / <= operator from an optional min and max. */
  private range(min?: number, max?: number) {
    if (min !== undefined && max !== undefined) return Between(min, max);
    if (min !== undefined) return MoreThanOrEqual(min);
    if (max !== undefined) return LessThanOrEqual(max);
    return undefined;
  }

  private async assertNameUnique(
    tenantId: string,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.services.findOne({
      where: { tenant: { id: tenantId }, name },
    });
    if (existing && existing.id !== excludeId) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A service with this name already exists',
      });
    }
  }

  /** The category must exist in this tenant AND be active. */
  private async assertCategoryUsable(tenantId: string, categoryId: string): Promise<void> {
    const category = await this.categoriesSvc.findOneOrThrow(tenantId, categoryId);
    if (!category.is_active) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'The selected service category is inactive',
      });
    }
  }
}
