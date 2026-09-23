import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  FREE_ACCESS_OVERVIEW_EXPIRING_SOON_DAYS,
  OverrideStatus,
  freeAccessNoticesEnabled,
} from './platform-billing.constants';
import { AccessCacheService } from './access-cache.service';
import {
  freeAccessExpiryEmailKey,
  freeAccessStartEmailKey,
  freeAccessStartOutboxKey,
} from './free-access-notice-keys';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { QUEUE, JOB } from '../../queue/queue.constants';

/**
 * Advisory-lock namespace for free-access mutations, so the per-tenant key
 * below cannot collide with any other advisory lock the application takes
 * (`run-migrations-with-lock.ts` holds one during deploys).
 */
const FREE_ACCESS_LOCK_NAMESPACE = 0x7a74_0f61; // "zt" + "fa"

/**
 * Shared read-model CTE behind `getSummary`/`listOverview` — ONE definition
 * of "what is this tenant's free-access lifecycle", so the single-tenant
 * response and the cross-clinic overview can never disagree.
 *
 * Design notes (see the implementation plan §13/§15):
 *  - `latest_override`/`latest_subscription` pick one row per tenant
 *    (`DISTINCT ON`) rather than joining the whole history — keeps this a
 *    single index-friendly pass regardless of how many overrides/
 *    subscriptions a tenant has accumulated.
 *  - `lifecycle` is derived, never stored: REVOKED wins over everything else
 *    (terminal), then UNLIMITED (`ends_at IS NULL`), then EXPIRED
 *    (`ends_at <= now()`), else ACTIVE. A tenant with no override row at all
 *    gets `NONE`.
 *  - `as_of` is the instant elapsed-days math is measured against: frozen at
 *    the revoke time for a REVOKED override (it stopped counting then),
 *    otherwise the live database clock.
 *  - All arithmetic is `EXTRACT(EPOCH FROM …)/86400` on `timestamptz` values
 *    — instant-based, so leap years, DST and the session's timezone can't
 *    perturb it. Only DISPLAY should use `timezone`.
 *  - `days_elapsed` is clamped to `ends_at` (via `LEAST`) once past expiry,
 *    so it stops at `total_days` instead of growing forever after expiry.
 *  - `days_remaining` is 0 (not negative, not null) once EXPIRED or REVOKED —
 *    access is gone either way, so "remaining" has one unambiguous answer.
 */
const SUMMARY_CTE = `
  WITH latest_override AS (
    SELECT DISTINCT ON (tenant_id) *
    FROM free_access_overrides
    ORDER BY tenant_id, created_at DESC
  ),
  latest_subscription AS (
    SELECT DISTINCT ON ("tenantId") "tenantId", status
    FROM subscriptions
    WHERE deleted_at IS NULL
    ORDER BY "tenantId", created_at DESC
  ),
  base AS (
    SELECT
      t.id                     AS tenant_id,
      t.name                   AS tenant_name,
      t.slug                   AS tenant_slug,
      t.is_active              AS tenant_active,
      t.default_timezone       AS timezone,
      ls.status                AS subscription_status,
      o.id                     AS override_id,
      o.starts_at              AS starts_at,
      o.ends_at                AS ends_at,
      o.status                 AS override_status,
      o.granted_by             AS granted_by_id,
      gb.full_name             AS granted_by_name,
      o.start_notice_at        AS start_notice_at,
      o.expiry_warning_at      AS expiry_warning_at,
      o.expiry_warning_ends_at AS expiry_warning_ends_at,
      CASE
        WHEN o.id IS NULL THEN 'NONE'
        WHEN o.status = 'REVOKED' THEN 'REVOKED'
        WHEN o.ends_at IS NULL THEN 'UNLIMITED'
        WHEN o.ends_at <= now() THEN 'EXPIRED'
        ELSE 'ACTIVE'
      END AS lifecycle,
      CASE WHEN o.status = 'REVOKED' THEN o.updated_at ELSE now() END AS as_of,
      -- Computed here (not in final) so EXPIRED's days_elapsed below can
      -- reuse this EXACT value instead of re-deriving it with a different
      -- rounding function: ROUND vs FLOOR on the identical
      -- (ends_at - starts_at) quantity disagree right at an N-day boundary
      -- when that gap is a hair under N*86400s (observed on real data: an
      -- extended override's span isn't always an exact 24h multiple), which
      -- would otherwise show days_elapsed = total_days - 1 on full expiry.
      CASE WHEN o.ends_at IS NULL THEN NULL
           ELSE ROUND(EXTRACT(EPOCH FROM (o.ends_at - o.starts_at)) / 86400)::int
      END AS total_days
    FROM tenants t
    LEFT JOIN latest_override o ON o.tenant_id = t.id
    LEFT JOIN latest_subscription ls ON ls."tenantId" = t.id
    LEFT JOIN users gb ON gb.id = o.granted_by
    WHERE t.deleted_at IS NULL
  ),
  final AS (
    SELECT
      b.*,
      CASE
        WHEN b.override_id IS NULL THEN NULL
        -- EXPIRED means the full natural term ran out: elapsed IS the total
        -- by definition, not a live measurement (see the comment on
        -- total_days above for why this isn't re-derived).
        WHEN b.lifecycle = 'EXPIRED' THEN b.total_days
        ELSE FLOOR(EXTRACT(EPOCH FROM (
          (CASE WHEN b.ends_at IS NOT NULL THEN LEAST(b.as_of, b.ends_at) ELSE b.as_of END)
          - b.starts_at
        )) / 86400)::int
      END AS days_elapsed,
      CASE WHEN b.ends_at IS NULL THEN NULL
           WHEN b.lifecycle IN ('EXPIRED', 'REVOKED') THEN 0
           ELSE GREATEST(0, CEIL(EXTRACT(EPOCH FROM (b.ends_at - now())) / 86400))::int
      END AS days_remaining
    FROM base b
  )
`;

