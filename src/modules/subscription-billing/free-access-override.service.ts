import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '../../common/errors';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import {
  PlatformAdminAuditService,
  PLATFORM_ADMIN_AUDIT_ACTION,
} from '../platform/platform-admin-audit.service';
import {
  FREE_ACCESS_MAX_DURATION_DAYS,
  FREE_ACCESS_MIN_DURATION_DAYS,
  OverrideStatus,
} from './platform-billing.constants';
import { AccessCacheService } from './access-cache.service';

/**
 * Advisory-lock namespace for free-access mutations, so the per-tenant key
 * below cannot collide with any other advisory lock the application takes
 * (`run-migrations-with-lock.ts` holds one during deploys).
 */
const FREE_ACCESS_LOCK_NAMESPACE = 0x7a74_0f61; // "zt" + "fa"

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
  /**
   * Whole days from now, bounded by
   * {@link FREE_ACCESS_MIN_DURATION_DAYS}..{@link FREE_ACCESS_MAX_DURATION_DAYS}.
   * Omit (or null) for an UNLIMITED override — the one way past those bounds,
   * and a deliberately separate choice rather than a very large number.
   *
   * This is the ONLY timing input the service accepts: both timestamps are
   * derived from the database's clock, so no caller — HTTP or in-process —
   * can supply, back-date or extend an expiry directly.
   */
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
    private readonly cache: AccessCacheService,
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
  async getActive(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<FreeAccessOverride | null> {
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

  /**
   * Grant a fresh override. 409 if one is already active.
   *
   * ATOMICITY. The duplicate check and the insert run in ONE transaction
   * behind a per-tenant advisory lock, because `hasActive()` followed by an
   * `INSERT` is a read-then-write race: two grants for the same clinic
   * arriving together (a double-clicked button, a retried request, two
   * operators) both observed "no active override" and both inserted, leaving
   * the tenant with two ACTIVE rows and the 409 contract quietly broken.
   *
   * WHY A LOCK AND NOT A UNIQUE INDEX. A partial unique index on
   * `(tenant_id) WHERE status = 'ACTIVE'` looks like the obvious fix and is
   * wrong: an EXPIRED override keeps `status = 'ACTIVE'` — only its `ends_at`
   * has passed — so such an index would permanently refuse a second grant to
   * any clinic that had ever been comped. The predicate that actually defines
   * "active" involves `now()`, which is not immutable and therefore cannot be
   * indexed at all. `pg_advisory_xact_lock` serializes the exact window
   * instead, needs no schema change, and releases automatically on commit or
   * rollback (so a failed transaction can never strand the lock).
   */
  async grant(
    tenantId: string,
    input: GrantOverrideInput,
  ): Promise<FreeAccessOverride> {
    const durationDays = this.assertDuration(input.durationDays);

    const result = await this.dataSource.transaction(async (manager) => {
      await this.lockTenant(tenantId, manager);
      if (await this.getActive(tenantId, manager)) return null;
      const rows = await manager.query(
        `INSERT INTO free_access_overrides
           (id, tenant_id, granted_by, reason, starts_at, ends_at, status)
         VALUES (
           $1, $2, $3, $4,
           now(),
           CASE WHEN $5::int IS NULL THEN NULL
                ELSE now() + make_interval(days => $5::int) END,
           'ACTIVE')
         RETURNING *`,
        [
          randomUUID(),
          tenantId,
          input.grantedBy ?? null,
          input.reason ?? null,
          durationDays,
        ],
      );
      return this.map(rows[0]);
    });

    if (!result) {
      // FND-015 / AD-14: refusals are recorded too — a duplicate-grant attempt
      // on a tenant that already has free access is worth a support/incident
      // record even though it changes nothing.
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.OVERRIDE_GRANT_REJECTED,
        userId: this.actorId(),
        entityType: 'free_access_override',
        tenantId,
        before: null,
        after: {
          attemptedReason: input.reason ?? null,
          result: 'rejected: override already active',
        },
      });
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'This tenant already has an active free-access override — extend or revoke it instead',
      });
    }
    // Tenant-wide grant — every capability's decision just changed.
    this.cache.invalidate(tenantId);
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
    const days = this.assertDuration(durationDays);

    // Same per-tenant lock as `grant`: read-then-write again, so two extends
    // landing together would otherwise both compute a new end from the SAME
    // old one and the later write would silently discard the earlier.
    const outcome = await this.dataSource.transaction(async (manager) => {
      await this.lockTenant(tenantId, manager);
      const active = await this.getActive(tenantId, manager);
      if (!active) return null;
      const rows = await manager.query(
        // `GREATEST(ends_at, now())` reproduces the existing rule exactly:
        // extend from the current end while it is still in the future, else
        // from now. GREATEST skips NULLs, so extending an UNLIMITED override
        // measures from now and makes it finite — unchanged behaviour.
        `UPDATE free_access_overrides
         SET ends_at = CASE WHEN $2::int IS NULL THEN NULL
                            ELSE GREATEST(ends_at, now())
                                 + make_interval(days => $2::int) END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [active.id, days],
      );
      return { before: active, after: this.map(rows[0]) };
    });

    if (!outcome) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active free-access override to extend',
      });
    }
    const { before: active, after: result } = outcome;
    this.cache.invalidate(tenantId);
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
    const affected = Array.isArray(res)
      ? res[1]
      : (res as { rowCount?: number })?.rowCount;
    if (!affected) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No active free-access override to revoke',
      });
    }
    // A revocation must stop access NOW — a cached grant outliving its
    // revocation is the one staleness this cache is forbidden to produce.
    this.cache.invalidate(tenantId);
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

  /**
   * Serializes every mutation for ONE tenant, without blocking any other.
   *
   * Transaction-scoped, so it is released by COMMIT or ROLLBACK alike — there
   * is no unlock path to forget and no way for a thrown error to strand it.
   */
  private lockTenant(tenantId: string, manager: EntityManager): Promise<void> {
    return manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
      FREE_ACCESS_LOCK_NAMESPACE,
      tenantId,
    ]);
  }

  /**
   * The LAST line of defence on duration, after `GrantOverrideDto`.
   *
   * The DTO covers every HTTP caller; this covers the ones that never touch a
   * DTO — the RTL seed, future internal callers, and anything that reaches
   * this service directly. `null`/`undefined` is not a bad value: it is the
   * explicit UNLIMITED grant, and passes through untouched.
   */
  private assertDuration(
    durationDays: number | null | undefined,
  ): number | null {
    if (durationDays == null) return null; // unlimited — a deliberate choice
    if (
      !Number.isInteger(durationDays) ||
      durationDays < FREE_ACCESS_MIN_DURATION_DAYS ||
      durationDays > FREE_ACCESS_MAX_DURATION_DAYS
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message:
          `Free-access duration must be a whole number of days between ` +
          `${FREE_ACCESS_MIN_DURATION_DAYS} and ${FREE_ACCESS_MAX_DURATION_DAYS}, ` +
          `or omitted for unlimited`,
        publicContext: {
          field: 'durationDays',
          min: FREE_ACCESS_MIN_DURATION_DAYS,
          max: FREE_ACCESS_MAX_DURATION_DAYS,
        },
      });
    }
    return durationDays;
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
