import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '../../common/errors';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';
import { OverrideStatus } from './platform-billing.constants';

export interface FreeAccessOverride {
  id: string;
  tenant_id: string;
  granted_by: string | null;
  reason: string | null;
  starts_at: Date;
  ends_at: Date | null; // null = unlimited
  status: OverrideStatus;
  created_at: Date;
  updated_at: Date | null;
}

export interface GrantOverrideInput {
  grantedBy?: string;
  reason?: string;
  /** Duration in days from now. Omit (or null) for an UNLIMITED override. */
  durationDays?: number | null;
}

/**
 * Free-access overrides (`free_access_overrides`).
 *
 * A super-admin grant that gives a tenant free access regardless of paid
 * subscription state — used for special access, comps, partnerships, or
 * support remediation. An ACTIVE, time-valid override OUTRANKS the paid
 * subscription check (see AccessControlService priority).
 *
 * Backed by a bootstrapped table (PlatformBillingBootstrap) and accessed via
 * raw SQL — it carries no TypeORM entity, mirroring `settlement_adjustments`
 * (keeps it out of dev `synchronize` and migrations-first prod alike).
 *
 * Invariant: at most ONE active override per tenant at a time. Grant rejects a
 * duplicate (409) — use extend/revoke to manage the existing one.
 */
@Injectable()
export class FreeAccessOverrideService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: PlatformAdminAuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** True when the tenant currently has an ACTIVE, time-valid override. */
  async hasActive(tenantId: string, manager?: EntityManager): Promise<boolean> {
    return (await this.getActive(tenantId, manager)) !== null;
  }

  /**
   * The tenant's current ACTIVE, time-valid override (or null).
   *
   * FND-047: reached from `AccessControlService.isEnforced`, which may already
   * be running inside a caller's open `dataSource.transaction()` (via
   * `UsageService.incrementIfWithinLimit`). Pass that manager through so this
   * raw query reuses the transaction's own connection instead of borrowing a
   * second one from the pool — under enough concurrency to hold every pool
   * connection open in a transaction, that second borrow can never resolve.
   */
  async getActive(tenantId: string, manager?: EntityManager): Promise<FreeAccessOverride | null> {
    const runner = manager ?? this.dataSource;
    const rows = await runner.query(
      `SELECT * FROM free_access_overrides
       WHERE tenant_id = $1
         AND status = 'ACTIVE'
         AND starts_at <= now()
         AND (ends_at IS NULL OR ends_at > now())
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  /** Full override history for a tenant (newest first). */
  async listForTenant(tenantId: string): Promise<FreeAccessOverride[]> {
    const rows = await this.dataSource.query(
      `SELECT * FROM free_access_overrides
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows.map((r: Record<string, unknown>) => this.map(r));
  }

  /** Grant a fresh override. 409 if one is already active. */
  async grant(
    tenantId: string,
    input: GrantOverrideInput,
  ): Promise<FreeAccessOverride> {
    if (await this.hasActive(tenantId)) {
      // FND-015 / AD-14: refusals are recorded too — a duplicate-grant attempt
      // on a tenant that already has free access is worth a support/incident
      // record even though it changes nothing.
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.OVERRIDE_GRANT_REJECTED,
        userId: this.actorId(),
        entityType: 'free_access_override',
        tenantId,
        before: null,
        after: { attemptedReason: input.reason ?? null, result: 'rejected: override already active' },
      });
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'This tenant already has an active free-access override — extend or revoke it instead',
      });
    }
    const endsAt = this.endsFromDuration(input.durationDays, new Date());
    const rows = await this.dataSource.query(
      `INSERT INTO free_access_overrides
         (id, tenant_id, granted_by, reason, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, now(), $5, 'ACTIVE')
       RETURNING *`,
      [randomUUID(), tenantId, input.grantedBy ?? null, input.reason ?? null, endsAt],
    );
    const result = this.map(rows[0]);
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.OVERRIDE_GRANT,
      userId: this.actorId(),
      entityType: 'free_access_override',
      entityId: result.id,
      tenantId,
      before: null,
      after: { reason: result.reason, endsAt: result.ends_at },
    });
    return result;
  }

  /**
   * Extend (or make unlimited) the tenant's active override. `durationDays`
   * extends from the later of the current end and now; null/omitted = unlimited.
   * 404 if there is no active override.
   */
  async extend(
    tenantId: string,
    durationDays?: number | null,
  ): Promise<FreeAccessOverride> {
    const active = await this.getActive(tenantId);
    if (!active) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active free-access override to extend',
      });
    }
    let endsAt: Date | null;
    if (durationDays == null) {
      endsAt = null; // unlimited
    } else {
      const base =
        active.ends_at && active.ends_at > new Date() ? active.ends_at : new Date();
      endsAt = this.endsFromDuration(durationDays, base);
    }
    const rows = await this.dataSource.query(
      `UPDATE free_access_overrides
       SET ends_at = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [active.id, endsAt],
    );
    const result = this.map(rows[0]);
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.OVERRIDE_EXTEND,
      userId: this.actorId(),
      entityType: 'free_access_override',
      entityId: result.id,
      tenantId,
      before: { endsAt: active.ends_at },
      after: { endsAt: result.ends_at },
    });
    return result;
  }

  /** Revoke the tenant's active override immediately. 404 if none active. */
  async revoke(tenantId: string): Promise<{ revoked: boolean }> {
    const res = await this.dataSource.query(
      `UPDATE free_access_overrides
       SET status = 'REVOKED', updated_at = now()
       WHERE tenant_id = $1 AND status = 'ACTIVE'
       RETURNING id`,
      [tenantId],
    );
    // node-postgres UPDATE returns [ rows, affectedCount ] via TypeORM's raw driver.
    const rows = Array.isArray(res) ? (res[0] as Array<{ id: string }>) : [];
    const affected = Array.isArray(res) ? res[1] : (res as { rowCount?: number })?.rowCount;
    if (!affected) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active free-access override to revoke',
      });
    }
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.OVERRIDE_REVOKE,
      userId: this.actorId(),
      entityType: 'free_access_override',
      entityId: rows[0]?.id,
      tenantId,
      before: { status: 'ACTIVE' },
      after: { status: 'REVOKED' },
    });
    return { revoked: true };
  }

  private actorId(): string | undefined {
    return this.tenantContext.getUser()?.id;
  }

  private endsFromDuration(
    durationDays: number | null | undefined,
    from: Date,
  ): Date | null {
    if (durationDays == null) return null; // unlimited
    const end = new Date(from);
    end.setUTCDate(end.getUTCDate() + durationDays);
    return end;
  }

  private map(row: Record<string, unknown>): FreeAccessOverride {
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      granted_by: (row.granted_by as string) ?? null,
      reason: (row.reason as string) ?? null,
      starts_at: new Date(row.starts_at as string),
      ends_at: row.ends_at ? new Date(row.ends_at as string) : null,
      status: row.status as OverrideStatus,
      created_at: new Date(row.created_at as string),
      updated_at: row.updated_at ? new Date(row.updated_at as string) : null,
    };
  }
}