/** The later of two nullable dates, or null if neither is set. */
function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

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

/** Server-computed lifecycle state of a tenant's (latest) free-access override. */
export type FreeAccessLifecycle =
  | 'ACTIVE'
  | 'UNLIMITED'
  | 'EXPIRED'
  | 'REVOKED'
  | 'NONE';

export interface FreeAccessOverviewFilter {
  page: number;
  limit: number;
  search?: string;
  /** `'all'` applies no lifecycle filter. */
  state:
    | 'all'
    | 'active'
    | 'expiring'
    | 'expired'
    | 'revoked'
    | 'unlimited'
    | 'none';
}

export interface FreeAccessNoticeStatus {
  /** Null when this notice has never been queued (e.g. a legacy override, or `notifyClinic:false`). */
  queuedAt: Date | null;
  /** Null until an email has actually been attempted for this notice. */
  emailStatus: 'QUEUED' | 'SENT' | 'FAILED' | null;
}

export interface FreeAccessExpiryWarningStatus extends FreeAccessNoticeStatus {
  /** The `ends_at` value the (most recent) warning was issued for. Null alongside `queuedAt`. */
  forEndsAt: Date | null;
}

/**
 * A tenant's free-access lifecycle, computed entirely server-side from the
 * database clock — never from `Date.now()` or a client-supplied value (see
 * the implementation plan's Timezone Strategy). Reused by both the
 * single-tenant `GET tenants/:id/override` response and the cross-clinic
 * `GET overview` listing, from the SAME query builder, so the two can never
 * disagree.
 */
export interface FreeAccessSummary {
  tenantId: string;
  tenantName: string;
  tenantActive: boolean;
  /** `tenants.default_timezone` — how dates in this summary should be displayed. */
  timezone: string;
  /** The tenant's most recent subscription row's status, if it has one. */
  subscriptionStatus: string | null;
  /** The tenant's most recent override row (any status), or null if it never had one. */
  overrideId: string | null;
  lifecycle: FreeAccessLifecycle;
  startsAt: Date | null;
  endsAt: Date | null;
  /** `ends_at - starts_at` in whole days. Null for an unlimited override or no override. */
  totalDays: number | null;
  /**
   * Days since `starts_at`, as of now — or as of the revoke time for a
   * REVOKED override (frozen; access stopped counting then), and capped at
   * `totalDays` once EXPIRED (elapsed does not keep growing after expiry).
   * Null when there is no override at all.
   */
  daysElapsed: number | null;
  /**
   * Days remaining until `endsAt`. Null for unlimited or no override; 0 once
   * EXPIRED or REVOKED (access is gone either way).
   */
  daysRemaining: number | null;
  grantedBy: { id: string; name: string | null } | null;
  /** Null only when there is no override at all — see {@link overrideId}. */
  startNotice: FreeAccessNoticeStatus | null;
  /** Null only when there is no override at all — see {@link overrideId}. */
  expiryWarning: FreeAccessExpiryWarningStatus | null;
  lastNoticeAt: Date | null;
}

