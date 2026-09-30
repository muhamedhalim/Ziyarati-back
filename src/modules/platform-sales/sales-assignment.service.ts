import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';

import { AssignClinicsDto } from './dto/assign-clinics.dto';
import {
  EndAssignmentsDto,
  TransferAssignmentsDto,
} from './dto/end-assignments.dto';
import { QueryEmployeeClinicsDto } from './dto/query-employee-clinics.dto';
import { QuerySalesClinicsDto } from './dto/query-sales-clinics.dto';
import { SalesPageQueryDto } from './dto/sales-page-query.dto';
import { SALES_BULK_MAX } from './platform-sales.constants';
import { SalesEmployeeService } from './sales-employee.service';
import type {
  Paged,
  SalesAssignResult,
  SalesAssignSkipped,
  SalesClinicBasics,
  SalesClinicHistoryItem,
  SalesEndResult,
  SalesPickerClinic,
  SalesPortfolioItem,
  SalesTransferResult,
} from './sales.types';

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

const PG_UNIQUE_VIOLATION = '23505';
export const isUniqueViolation = (err: unknown): boolean =>
  (err as { code?: string; driverError?: { code?: string } })?.code ===
    PG_UNIQUE_VIOLATION ||
  (err as { driverError?: { code?: string } })?.driverError?.code ===
    PG_UNIQUE_VIOLATION;

