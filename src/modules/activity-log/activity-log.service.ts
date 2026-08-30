import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  ACTIVITY_VISIBLE_AUDIT_ACTIONS,
  isActivityVisible,
} from './activity-allowlist';
import { changedFields } from './activity-redaction';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';

/**
 * Spec 014 (Clinic Platform Completion) — T191 (US14, F14). The clinic-facing
 * projection over `audit_logs` (S7).
 *
 * Follows `SupportActivityService`'s shape almost exactly — same allow-list
 * mechanism (`ACTIVITY_VISIBLE_AUDIT_ACTIONS`/`isActivityVisible`, T023),
 * same `changedFields` (field NAMES only, `activity-redaction.ts`, T023),
 * same tenant + pagination bounding — with two deliberate divergences:
 *
 *  1. Clinic staff are shown BY NAME (`SupportActivityService` masks them —
 *     Support is diagnosing a system, not auditing people; an OWNER must see
 *     their own staff, so this view never masks).
 *  2. The response carries `actor.id` (needed for an `actorUserId` filter
 *     round-trip) and an explicit `isSystem` flag for the no-actor case.
 *
 * SECURITY (FR-U008): `old_values`/`new_values` are read from the database
 * ONLY to compute `changedFields` and are never attached to anything this
 * service returns — there is no code path here that puts either object, or
 * any of its values, on the response.
 *
 * SECURITY (FR-U007): the allow-list is enforced TWICE — once in the SQL
 * (`al.action = ANY($n)`, so Postgres itself never returns an unlisted row),
 * and again as an in-memory filter over whatever rows do come back
 * (`isActivityVisible`). The second layer is defence in depth: an unlisted
 * action must never surface even if the SQL filter were ever bypassed by a
 * future bug.
 *
 * SECURITY (FR-U010): every row is bound to `al."tenantId" = $1` with a
 * concrete tenant id — a NULL-tenant (platform-level) row can never match a
 * `= $1` predicate, and neither can another tenant's row, so both are
 * excluded structurally, not by an extra check.
 *
 * `entity_id` is stored but never dereferenced against the entity it names —
 * a row referencing a since-deleted record renders exactly like any other,
 * with no join to fail.
 *
 * `branchId` (contracts/clinic-surfaces.md F14) is part of the response
 * shape for a future writer that records it, but `audit_logs` has no branch
 * column today — every row omits the key entirely (optional in the
 * contract), never a fabricated value.
 *
 * Creates no second audit-recording mechanism — this is a READ-ONLY
 * projection over the existing `audit_logs` table.
 */
@Injectable()
export class ActivityLogService {
  constructor(private readonly dataSource: DataSource) {}

  async list(tenantId: string, query: QueryActivityLogDto) {
    const conditions = [`al."tenantId" = $1`, `al.action = ANY($2)`];
    const params: unknown[] = [tenantId, [...ACTIVITY_VISIBLE_AUDIT_ACTIONS]];

    if (query.actorUserId) {
      params.push(query.actorUserId);
      conditions.push(`al."userId" = $${params.length}`);
    }
    if (query.action) {
      params.push(query.action);
      conditions.push(`al.action = $${params.length}`);
    }
    if (query.entityType) {
      params.push(query.entityType);
      conditions.push(`al.entity_type = $${params.length}`);
    }
    if (query.entityId) {
      params.push(query.entityId);
      conditions.push(`al.entity_id = $${params.length}`);
    }
    if (query.from) {
      params.push(new Date(query.from));
      conditions.push(`al.created_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(new Date(query.to));
      conditions.push(`al.created_at <= $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      conditions.push(`al.action ILIKE $${params.length}`);
    }

    const where = conditions.join(' AND ');

    const [[countRow], rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM audit_logs al WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT al.id, al.action, al.entity_type, al.entity_id, al.created_at,
               al.old_values, al.new_values,
               u.id AS actor_id, u.full_name AS actor_name, u.email AS actor_email,
               (u."tenantId" IS NULL) AS actor_is_platform
          FROM audit_logs al
          LEFT JOIN users u ON u.id = al."userId"
         WHERE ${where}
         ORDER BY al.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    const visible = (rows as AuditRow[]).filter((r) =>
      isActivityVisible(r.action),
    );

    return {
      data: visible.map((r) => ({
        id: r.id,
        at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : r.created_at,
        action: r.action,
        actor: r.actor_id
          ? {
              id: r.actor_id,
              // Clinic staff shown BY NAME — the deliberate divergence from
              // SupportActivityService's masking (see the class docblock).
              name: r.actor_name,
              email: r.actor_email,
            }
          : null,
        isSystem: !r.actor_id,
        isPlatformActor: !!r.actor_is_platform,
        entityType: r.entity_type,
        entityId: r.entity_id ?? null,
        /** Key names only — never the before/after VALUES (FR-U008). */
        changedFields: changedFields(r.old_values, r.new_values),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  /** The allow-list itself, for populating the filter control (`GET /activity/actions`). */
  actions(): string[] {
    return [...ACTIVITY_VISIBLE_AUDIT_ACTIONS];
  }
}

interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: Date;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_is_platform: boolean | null;
}