/** One row out of the shared summary CTE — snake_case, straight from Postgres. */
interface FreeAccessSummaryRow {
  tenant_id: string;
  tenant_name: string;
  tenant_active: boolean;
  timezone: string;
  subscription_status: string | null;
  override_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  override_status: OverrideStatus | null;
  granted_by_id: string | null;
  granted_by_name: string | null;
  start_notice_at: string | null;
  expiry_warning_at: string | null;
  expiry_warning_ends_at: string | null;
  lifecycle: FreeAccessLifecycle;
  total_days: number | null;
  days_elapsed: number | null;
  days_remaining: number | null;
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
  /**
   * `true` only when an admin-initiated grant should notify the clinic
   * (start notice, in-app + email). Default `false`, so system/seed callers
   * that reach this service directly — the guest-discovery tenant, the RTL
   * seed — stay silent without having to know this flag exists (D4 in the
   * implementation plan). Only `PlatformBillingAdminController` passes `true`.
   */
  notifyClinic?: boolean;
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
    private readonly config: ConfigService,
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
   * One tenant's free-access lifecycle summary — the LATEST override row
   * (any status, not just an active one), or `lifecycle: 'NONE'` if the
   * tenant has never had one. Null only when the tenant itself doesn't
   * exist (soft-deleted tenants are excluded, same as {@link SUMMARY_CTE}).
   *
   * Exactly 2 queries: the summary row, then one batched `email_logs` lookup
   * for the (at most 2) notice idempotency keys this tenant could have —
   * see {@link attachEmailStatus}.
   */
  async getSummary(tenantId: string): Promise<FreeAccessSummary | null> {
    const rows: FreeAccessSummaryRow[] = await this.dataSource.query(
      `${SUMMARY_CTE} SELECT * FROM final WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!rows[0]) return null;
    const [summary] = await this.attachEmailStatus(rows);
    return summary;
  }

  /**
   * Cross-clinic free-access lifecycle listing for the platform admin
   * overview table. Paginated, searched and lifecycle-filtered entirely in
   * SQL — one query for the page of data (`count(*) OVER()` gives the total
   * for free), plus the same batched `email_logs` lookup `getSummary` uses.
   * Never more than 2 queries regardless of page size or filter.
   */
  async listOverview(filter: FreeAccessOverviewFilter): Promise<{
    data: FreeAccessSummary[];
    total: number;
    page: number;
    limit: number;
    serverNow: Date;
  }> {
    const rows: (FreeAccessSummaryRow & {
      total_count: number;
      server_now: string;
    })[] = await this.dataSource.query(
      `${SUMMARY_CTE}
       SELECT *, count(*) OVER()::int AS total_count, now() AS server_now
       FROM final
       WHERE ($1::text IS NULL OR tenant_name ILIKE '%' || $1 || '%' OR tenant_slug ILIKE '%' || $1 || '%')
         AND (
           $2::text = 'all'
           OR ($2 = 'active'    AND lifecycle = 'ACTIVE' AND (days_remaining IS NULL OR days_remaining > $5::int))
           OR ($2 = 'expiring'  AND lifecycle = 'ACTIVE' AND days_remaining IS NOT NULL AND days_remaining <= $5::int)
           OR ($2 = 'expired'   AND lifecycle = 'EXPIRED')
           OR ($2 = 'revoked'   AND lifecycle = 'REVOKED')
           OR ($2 = 'unlimited' AND lifecycle = 'UNLIMITED')
           OR ($2 = 'none'      AND lifecycle = 'NONE')
         )
       ORDER BY tenant_name ASC
       LIMIT $3 OFFSET $4`,
      [
        filter.search?.trim() || null,
        filter.state,
        filter.limit,
        (filter.page - 1) * filter.limit,
        FREE_ACCESS_OVERVIEW_EXPIRING_SOON_DAYS,
      ],
    );

    const data = await this.attachEmailStatus(rows);
    return {
      data,
      total: rows[0]?.total_count ?? 0,
      page: filter.page,
      limit: filter.limit,
      serverNow: rows[0] ? new Date(rows[0].server_now) : new Date(),
    };
  }

  /**
   * Batches the `email_logs` lookup for a page of summary rows into ONE
   * query keyed on the exact idempotency keys `FreeAccessNoticeService` uses
   * when it actually sends — never a per-row join, and never re-deriving the
   * key format (see `free-access-notice-keys.ts`).
   */
  private async attachEmailStatus(
    rows: FreeAccessSummaryRow[],
  ): Promise<FreeAccessSummary[]> {
    const keys: string[] = [];
    for (const r of rows) {
      if (!r.override_id) continue;
      if (r.start_notice_at) keys.push(freeAccessStartEmailKey(r.override_id));
      if (r.expiry_warning_at && r.expiry_warning_ends_at) {
        keys.push(
          freeAccessExpiryEmailKey(
            r.override_id,
            new Date(r.expiry_warning_ends_at),
          ),
        );
      }
    }

    const statusByKey = new Map<string, 'QUEUED' | 'SENT' | 'FAILED'>();
    if (keys.length > 0) {
      const logs: { idempotency_key: string; status: string }[] =
        await this.dataSource.query(
          `SELECT idempotency_key, status FROM email_logs WHERE idempotency_key = ANY($1::text[])`,
          [keys],
        );
      for (const l of logs) {
        statusByKey.set(l.idempotency_key, l.status as 'QUEUED' | 'SENT' | 'FAILED');
      }
    }

    return rows.map((r) => this.mapSummaryRow(r, statusByKey));
  }

  private mapSummaryRow(
    r: FreeAccessSummaryRow,
    emailStatusByKey: Map<string, 'QUEUED' | 'SENT' | 'FAILED'>,
  ): FreeAccessSummary {
    const overrideId = r.override_id;
    const startNoticeAt = r.start_notice_at ? new Date(r.start_notice_at) : null;
    const expiryWarningAt = r.expiry_warning_at
      ? new Date(r.expiry_warning_at)
      : null;
    const expiryWarningEndsAt = r.expiry_warning_ends_at
      ? new Date(r.expiry_warning_ends_at)
      : null;

    // Both are null only when there is no override at all (nothing to report
    // on). Once an override exists, the object is always present — `queuedAt`
    // itself carries "not sent yet" as null, which is the normal state for
    // any override notices haven't caught up with yet (e.g. every legacy row).
    const startNotice: FreeAccessNoticeStatus | null = overrideId
      ? {
          queuedAt: startNoticeAt,
          emailStatus: startNoticeAt
            ? (emailStatusByKey.get(freeAccessStartEmailKey(overrideId)) ??
              null)
            : null,
        }
      : null;

    const expiryWarning: FreeAccessExpiryWarningStatus | null = overrideId
      ? {
          queuedAt: expiryWarningAt,
          forEndsAt: expiryWarningEndsAt,
          emailStatus:
            expiryWarningAt && expiryWarningEndsAt
              ? (emailStatusByKey.get(
                  freeAccessExpiryEmailKey(overrideId, expiryWarningEndsAt),
                ) ?? null)
              : null,
        }
      : null;

    return {
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      tenantActive: r.tenant_active,
      timezone: r.timezone,
      subscriptionStatus: r.subscription_status,
      overrideId,
      lifecycle: r.lifecycle,
      startsAt: r.starts_at ? new Date(r.starts_at) : null,
      endsAt: r.ends_at ? new Date(r.ends_at) : null,
      totalDays: r.total_days,
      daysElapsed: r.days_elapsed,
      daysRemaining: r.days_remaining,
      grantedBy: r.granted_by_id
        ? { id: r.granted_by_id, name: r.granted_by_name }
        : null,
      startNotice,
      expiryWarning,
      lastNoticeAt: maxDate(startNoticeAt, expiryWarningAt),
    };
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
    // The kill switch only affects the NOTICE side. The grant itself always
    // proceeds — flipping notices off must never change access-control
    // behaviour, only whether the clinic is told about it.
    const notifyClinic =
      (input.notifyClinic ?? false) && freeAccessNoticesEnabled(this.config);

    const result = await this.dataSource.transaction(async (manager) => {
      await this.lockTenant(tenantId, manager);
      if (await this.getActive(tenantId, manager)) return null;
      const rows = await manager.query(
        `INSERT INTO free_access_overrides
           (id, tenant_id, granted_by, reason, starts_at, ends_at, status, start_notice_at)
         VALUES (
           $1, $2, $3, $4,
           now(),
           CASE WHEN $5::int IS NULL THEN NULL
                ELSE now() + make_interval(days => $5::int) END,
           'ACTIVE',
           CASE WHEN $6::boolean THEN now() END)
         RETURNING *`,
        [
          randomUUID(),
          tenantId,
          input.grantedBy ?? null,
          input.reason ?? null,
          durationDays,
          notifyClinic,
        ],
      );
      const override = this.map(rows[0]);
      if (notifyClinic) {
        // Written in the SAME transaction as the override row (the
        // transactional outbox pattern already used by
        // `WorkflowService.createRunWithOutbox`) — the notice can never be
        // lost to a crash between the grant committing and the enqueue, and
        // the relay's own dedupe (`dedupe_key` unique) makes a redelivered
        // outbox row a no-op rather than a second notice.
        await manager.save(
          manager.create(OutboxJob, {
            queue: QUEUE.PLATFORM,
            job_name: JOB.PLATFORM_FREE_ACCESS_NOTICE,
            dedupe_key: freeAccessStartOutboxKey(override.id),
            payload: { overrideId: override.id, kind: 'STARTED' },
          }),
        );
      }
      return override;
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
      after: {
        reason: result.reason,
        startsAt: result.starts_at,
        endsAt: result.ends_at,
        durationDays,
        notifyClinic,
      },
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
      after: { endsAt: result.ends_at, durationDays: days },
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