/** Latest subscription (identity only — status and plan name) for a clinic row `p`. */
const SUBSCRIPTION_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT s.status, s."planId"
      FROM subscriptions s
     WHERE s."tenantId" = p.tenant_id AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC
     LIMIT 1
  ) sub ON true
  LEFT JOIN subscription_plans pl ON pl.id = sub."planId"`;

interface ClinicRow {
  tenant_id: string;
  name: string;
  slug: string;
  contact_email: string | null;
  contact_phone: string | null;
  is_active: boolean;
  approval_status: string;
  created_at: Date | string | null;
  subscription_status: string | null;
  plan_name: string | null;
}

const clinicBasics = (r: ClinicRow): SalesClinicBasics => ({
  id: r.tenant_id,
  name: r.name,
  slug: r.slug,
  contactEmail: r.contact_email ?? null,
  contactPhone: r.contact_phone ?? null,
  isActive: r.is_active,
  approvalStatus: r.approval_status,
  createdAt: iso(r.created_at),
  subscriptionStatus: r.subscription_status ?? null,
  planName: r.plan_name ?? null,
});

/**
 * Clinic ownership.
 *
 * INVARIANTS (all enforced by the database, not by read-then-write checks):
 *   - a clinic has at most ONE active owner (`UQ_sales_assignment_active_tenant`);
 *   - acquisition credit is granted at most once per clinic, ever
 *     (`UQ_sales_assignment_acquired_tenant`);
 *   - a row is closed (`ended_at`), never deleted, so history is complete.
 *
 * Every bulk write is a single transaction of SET-BASED statements (no
 * per-clinic round trips), takes its row locks in `tenant_id` order (so two
 * overlapping batches cannot deadlock), and inserts with
 * `ON CONFLICT ... DO NOTHING` so the loser of a race is reported as skipped
 * rather than failing the batch.
 */
@Injectable()
export class SalesAssignmentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly employees: SalesEmployeeService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  // ─────────────────────────────── Reads ─────────────────────────────────── //

  /** Clinic picker: page-first, so aggregates run for the page, not the table. */
  async listClinics(
    query: QuerySalesClinicsDto,
  ): Promise<Paged<SalesPickerClinic>> {
    const params: unknown[] = [];
    const filters = ['t.deleted_at IS NULL'];

    if (query.approvalStatus) {
      params.push(query.approvalStatus);
      filters.push(`t.approval_status = $${params.length}`);
    } else {
      filters.push(`t.approval_status <> 'REJECTED'`);
    }
    const search = query.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      filters.push(
        `(t.name ILIKE ${p} OR t.slug ILIKE ${p} OR t.contact_email ILIKE ${p} OR t.contact_phone ILIKE ${p})`,
      );
    }
    if (query.assignment === 'unassigned') filters.push('a.id IS NULL');
    if (query.assignment === 'assigned') filters.push('a.id IS NOT NULL');
    if (query.excludeEmployeeId) {
      params.push(query.excludeEmployeeId);
      filters.push(
        `(a.id IS NULL OR a.sales_user_id <> $${params.length}::uuid)`,
      );
    }
    const where = filters.join(' AND ');
    const dir = query.sortDir === 'DESC' ? 'DESC' : 'ASC';
    const sortCol = query.sortBy === 'createdAt' ? 't.created_at' : 'LOWER(t.name)';
    const outerSort = query.sortBy === 'createdAt' ? 'p.created_at' : 'p.sort_name';

    const from = `FROM tenants t
      LEFT JOIN sales_clinic_assignments a ON a.tenant_id = t.id AND a.ended_at IS NULL`;

    const [countRows, rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total ${from} WHERE ${where}`,
        params,
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `WITH page AS (
           SELECT t.id AS tenant_id, t.name, t.slug, t.contact_email, t.contact_phone,
                  t.is_active, t.approval_status, t.created_at,
                  ${sortCol} AS sort_name,
                  a.sales_user_id AS owner_id, a.kind AS owner_kind, a.assigned_at AS owner_assigned_at
             ${from}
            WHERE ${where}
            ORDER BY ${sortCol} ${dir}, t.id ${dir}
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
         )
         SELECT p.*, sub.status AS subscription_status, pl.name AS plan_name,
                ou.full_name AS owner_name, ou.email AS owner_email
           FROM page p
           ${SUBSCRIPTION_LATERAL}
           LEFT JOIN users ou ON ou.id = p.owner_id
          ORDER BY ${outerSort} ${dir}, p.tenant_id ${dir}`,
        [...params, query.limit, query.offset()],
      ) as Promise<
        Array<
          ClinicRow & {
            owner_id: string | null;
            owner_kind: 'acquired' | 'managed' | null;
            owner_assigned_at: Date | string | null;
            owner_name: string | null;
            owner_email: string | null;
          }
        >
      >,
    ]);

    return {
      data: rows.map((r) => ({
        ...clinicBasics(r),
        owner: r.owner_id
          ? {
              employeeId: r.owner_id,
              name: r.owner_name ?? r.owner_email ?? null,
              kind: r.owner_kind as 'acquired' | 'managed',
              assignedAt: iso(r.owner_assigned_at),
            }
          : null,
      })),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  /** One employee's portfolio (route-scoped: only THIS employee's rows). */
  async listEmployeeClinics(
    employeeId: string,
    query: QueryEmployeeClinicsDto,
  ): Promise<Paged<SalesPortfolioItem>> {
    await this.employees.requireEmployee(employeeId);

    const params: unknown[] = [employeeId];
    const filters = ['a.sales_user_id = $1', 't.deleted_at IS NULL'];
    if (query.status === 'active') filters.push('a.ended_at IS NULL');
    if (query.status === 'ended') filters.push('a.ended_at IS NOT NULL');
    if (query.kind) {
      params.push(query.kind);
      filters.push(`a.kind = $${params.length}`);
    }
    const search = query.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      filters.push(
        `(t.name ILIKE ${p} OR t.slug ILIKE ${p} OR t.contact_email ILIKE ${p} OR t.contact_phone ILIKE ${p})`,
      );
    }

    // The activity lateral is evaluated BEFORE paging only when it is the sort
    // key or a filter; otherwise it runs for the page's rows alone.
    const lateralBeforePage =
      query.sortBy === 'lastActivity' || query.staleDays !== undefined;
    const activityLateral = `
      LEFT JOIN LATERAL (
        SELECT MAX(s.occurred_at) AS last_activity_at
          FROM sales_activities s
         WHERE s.tenant_id = t.id AND s.sales_user_id = a.sales_user_id AND s.deleted_at IS NULL
      ) act ON true`;
    if (query.staleDays !== undefined) {
      params.push(query.staleDays);
      filters.push(
        `(act.last_activity_at IS NULL OR act.last_activity_at < now() - ($${params.length}::int * interval '1 day'))`,
      );
    }
    const where = filters.join(' AND ');
    const dir = query.sortDir === 'ASC' ? 'ASC' : 'DESC';
    const sortExpr =
      query.sortBy === 'name'
        ? 'LOWER(t.name)'
        : query.sortBy === 'lastActivity'
          ? 'act.last_activity_at'
          : 'a.assigned_at';
    const outerSortExpr =
      query.sortBy === 'name'
        ? 'p.sort_key'
        : query.sortBy === 'lastActivity'
          ? 'p.last_activity_at'
          : 'p.assigned_at';

    const base = `FROM sales_clinic_assignments a
      INNER JOIN tenants t ON t.id = a.tenant_id
      ${lateralBeforePage ? activityLateral : ''}`;

    const [countRows, rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total ${base} WHERE ${where}`,
        params,
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `WITH page AS (
           SELECT a.id AS assignment_id, a.kind, a.assigned_at, a.ended_at, a.end_reason, a.note,
                  t.id AS tenant_id, t.name, t.slug, t.contact_email, t.contact_phone,
                  t.is_active, t.approval_status, t.created_at,
                  ${sortExpr} AS sort_key
                  ${lateralBeforePage ? ', act.last_activity_at' : ''}
             ${base}
            WHERE ${where}
            ORDER BY ${sortExpr} ${dir} NULLS LAST, a.id ${dir}
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
         )
         SELECT p.*, sub.status AS subscription_status, pl.name AS plan_name
                ${lateralBeforePage ? '' : ', act2.last_activity_at'}
           FROM page p
           ${SUBSCRIPTION_LATERAL}
           ${
             lateralBeforePage
               ? ''
               : `LEFT JOIN LATERAL (
                    SELECT MAX(s.occurred_at) AS last_activity_at
                      FROM sales_activities s
                     WHERE s.tenant_id = p.tenant_id AND s.sales_user_id = $1 AND s.deleted_at IS NULL
                  ) act2 ON true`
           }
          ORDER BY ${outerSortExpr} ${dir} NULLS LAST, p.assignment_id ${dir}`,
        [...params, query.limit, query.offset()],
      ) as Promise<
        Array<
          ClinicRow & {
            assignment_id: string;
            kind: 'acquired' | 'managed';
            assigned_at: Date | string | null;
            ended_at: Date | string | null;
            end_reason: SalesPortfolioItem['endReason'];
            note: string | null;
            last_activity_at: Date | string | null;
          }
        >
      >,
    ]);

    return {
      data: rows.map((r) => ({
        assignmentId: r.assignment_id,
        clinic: clinicBasics(r),
        kind: r.kind,
        assignedAt: iso(r.assigned_at),
        endedAt: iso(r.ended_at),
        endReason: r.end_reason ?? null,
        note: r.note ?? null,
        lastActivityAt: iso(r.last_activity_at),
      })),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Full ownership history of one clinic. */
  async clinicHistory(
    tenantId: string,
    query: SalesPageQueryDto,
  ): Promise<Paged<SalesClinicHistoryItem>> {
    const [tenant] = (await this.dataSource.query(
      `SELECT id FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
      [tenantId],
    )) as Array<{ id: string }>;
    if (!tenant) throw new AppError(ErrorCode.TENANT_NOT_FOUND);

    const [countRows, rows] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM sales_clinic_assignments WHERE tenant_id = $1`,
        [tenantId],
      ) as Promise<Array<{ total: number }>>,
      this.dataSource.query(
        `SELECT a.id, a.sales_user_id, a.kind, a.assigned_at, a.ended_at, a.end_reason, a.note,
                u.full_name, u.email
           FROM sales_clinic_assignments a
           LEFT JOIN users u ON u.id = a.sales_user_id
          WHERE a.tenant_id = $1
          ORDER BY a.assigned_at DESC, a.id DESC
          LIMIT $2 OFFSET $3`,
        [tenantId, query.limit, query.offset()],
      ) as Promise<
        Array<{
          id: string;
          sales_user_id: string;
          kind: 'acquired' | 'managed';
          assigned_at: Date | string | null;
          ended_at: Date | string | null;
          end_reason: SalesClinicHistoryItem['endReason'];
          note: string | null;
          full_name: string | null;
          email: string | null;
        }>
      >,
    ]);

    return {
      data: rows.map((r) => ({
        assignmentId: r.id,
        employee: { id: r.sales_user_id, name: r.full_name, email: r.email },
        kind: r.kind,
        assignedAt: iso(r.assigned_at),
        endedAt: iso(r.ended_at),
        endReason: r.end_reason ?? null,
        note: r.note ?? null,
      })),
      total: countRows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  // ─────────────────────────────── Writes ────────────────────────────────── //

  async assign(
    employeeId: string,
    dto: AssignClinicsDto,
    actorUserId: string,
  ): Promise<SalesAssignResult> {
    const kind = dto.kind ?? 'managed';
    const onConflict = dto.onConflict ?? 'skip';
    const requested = [...new Set(dto.tenantIds)];

    let result: SalesAssignResult;
    let previousOwners: Record<string, string> = {};
    try {
      ({ result, previousOwners } = await this.dataSource.transaction(
        async (m) => {
          await this.employees.requireEmployee(employeeId, {
            manager: m,
            requireActive: true,
          });
          return this.assignBatch(m, {
            employeeId,
            items: requested.map((tenantId) => ({
              tenantId,
              kind,
              note: dto.note ?? null,
            })),
            onConflict,
            actorUserId,
          });
        },
      ));
    } catch (err) {
      // Only reachable through the ACQUIRED-credit index racing another
      // acquired insert; the active-owner race is absorbed by ON CONFLICT.
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.SALES_CLINIC_ALREADY_ASSIGNED, {
          cause: err,
        });
      }
      throw err;
    }

    if (result.assigned > 0) {
      const assignedIds = requested.filter(
        (id) => !result.skipped.some((s) => s.tenantId === id),
      );
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ASSIGNMENT_CREATED,
        userId: actorUserId,
        entityType: 'SalesEmployee',
        entityId: employeeId,
        // A single-clinic action is attributed to that clinic (so it shows on
        // the clinic's own trail); a bulk action is one entry, not N.
        tenantId: assignedIds.length === 1 ? assignedIds[0] : undefined,
        before:
          Object.keys(previousOwners).length > 0
            ? { previousOwners }
            : undefined,
        after: {
          kind,
          assigned: result.assigned,
          reassigned: result.reassigned,
          tenantIds: assignedIds.slice(0, SALES_BULK_MAX),
        },
      });
    }
    return result;
  }

  /**
   * The set-based write behind both the bulk assign and the Excel import.
   * Runs INSIDE the caller's transaction (which has already verified the
   * employee) and is the authority on conflicts: it re-reads ownership under
   * `FOR UPDATE`, so whatever a caller decided earlier — a preview, a
   * classification — is re-checked here, never trusted.
   *
   * `kind` and `note` are per item so one statement serves an import whose
   * rows differ; `items` must not repeat a clinic (callers de-duplicate).
   */
  async assignBatch(
    m: EntityManager,
    p: {
      employeeId: string;
      items: ReadonlyArray<{
        tenantId: string;
        kind: 'acquired' | 'managed';
        note: string | null;
      }>;
      onConflict: 'skip' | 'reassign';
      actorUserId: string;
    },
  ): Promise<{
    result: SalesAssignResult;
    previousOwners: Record<string, string>;
  }> {
    const skipped: SalesAssignSkipped[] = [];
    const tenantIds = p.items.map((i) => i.tenantId);
    const itemById = new Map(p.items.map((i) => [i.tenantId, i]));

    // 1. Only real, non-deleted, non-rejected clinics are assignable.
    const tenants = (await m.query(
      `SELECT id, approval_status FROM tenants
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [tenantIds],
    )) as Array<{ id: string; approval_status: string }>;
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const candidates: string[] = [];
    for (const id of tenantIds) {
      const t = tenantById.get(id);
      if (!t) skipped.push({ tenantId: id, reason: 'clinic_not_found' });
      else if (t.approval_status === 'REJECTED')
        skipped.push({ tenantId: id, reason: 'clinic_rejected' });
      else candidates.push(id);
    }

    // 2. Lock the current active owners, in tenant order (deadlock-free).
    const active = candidates.length
      ? ((await m.query(
          `SELECT id, tenant_id, sales_user_id FROM sales_clinic_assignments
            WHERE tenant_id = ANY($1::uuid[]) AND ended_at IS NULL
            ORDER BY tenant_id
              FOR UPDATE`,
          [candidates],
        )) as Array<{ id: string; tenant_id: string; sales_user_id: string }>)
      : [];
    const activeByTenant = new Map(active.map((r) => [r.tenant_id, r]));

    // 3. Acquisition credit is once-per-clinic-ever.
    const credited = new Set<string>();
    const wantsCredit = candidates.filter((id) => itemById.get(id)?.kind === 'acquired');
    if (wantsCredit.length) {
      const rows = (await m.query(
        `SELECT tenant_id FROM sales_clinic_assignments
          WHERE tenant_id = ANY($1::uuid[]) AND kind = 'acquired'`,
        [wantsCredit],
      )) as Array<{ tenant_id: string }>;
      rows.forEach((r) => credited.add(r.tenant_id));
    }

    const toInsert: string[] = [];
    const toClose: string[] = [];
    const previousOwners: Record<string, string> = {};
    for (const id of candidates) {
      const current = activeByTenant.get(id);
      if (current?.sales_user_id === p.employeeId) {
        skipped.push({ tenantId: id, reason: 'already_assigned_to_employee' });
        continue;
      }
      if (current && p.onConflict === 'skip') {
        skipped.push({
          tenantId: id,
          reason: 'assigned_to_other',
          ownerEmployeeId: current.sales_user_id,
        });
        continue;
      }
      if (itemById.get(id)?.kind === 'acquired' && credited.has(id)) {
        skipped.push({ tenantId: id, reason: 'acquisition_already_credited' });
        continue;
      }
      if (current) {
        toClose.push(current.id);
        previousOwners[id] = current.sales_user_id;
      }
      toInsert.push(id);
    }

    // 4. Close the assignments being taken over.
    if (toClose.length) {
      await m.query(
        `UPDATE sales_clinic_assignments
            SET ended_at = now(), end_reason = 'reassigned', ended_by = $2
          WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
        [toClose, p.actorUserId],
      );
    }

    // 5. Insert. A concurrent winner makes this row a no-op (not an error).
    let inserted: string[] = [];
    if (toInsert.length) {
      const rows = (await m.query(
        `INSERT INTO sales_clinic_assignments (sales_user_id, tenant_id, kind, assigned_by, note)
         SELECT $1::uuid, i.tenant_id, i.kind, $2::uuid, i.note
           FROM unnest($3::uuid[], $4::varchar[], $5::varchar[]) AS i(tenant_id, kind, note)
          ORDER BY i.tenant_id
         ON CONFLICT (tenant_id) WHERE ended_at IS NULL DO NOTHING
         RETURNING tenant_id`,
        [
          p.employeeId,
          p.actorUserId,
          toInsert,
          toInsert.map((id) => itemById.get(id)!.kind),
          toInsert.map((id) => itemById.get(id)!.note),
        ],
      )) as Array<{ tenant_id: string }>;
      inserted = rows.map((r) => r.tenant_id);
      const insertedSet = new Set(inserted);
      for (const id of toInsert) {
        if (!insertedSet.has(id)) {
          skipped.push({ tenantId: id, reason: 'concurrent_assignment' });
          delete previousOwners[id];
        }
      }
    }

    return {
      result: {
        requested: p.items.length,
        assigned: inserted.length,
        reassigned: inserted.filter((id) => id in previousOwners).length,
        skipped,
      },
      previousOwners,
    };
  }

  /** Ends assignments outright (the clinic becomes unowned). Idempotent. */
  async end(
    dto: EndAssignmentsDto,
    actorUserId: string,
  ): Promise<SalesEndResult> {
    const ids = [...new Set(dto.assignmentIds)];

    const { ended, existing } = await this.dataSource.transaction(async (m) => {
      // TypeORM's query() returns a `[rows, affectedCount]` TUPLE for
      // UPDATE ... RETURNING (INSERT/SELECT return plain rows) — destructure it.
      const [endedRows] = (await m.query(
        `UPDATE sales_clinic_assignments
            SET ended_at = now(), end_reason = 'unassigned', ended_by = $2::uuid,
                note = COALESCE($3::varchar, note)
          WHERE id = ANY($1::uuid[]) AND ended_at IS NULL
        RETURNING id, tenant_id, sales_user_id`,
        [ids, actorUserId, dto.note ?? null],
      )) as [Array<{ id: string; tenant_id: string; sales_user_id: string }>, number];
      const existingRows = (await m.query(
        `SELECT id FROM sales_clinic_assignments WHERE id = ANY($1::uuid[])`,
        [ids],
      )) as Array<{ id: string }>;
      return { ended: endedRows, existing: new Set(existingRows.map((r) => r.id)) };
    });

    const endedIds = new Set(ended.map((r) => r.id));
    const skipped: SalesEndResult['skipped'] = [];
    for (const id of ids) {
      if (endedIds.has(id)) continue;
      skipped.push({
        assignmentId: id,
        reason: existing.has(id) ? 'already_ended' : 'not_found',
      });
    }

    if (ended.length > 0) {
      const single = ended.length === 1 ? ended[0] : undefined;
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ASSIGNMENT_ENDED,
        userId: actorUserId,
        entityType: 'SalesAssignment',
        entityId: single?.id,
        tenantId: single?.tenant_id,
        before: {
          employeeIds: [...new Set(ended.map((r) => r.sales_user_id))],
        },
        after: {
          ended: ended.length,
          tenantIds: ended.map((r) => r.tenant_id).slice(0, SALES_BULK_MAX),
        },
      });
    }

    return { requested: ids.length, ended: ended.length, skipped };
  }

  /**
   * Hands an employee's clinics to another. The SOURCE may be deactivated (that
   * is the point); the TARGET must be active. Rows are found by
   * `sales_user_id = from`, so an assignment id belonging to anyone else is
   * reported `not_owned_by_employee` and never touched.
   */
  async transfer(
    fromEmployeeId: string,
    dto: TransferAssignmentsDto,
    actorUserId: string,
  ): Promise<SalesTransferResult> {
    if (fromEmployeeId === dto.toEmployeeId) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Choose a different employee to transfer the clinics to',
      });
    }
    const wantAll = dto.all === true;
    const requestedIds = wantAll ? [] : [...new Set(dto.assignmentIds ?? [])];

    const out = await this.dataSource.transaction(async (m) => {
      await this.employees.requireEmployee(fromEmployeeId, { manager: m });
      await this.employees.requireEmployee(dto.toEmployeeId, {
        manager: m,
        requireActive: true,
      });

      const owned = (await m.query(
        wantAll
          ? `SELECT id, tenant_id FROM sales_clinic_assignments
              WHERE sales_user_id = $1 AND ended_at IS NULL
              ORDER BY tenant_id LIMIT ${SALES_BULK_MAX} FOR UPDATE`
          : `SELECT id, tenant_id FROM sales_clinic_assignments
              WHERE sales_user_id = $1 AND ended_at IS NULL AND id = ANY($2::uuid[])
              ORDER BY tenant_id FOR UPDATE`,
        wantAll ? [fromEmployeeId] : [fromEmployeeId, requestedIds],
      )) as Array<{ id: string; tenant_id: string }>;

      const skipped: SalesTransferResult['skipped'] = [];
      const ownedIds = new Set(owned.map((r) => r.id));
      for (const id of requestedIds) {
        if (!ownedIds.has(id))
          skipped.push({ assignmentId: id, reason: 'not_owned_by_employee' });
      }

      let transferredTenants: string[] = [];
      if (owned.length) {
        await m.query(
          `UPDATE sales_clinic_assignments
              SET ended_at = now(), end_reason = 'transferred', ended_by = $2
            WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
          [owned.map((r) => r.id), actorUserId],
        );
        const inserted = (await m.query(
          `INSERT INTO sales_clinic_assignments (sales_user_id, tenant_id, kind, assigned_by, note)
           SELECT $1::uuid, t.id, 'managed', $2::uuid, $3::varchar FROM unnest($4::uuid[]) AS t(id) ORDER BY t.id
           ON CONFLICT (tenant_id) WHERE ended_at IS NULL DO NOTHING
           RETURNING tenant_id`,
          [
            dto.toEmployeeId,
            actorUserId,
            dto.note ?? null,
            owned.map((r) => r.tenant_id),
          ],
        )) as Array<{ tenant_id: string }>;
        transferredTenants = inserted.map((r) => r.tenant_id);
        const insertedSet = new Set(transferredTenants);
        for (const r of owned) {
          if (!insertedSet.has(r.tenant_id))
            skipped.push({ assignmentId: r.id, reason: 'concurrent_assignment' });
        }
      }

      const [{ c: remaining }] = (await m.query(
        `SELECT COUNT(*)::int AS c FROM sales_clinic_assignments
          WHERE sales_user_id = $1 AND ended_at IS NULL`,
        [fromEmployeeId],
      )) as Array<{ c: number }>;

      return { transferredTenants, skipped, remaining };
    });

    if (out.transferredTenants.length > 0) {
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_ASSIGNMENT_TRANSFERRED,
        userId: actorUserId,
        entityType: 'SalesEmployee',
        entityId: fromEmployeeId,
        tenantId:
          out.transferredTenants.length === 1
            ? out.transferredTenants[0]
            : undefined,
        before: { fromEmployeeId },
        after: {
          toEmployeeId: dto.toEmployeeId,
          transferred: out.transferredTenants.length,
          tenantIds: out.transferredTenants.slice(0, SALES_BULK_MAX),
        },
      });
    }

    return {
      requested: wantAll
        ? out.transferredTenants.length + out.skipped.length
        : requestedIds.length,
      transferred: out.transferredTenants.length,
      skipped: out.skipped,
      remaining: out.remaining,
    };
  }
}
