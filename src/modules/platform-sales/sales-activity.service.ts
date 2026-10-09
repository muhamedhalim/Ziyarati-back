import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';

import type {
  CreateSalesActivityDto,
  QuerySalesActivitiesDto,
} from './dto/sales-activity-dtos';
import {
  SALES_ACTIVITY_FUTURE_SKEW_MS,
  SALES_ACTIVITY_MAX_AGE_DAYS,
  SALES_ACTIVITY_NOTE_MAX,
  SALES_ACTIVITY_PROSPECT_MAX,
} from './platform-sales.constants';
import { SalesEmployeeService } from './sales-employee.service';
import type { Paged, SalesActivityItem } from './sales.types';

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

const invalid = (field: string, message: string): never => {
  throw new AppError(ErrorCode.VALIDATION_ERROR, {
    message,
    publicContext: { field },
  });
};

/** A strict `YYYY-MM-DD` (rejects 2026-02-31) as the UTC instant its day starts. */
function utcDayStart(day: string, field: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    invalid(field, `${field} must be a real calendar date`);
  }
  return date;
}

interface ActivityRow {
  id: string;
  type: string;
  occurred_at: Date | string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_slug: string | null;
  prospect_name: string | null;
  outcome: string | null;
  note: string | null;
  source: string;
  recorded_by: string | null;
  recorded_by_name: string | null;
  created_at: Date | string;
}

const ACTIVITY_SELECT = `SELECT a.id, a.type, a.occurred_at, a.tenant_id,
       t.name AS tenant_name, t.slug AS tenant_slug,
       a.prospect_name, a.outcome, a.note, a.source, a.recorded_by,
       COALESCE(u.full_name, u.email) AS recorded_by_name, a.created_at
  FROM sales_activities a
  LEFT JOIN tenants t ON t.id = a.tenant_id
  LEFT JOIN users u ON u.id = a.recorded_by`;

function toItem(r: ActivityRow): SalesActivityItem {
  return {
    id: r.id,
    type: r.type,
    occurredAt: iso(r.occurred_at),
    clinic: r.tenant_id
      ? { id: r.tenant_id, name: r.tenant_name ?? '', slug: r.tenant_slug ?? '' }
      : null,
    prospectName: r.prospect_name,
    outcome: r.outcome,
    note: r.note,
    source: r.source,
    recordedBy: r.recorded_by
      ? { id: r.recorded_by, name: r.recorded_by_name }
      : null,
    createdAt: iso(r.created_at),
  };
}

/**
 * Field-sales activity log (visits, calls, meetings, demos, follow-ups).
 *
 * The platform has NO automatic source for these, so every v1 row is typed in by
 * a Super Admin (`source = 'admin_manual'`) and the UI says so; a future rep
 * console would write `source = 'self'` to the same table. Rows are soft-deleted
 * and audited, and are always reached through the employee in the route.
 *
 * A deactivated employee can still have activities logged for the days they
 * worked (an admin catching up after they left) — `occurredAt` is validated
 * instead: not in the future, not absurdly old.
 */
