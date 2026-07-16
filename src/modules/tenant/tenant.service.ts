import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, ILike, Repository } from 'typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantApprovalEvent } from '../../entities/SaaS-Core/TenantApprovalEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { TenantApprovalStatus } from '../../entities/enums';

import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants.query.dto';
import { UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto';
import { AppError, ErrorCode } from '../../common/errors';

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Aggregate-root service for the Tenant (clinic). Owns the tenant profile, its
 * settings (1:1), and the approval lifecycle (with an audit event per action).
 *
 * Tenant isolation is enforced by the CALLERS (controllers): platform endpoints
 * are restricted to super-admins; self-service endpoints always pass the
 * principal's own tenantId. This service never trusts a tenant id from a body.
 */
@Injectable()
export class TenantService {
  constructor(
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    @InjectRepository(TenantSetting)
    private readonly settings: Repository<TenantSetting>,
    @InjectRepository(TenantApprovalEvent)
    private readonly approvalEvents: Repository<TenantApprovalEvent>,
    private readonly dataSource: DataSource,
  ) {}

  // ----------------------------------------------------------------------- //
  // CRUD
  // ----------------------------------------------------------------------- //

  /**
   * Platform-admin tenant provisioning. Creates the tenant + a default settings
   * row atomically. (Self-service onboarding uses /auth/register-owner.)
   */
  async create(dto: CreateTenantDto, actorId: string): Promise<Tenant> {
    await this.assertSlugAvailable(dto.slug);
    await this.assertContactEmailAvailable(dto.contactEmail);

    return this.dataSource.transaction(async (manager) => {
      const tenant = await manager.save(
        manager.create(Tenant, {
          name: dto.name,
          slug: dto.slug,
          commercial_registration_number: dto.commercialRegistrationNumber,
          contact_email: dto.contactEmail,
          contact_phone: dto.contactPhone,
          legal_name: dto.legalName,
          logo_url: dto.logoUrl,
          country_id: dto.countryId,
          default_currency: dto.defaultCurrency ?? 'USD',
          default_timezone: dto.defaultTimezone ?? 'UTC',
        }),
      );

      await manager.save(manager.create(TenantSetting, { tenant }));
      await manager.save(
        manager.create(TenantApprovalEvent, {
          tenant,
          action: 'CREATED',
          acted_by: actorId,
        }),
      );
      return tenant;
    });
  }

  /** Platform-admin listing with status filter, search and pagination. */
  async findAll(query: ListTenantsQueryDto): Promise<Paginated<Tenant>> {
    const base: FindOptionsWhere<Tenant> = query.status
      ? { approval_status: query.status }
      : {};
    const where: FindOptionsWhere<Tenant>[] = [];

    if (query.search) {
      where.push({ ...base, name: ILike(`%${query.search}%`) });
      where.push({ ...base, slug: ILike(`%${query.search}%`) });
    }

    const [data, total] = await this.tenants.findAndCount({
      where: where.length ? where : base,
      order: { created_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /** Loads a tenant by id or throws. */
  async findById(id: string): Promise<Tenant> {
    const tenant = await this.tenants.findOne({
      where: { id },
      relations: { settings: true },
    });
    if (!tenant) {
      throw new AppError(ErrorCode.TENANT_NOT_FOUND);
    }
    return tenant;
  }

  async updateProfile(id: string, dto: UpdateTenantDto): Promise<Tenant> {
    const tenant = await this.findById(id);

    if (dto.contactEmail && dto.contactEmail !== tenant.contact_email) {
      await this.assertContactEmailAvailable(dto.contactEmail);
    }

    Object.assign(tenant, {
      name: dto.name ?? tenant.name,
      legal_name: dto.legalName ?? tenant.legal_name,
      logo_url: dto.logoUrl ?? tenant.logo_url,
      contact_email: dto.contactEmail ?? tenant.contact_email,
      contact_phone: dto.contactPhone ?? tenant.contact_phone,
      country_id: dto.countryId ?? tenant.country_id,
      default_currency: dto.defaultCurrency ?? tenant.default_currency,
      default_timezone: dto.defaultTimezone ?? tenant.default_timezone,
      commercial_registration_number:
        dto.commercialRegistrationNumber ??
        tenant.commercial_registration_number,
    });

    return this.tenants.save(tenant);
  }

  // ----------------------------------------------------------------------- //
  // Approval lifecycle (super-admin) — each transition is audited
  // ----------------------------------------------------------------------- //

  approve(id: string, actorId: string, reason?: string): Promise<Tenant> {
    return this.transition(id, {
      status: TenantApprovalStatus.APPROVED,
      isActive: true,
      action: 'APPROVED',
      actorId,
      reason,
    });
  }

  reject(id: string, actorId: string, reason?: string): Promise<Tenant> {
    return this.transition(id, {
      status: TenantApprovalStatus.REJECTED,
      isActive: false,
      action: 'REJECTED',
      actorId,
      reason,
    });
  }

  suspend(id: string, actorId: string, reason?: string): Promise<Tenant> {
    return this.transition(id, {
      status: TenantApprovalStatus.SUSPENDED,
      isActive: false,
      action: 'SUSPENDED',
      actorId,
      reason,
    });
  }

  /**
   * Transitions a tenant from PENDING_VERIFICATION to PENDING_APPROVAL.
   * Called automatically by TenantVerificationService when all submitted
   * documents for the tenant have been reviewed (approved or rejected).
   * The admin can then take the final approve/reject action.
   */
  markPendingApproval(id: string, actorId: string): Promise<Tenant> {
    return this.transition(id, {
      status: TenantApprovalStatus.PENDING_APPROVAL,
      isActive: false,
      action: 'PENDING_APPROVAL',
      actorId,
    });
  }

  async getApprovalEvents(id: string): Promise<TenantApprovalEvent[]> {
    await this.findById(id); // existence + (caller-enforced) scope
    return this.approvalEvents.find({
      where: { tenant: { id } },
      order: { created_at: 'DESC' },
    });
  }

  // ----------------------------------------------------------------------- //
  // Settings (1:1) — lazily created so legacy tenants still work
  // ----------------------------------------------------------------------- //

  async getSettings(tenantId: string): Promise<TenantSetting> {
    let settings = await this.settings.findOne({
      where: { tenant: { id: tenantId } },
    });
    if (!settings) {
      await this.findById(tenantId); // ensure the tenant exists
      settings = await this.settings.save(
        this.settings.create({ tenant: { id: tenantId } as Tenant }),
      );
    }
    return settings;
  }

  async updateSettings(
    tenantId: string,
    dto: UpdateTenantSettingsDto,
  ): Promise<TenantSetting> {
    const settings = await this.getSettings(tenantId);
    Object.assign(settings, {
      booking_confirmation:
        dto.bookingConfirmation ?? settings.booking_confirmation,
      payment_required: dto.paymentRequired ?? settings.payment_required,
      cancellation_hours: dto.cancellationHours ?? settings.cancellation_hours,
      feedback_delay_minutes:
        dto.feedbackDelayMinutes ?? settings.feedback_delay_minutes,
      default_language: dto.defaultLanguage ?? settings.default_language,
      currency: dto.currency ?? settings.currency,
      bot_enabled: dto.botEnabled ?? settings.bot_enabled,
      updated_at: new Date(),
    });
    return this.settings.save(settings);
  }

  // ----------------------------------------------------------------------- //
  // Internals
  // ----------------------------------------------------------------------- //

  private async transition(
    id: string,
    opts: {
      status: TenantApprovalStatus;
      isActive: boolean;
      action: string;
      actorId: string;
      reason?: string;
    },
  ): Promise<Tenant> {
    // Allowed approval-status transitions (current → permitted next states).
    const ALLOWED: Record<TenantApprovalStatus, TenantApprovalStatus[]> = {
      [TenantApprovalStatus.PENDING_VERIFICATION]: [
        TenantApprovalStatus.PENDING_APPROVAL,
        TenantApprovalStatus.APPROVED,
        TenantApprovalStatus.REJECTED,
      ],
      [TenantApprovalStatus.PENDING_APPROVAL]: [TenantApprovalStatus.APPROVED, TenantApprovalStatus.REJECTED],
      [TenantApprovalStatus.APPROVED]: [TenantApprovalStatus.SUSPENDED],
      [TenantApprovalStatus.REJECTED]: [TenantApprovalStatus.APPROVED],
      [TenantApprovalStatus.SUSPENDED]: [TenantApprovalStatus.APPROVED],
    };

    return this.dataSource.transaction(async (manager) => {
      const tenant = await manager.findOne(Tenant, { where: { id } });
      if (!tenant) {
        throw new AppError(ErrorCode.TENANT_NOT_FOUND);
      }

      if (!ALLOWED[tenant.approval_status]?.includes(opts.status)) {
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message: `Invalid transition: ${tenant.approval_status} → ${opts.status}`,
        });
      }

      tenant.approval_status = opts.status;
      tenant.is_active = opts.isActive;
      await manager.save(tenant);

      // Auto-provision a default branch the first time a tenant becomes
      // APPROVED — no manual action required from the clinic owner. Guarded by
      // a count check (not just "on first approval") because APPROVED is
      // reachable multiple times per tenant (e.g. re-approval after
      // SUSPENDED), so this must stay idempotent rather than assume a single
      // approval event per tenant.
      if (opts.status === TenantApprovalStatus.APPROVED) {
        const existingBranches = await manager.count(Branch, {
          where: { tenant: { id: tenant.id } },
        });
        if (existingBranches === 0) {
          await manager.save(
            manager.create(Branch, {
              tenant,
              name: 'Main Branch',
              timezone: tenant.default_timezone || 'UTC',
              is_active: true,
            }),
          );
        }
      }

      await manager.save(
        manager.create(TenantApprovalEvent, {
          tenant,
          action: opts.action,
          reason: opts.reason,
          acted_by: opts.actorId,
        }),
      );
      return tenant;
    });
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const exists = await this.tenants.findOne({ where: { slug } });
    if (exists) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'A clinic with this slug already exists',
      });
    }
  }

  private async assertContactEmailAvailable(email: string): Promise<void> {
    const exists = await this.tenants.findOne({
      where: { contact_email: email },
    });
    if (exists) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This contact email is already in use',
      });
    }
  }
}
