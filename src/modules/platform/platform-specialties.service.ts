import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from './platform-admin-audit.service';

/**
 * Marketplace BE-1 (T056) — contract C9. Platform-admin correction surface
 * for `tenant_specialties`/`staff_specialties`. NOT a public route (gated by
 * `RolesGuard` + `ROLE.SUPER_ADMIN` at the controller, same as
 * `SystemSettingController`). A console UI is explicitly out of scope
 * (research.md/spec.md) — API-only.
 *
 * Every write here is `provenance = 'ASSERTED'`. `MarketplaceSpecialtiesBackfill`
 * (T054) never overwrites an `ASSERTED` row on re-run — that is the whole
 * point of recording provenance — so an assertion made here survives
 * re-derivation by construction, not by a special case in either migration.
 */
@Injectable()
export class PlatformSpecialtiesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  async assertTenantSpecialty(
    tenantId: string,
    specialtyId: string,
  ): Promise<void> {
    await this.requireTenant(tenantId);
    await this.requireSpecialty(specialtyId);
    await this.dataSource.query(
      `INSERT INTO "tenant_specialties" ("tenantId", "specialtyId", "provenance")
       VALUES ($1, $2, 'ASSERTED'::tenant_specialty_provenance_enum)
       ON CONFLICT ("tenantId", "specialtyId")
       DO UPDATE SET "provenance" = 'ASSERTED'::tenant_specialty_provenance_enum,
                     "updated_at" = now()`,
      [tenantId, specialtyId],
    );
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SPECIALTY_TENANT_ASSERT,
      userId: this.actorId(),
      entityType: 'tenant_specialty',
      entityId: `${tenantId}:${specialtyId}`,
      tenantId,
      after: { tenantId, specialtyId, provenance: 'ASSERTED' },
    });
  }

  async removeTenantSpecialty(
    tenantId: string,
    specialtyId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "tenant_specialties" WHERE "tenantId" = $1 AND "specialtyId" = $2`,
      [tenantId, specialtyId],
    );
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SPECIALTY_TENANT_REMOVE,
      userId: this.actorId(),
      entityType: 'tenant_specialty',
      entityId: `${tenantId}:${specialtyId}`,
      tenantId,
      before: { tenantId, specialtyId },
    });
  }

  async assertStaffSpecialty(
    staffId: string,
    specialtyId: string,
  ): Promise<void> {
    const tenantId = await this.requireStaff(staffId);
    await this.requireSpecialty(specialtyId);
    await this.dataSource.query(
      `INSERT INTO "staff_specialties" ("staffId", "specialtyId", "tenantId", "provenance")
       VALUES ($1, $2, $3, 'ASSERTED'::staff_specialty_provenance_enum)
       ON CONFLICT ("staffId", "specialtyId")
       DO UPDATE SET "provenance" = 'ASSERTED'::staff_specialty_provenance_enum,
                     "updated_at" = now()`,
      [staffId, specialtyId, tenantId],
    );
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SPECIALTY_STAFF_ASSERT,
      userId: this.actorId(),
      entityType: 'staff_specialty',
      entityId: `${staffId}:${specialtyId}`,
      tenantId,
      after: { staffId, specialtyId, provenance: 'ASSERTED' },
    });
  }

  async removeStaffSpecialty(
    staffId: string,
    specialtyId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "staff_specialties" WHERE "staffId" = $1 AND "specialtyId" = $2`,
      [staffId, specialtyId],
    );
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SPECIALTY_STAFF_REMOVE,
      userId: this.actorId(),
      entityType: 'staff_specialty',
      entityId: `${staffId}:${specialtyId}`,
      before: { staffId, specialtyId },
    });
  }

  private async requireTenant(tenantId: string): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM "tenants" WHERE id = $1 AND deleted_at IS NULL`,
      [tenantId],
    );
    if (!rows[0]) throw new NotFoundException('Tenant not found');
  }

  private async requireSpecialty(specialtyId: string): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM "specialties" WHERE id = $1`,
      [specialtyId],
    );
    if (!rows[0]) throw new NotFoundException('Specialty not found');
  }

  /** Returns the staff member's tenant id, or throws. */
  private async requireStaff(staffId: string): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT "tenantId" FROM "staff_profiles" WHERE id = $1 AND deleted_at IS NULL`,
      [staffId],
    );
    if (!rows[0]) throw new NotFoundException('Staff member not found');
    return rows[0].tenantId as string;
  }

  /** The acting super admin, when this call has an HTTP caller (ALS-scoped). */
  private actorId(): string | undefined {
    return this.tenantContext.getUser()?.id;
  }
}