@Injectable()
export class SalesActivityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly employees: SalesEmployeeService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  async list(
    employeeId: string,
    query: QuerySalesActivitiesDto,
  ): Promise<Paged<SalesActivityItem>> {
    await this.employees.requireEmployee(employeeId);
    const params: unknown[] = [employeeId];
    const filters = ['a.sales_user_id = $1', 'a.deleted_at IS NULL'];
    if (query.from) {
      params.push(utcDayStart(query.from, 'from').toISOString());
      filters.push(`a.occurred_at >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      const next = utcDayStart(query.to, 'to');
      next.setUTCDate(next.getUTCDate() + 1); // `to` is an inclusive day
      params.push(next.toISOString());
      filters.push(`a.occurred_at < $${params.length}::timestamptz`);
    }
    if (query.from && query.to && query.from > query.to) {
      invalid('from', '`from` must not be after `to`');
    }
    if (query.type) {
      params.push(query.type);
      filters.push(`a.type = $${params.length}`);
    }
    if (query.tenantId) {
      params.push(query.tenantId);
      filters.push(`a.tenant_id = $${params.length}::uuid`);
    }
    const where = filters.join(' AND ');

    const [countRows, rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM sales_activities a WHERE ${where}`,
        params,
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `${ACTIVITY_SELECT}
          WHERE ${where}
          ORDER BY a.occurred_at DESC, a.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.limit, query.offset()],
      ) as Promise<ActivityRow[]>,
    ]);
    return {
      data: rows.map(toItem),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async create(
    employeeId: string,
    dto: CreateSalesActivityDto,
    actorUserId: string,
    opts: { source?: 'admin_manual' | 'self' } = {},
  ): Promise<SalesActivityItem> {
    const source = opts.source ?? 'admin_manual';
    await this.employees.requireEmployee(
      employeeId,
      source === 'self' ? { requireActive: true } : undefined,
    );

    const prospect = dto.prospectName?.trim() || null;
    if (dto.tenantId && prospect) {
      invalid('prospectName', 'Pick a clinic OR enter a prospect name, not both');
    }
    if (!dto.tenantId && !prospect) {
      invalid('tenantId', 'Pick a clinic or enter a prospect name');
    }
    if (prospect && prospect.length > SALES_ACTIVITY_PROSPECT_MAX) {
      invalid('prospectName', 'Prospect name is too long');
    }
    const note = dto.note?.trim() || null;
    if (note && note.length > SALES_ACTIVITY_NOTE_MAX) {
      invalid('note', 'Note is too long');
    }

    const occurredAt = new Date(dto.occurredAt);
    const now = Date.now();
    if (Number.isNaN(occurredAt.getTime())) {
      invalid('occurredAt', 'occurredAt must be a valid date and time');
    }
    if (occurredAt.getTime() > now + SALES_ACTIVITY_FUTURE_SKEW_MS) {
      invalid('occurredAt', 'An activity cannot be dated in the future');
    }
    if (occurredAt.getTime() < now - SALES_ACTIVITY_MAX_AGE_DAYS * 86_400_000) {
      invalid(
        'occurredAt',
        `An activity cannot be older than ${SALES_ACTIVITY_MAX_AGE_DAYS} days`,
      );
    }

    if (dto.tenantId) {
      const clinic = (await this.dataSource.query(
        `SELECT id FROM tenants WHERE id = $1::uuid AND deleted_at IS NULL`,
        [dto.tenantId],
      )) as Array<{ id: string }>;
      if (!clinic[0]) invalid('tenantId', 'Clinic not found');
      // A rep logs against the clinics they currently own; an admin may log for any.
      if (source === 'self') {
        const owned = (await this.dataSource.query(
          `SELECT 1 FROM sales_clinic_assignments
            WHERE sales_user_id = $1::uuid AND tenant_id = $2::uuid AND ended_at IS NULL`,
          [employeeId, dto.tenantId],
        )) as unknown[];
        if (!owned[0]) invalid('tenantId', 'Clinic not found');
      }
    }

    const inserted = (await this.dataSource.query(
      `INSERT INTO sales_activities
         (sales_user_id, tenant_id, prospect_name, type, occurred_at, outcome,
          note, source, recorded_by)
       VALUES ($1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::timestamptz,
               $6::varchar, $7::varchar, $9::varchar, $8::uuid)
       RETURNING id`,
      [
        employeeId,
        dto.tenantId ?? null,
        prospect,
        dto.type,
        occurredAt.toISOString(),
        dto.outcome ?? null,
        note,
        actorUserId,
        source,
      ],
    )) as Array<{ id: string }>;
    const id = inserted[0].id;

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ACTIVITY_LOGGED,
      userId: actorUserId,
      entityType: 'SalesActivity',
      entityId: id,
      tenantId: dto.tenantId ?? null,
      after: {
        employeeId,
        source,
        type: dto.type,
        occurredAt: occurredAt.toISOString(),
        tenantId: dto.tenantId ?? null,
        prospectName: prospect,
        outcome: dto.outcome ?? null,
        hasNote: note !== null,
      },
    });

    const rows = (await this.dataSource.query(
      `${ACTIVITY_SELECT} WHERE a.id = $1::uuid`,
      [id],
    )) as ActivityRow[];
    return toItem(rows[0]);
  }

  /** Soft-deletes an activity of THIS employee. A second delete is a 404. */
  async remove(
    employeeId: string,
    activityId: string,
    actorUserId: string,
  ): Promise<{ deleted: true }> {
    await this.employees.requireEmployee(employeeId);
    // TypeORM's query() returns a `[rows, affectedCount]` TUPLE for UPDATE ... RETURNING.
    const [rows] = (await this.dataSource.query(
      `UPDATE sales_activities SET deleted_at = now()
        WHERE id = $1::uuid AND sales_user_id = $2::uuid AND deleted_at IS NULL
      RETURNING id, tenant_id, type, prospect_name`,
      [activityId, employeeId],
    )) as [
      Array<{
        id: string;
        tenant_id: string | null;
        type: string;
        prospect_name: string | null;
      }>,
      number,
    ];
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.SALES_ACTIVITY_NOT_FOUND);

    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ACTIVITY_DELETED,
      userId: actorUserId,
      entityType: 'SalesActivity',
      entityId: row.id,
      tenantId: row.tenant_id,
      before: {
        employeeId,
        type: row.type,
        tenantId: row.tenant_id,
        prospectName: row.prospect_name,
      },
    });
    return { deleted: true };
  }
}
