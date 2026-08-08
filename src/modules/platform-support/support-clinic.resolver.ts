import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Resolves the `:tenantId` path parameter every Support diagnostic endpoint
 * carries into a real, live clinic — or 404s.
 *
 * WHY THIS EXISTS AS ITS OWN SERVICE. Platform Customer Service is
 * intentionally cross-tenant, which means the usual protection (an ambient
 * `TenantContextService.requireTenantId()` that a platform principal can never
 * satisfy) does not apply here. The replacement is that the target clinic is
 * ALWAYS explicit, ALWAYS validated in one place, and never inferred. Every
 * diagnostic service takes the resolved `tenantId` from here rather than
 * trusting the raw parameter, so a nonexistent or soft-deleted clinic can
 * never reach a query.
 *
 * This does NOT weaken tenant scoping anywhere else: `requireTenantId()` is
 * untouched, no tenant-scoped service gained an optional tenant, and no tenant
 * route admits a platform principal. The cross-tenant reach lives exclusively
 * in this module's dedicated controllers.
 */
@Injectable()
export class SupportClinicResolver {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  /**
   * Loads the clinic with only the columns any Support diagnostic could need.
   * Explicit `select` rather than a whole-entity load: the `tenants` row is
   * small today, but a future column (verification metadata, private financial
   * configuration) must not become visible to Support merely by existing.
   *
   * Soft-deleted clinics are excluded by TypeORM's default `deleted_at`
   * handling, so a deleted clinic reads as "not found" — correct: there is no
   * live system state left to diagnose.
   */
  async resolve(tenantId: string): Promise<SupportClinic> {
    const tenant = await this.tenants.findOne({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        contact_email: true,
        contact_phone: true,
        default_timezone: true,
        default_currency: true,
        approval_status: true,
        is_active: true,
        created_at: true,
      },
    });
    if (!tenant) {
      throw new AppError(ErrorCode.TENANT_NOT_FOUND, { message: 'Clinic not found' });
    }
    return tenant as SupportClinic;
  }

  /** Validates the clinic exists without materialising it (action endpoints). */
  async assertExists(tenantId: string): Promise<void> {
    const exists = await this.tenants.exists({ where: { id: tenantId } });
    if (!exists) {
      throw new AppError(ErrorCode.TENANT_NOT_FOUND, { message: 'Clinic not found' });
    }
  }
}

/** The exact `Tenant` subset `resolve()` guarantees — never the whole entity. */
export type SupportClinic = Pick<
  Tenant,
  | 'id'
  | 'name'
  | 'slug'
  | 'contact_email'
  | 'contact_phone'
  | 'default_timezone'
  | 'default_currency'
  | 'approval_status'
  | 'is_active'
  | 'created_at'
>;
