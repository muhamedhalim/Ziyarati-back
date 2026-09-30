import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PassThrough } from 'node:stream';

import { AppError, ErrorCode } from '../../common/errors';
import {
  extractRow,
  loadExcelJs,
  parseXlsxRows,
} from '../../common/import/xlsx-row-parser';
import { escapeSpreadsheetRow } from '../../common/import/spreadsheet-escape';
import type { UploadedFileLike } from '../storage/uploads.controller';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';

import {
  ImportAssignmentsDto,
  QueryAssignmentsExportDto,
} from './dto/sales-import-dtos';
import {
  SALES_EXPORT_PAGE_SIZE,
  SALES_IMPORT_APPLICABLE,
  SALES_IMPORT_AUDIT_IDS_MAX,
  SALES_IMPORT_MAX_BYTES,
  SALES_IMPORT_MAX_ROWS,
  SALES_IMPORT_ROW_STATUS,
  SALES_IMPORT_SCAN_ROW_CEILING,
  SALES_IMPORT_UPLOAD_POLICY,
} from './platform-sales.constants';
import type { SalesImportRowStatus } from './platform-sales.constants';
import { isUniqueViolation, SalesAssignmentService } from './sales-assignment.service';
import { SalesEmployeeService } from './sales-employee.service';
import {
  ImportClinic,
  ImportLookups,
  ImportOwner,
  ParsedImportRow,
  RawImportRow,
  SALES_IMPORT_COLUMNS,
  classifyImportRows,
  countByStatus,
  parseImportRow,
} from './sales-import.util';
import type {
  SalesAssignSkipped,
  SalesImportPreview,
  SalesImportResult,
  SalesImportRow,
} from './sales.types';

/** What a write-time skip means for an import row. */
const LATE_SKIP_STATUS: Record<SalesAssignSkipped['reason'], SalesImportRowStatus> = {
  clinic_not_found: 'not_found',
  clinic_rejected: 'clinic_rejected',
  already_assigned_to_employee: 'already_yours',
  assigned_to_other: 'assigned_to_other',
  acquisition_already_credited: 'acquisition_already_credited',
  concurrent_assignment: 'concurrent_assignment',
};

const EXPORT_COLUMNS = [
  // The first four are the import template's own headers, so an export of ONE
  // employee's active clinics can be edited and uploaded straight back.
  { key: 'clinic_slug', header: 'clinic_slug' },
  { key: 'clinic_id', header: 'clinic_id' },
  { key: 'kind', header: 'kind' },
  { key: 'note', header: 'note' },
  { key: 'clinic_name', header: 'clinic_name' },
  { key: 'clinic_status', header: 'clinic_status' },
  { key: 'employee_email', header: 'employee_email' },
  { key: 'employee_name', header: 'employee_name' },
  { key: 'assignment_status', header: 'assignment_status' },
  { key: 'assigned_at', header: 'assigned_at' },
  { key: 'ended_at', header: 'ended_at' },
  { key: 'end_reason', header: 'end_reason' },
] as const;

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/**
 * Excel import / export of clinic assignments.
 *
 * The import is TEMPLATE → PREVIEW → COMMIT and never trusts an earlier step:
 * the commit re-parses the file and re-classifies every row inside its own
 * transaction, then hands the applicable rows to `assignBatch` — the same
 * set-based write the bulk-assign endpoint uses, which re-reads ownership
 * under lock. The file is parsed in memory and never stored; the employee comes
 * from the route; clinics are looked up, never created.
 *
 * Cost does not grow per row: one employee check + three bulk lookups (clinics,
 * current owners, acquisition credit) for the file, then one INSERT.
 */
@Injectable()
export class SalesAssignmentImportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly employees: SalesEmployeeService,
    private readonly assignments: SalesAssignmentService,
    private readonly audit: PlatformAdminAuditService,
  ) {}

  // ─────────────────────────────── Template ──────────────────────────────── //

  async buildTemplate(): Promise<Buffer> {
    const ExcelJS = loadExcelJs();
    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet('Assignments');
    sheet.addRow(SALES_IMPORT_COLUMNS.map((c) => c.headers[0]));
    sheet.getRow(1).font = { bold: true };
    sheet.addRow(['replace-with-clinic-slug', '', 'managed', 'Optional note']);
    sheet.columns.forEach((col) => {
      col.width = 30;
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.addRow(['Column', 'Required', 'Notes']);
    notes.getRow(1).font = { bold: true };
    notes.addRow([
      'clinic_slug',
      'Yes*',
      'The clinic\'s slug (lower-case letters, digits and dashes). *Give clinic_slug, clinic_id, or both.',
    ]);
    notes.addRow([
      'clinic_id',
      'Yes*',
      'The clinic\'s id (UUID). When both are given they must point at the same clinic.',
    ]);
    notes.addRow([
      'kind',
      'No',
      '"managed" (portfolio assignment) or "acquired" (this employee brought the clinic in — counts toward new-clinics targets, granted once per clinic ever). Blank uses the default chosen at upload.',
    ]);
    notes.addRow(['note', 'No', `Up to 500 characters.`]);
    notes.addRow([]);
    notes.addRow([
      'The employee comes from the page you upload on, not from the file.',
    ]);
    notes.addRow([
      `Up to ${SALES_IMPORT_MAX_ROWS} rows per file. Clinics are never created; unknown slugs are reported.`,
    ]);
    notes.addRow([
      'Delete the example row before uploading. Uploading the same file again is safe: clinics already assigned are reported and left alone.',
    ]);
    notes.columns.forEach((col) => {
      col.width = 44;
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // ─────────────────────────────── Preview ───────────────────────────────── //

  /** Validates only. Nothing is written. */
  async preview(
    employeeId: string,
    file: UploadedFileLike | undefined,
    dto: ImportAssignmentsDto,
  ): Promise<SalesImportPreview> {
    await this.employees.requireEmployee(employeeId, { requireActive: true });
    const onConflict = dto.onConflict ?? 'skip';
    const parsed = await this.readRows(file, dto.defaultKind ?? 'managed');

    const lookups = await this.loadLookups(this.dataSource, parsed);
    const rows = classifyImportRows(parsed, lookups, { employeeId, onConflict });

    const counts = countByStatus(rows, SALES_IMPORT_ROW_STATUS);
    return {
      totalRows: rows.length,
      counts,
      willApply: counts.will_assign + counts.will_reassign,
      rows,
    };
  }

  // ─────────────────────────────── Commit ────────────────────────────────── //

  async commit(
    employeeId: string,
    file: UploadedFileLike | undefined,
    dto: ImportAssignmentsDto,
    actorUserId: string,
  ): Promise<SalesImportResult> {
    const onConflict = dto.onConflict ?? 'skip';
    // Checked before the (CPU-heavy) parse so a bad employee id is the same 404
    // as everywhere else, and re-checked inside the write transaction below.
    await this.employees.requireEmployee(employeeId, { requireActive: true });
    const parsed = await this.readRows(file, dto.defaultKind ?? 'managed');

    let classified: SalesImportRow[];
    let late: Map<string, SalesAssignSkipped['reason']>;
    let assigned = 0;
    let reassigned = 0;
    let assignedTenantIds: string[] = [];
    let previousOwnerIds: string[] = [];
    try {
      ({ classified, late, assigned, reassigned, assignedTenantIds, previousOwnerIds } =
        await this.dataSource.transaction(async (m) => {
          await this.employees.requireEmployee(employeeId, {
            manager: m,
            requireActive: true,
          });
          // Re-validated here, inside the write transaction — a preview is never trusted.
          const lookups = await this.loadLookups(m, parsed);
          const rows = classifyImportRows(parsed, lookups, {
            employeeId,
            onConflict,
          });
          const apply = rows.filter(
            (r) => SALES_IMPORT_APPLICABLE.has(r.status) && r.clinic,
          );
          if (apply.length === 0) {
            return {
              classified: rows,
              late: new Map<string, SalesAssignSkipped['reason']>(),
              assigned: 0,
              reassigned: 0,
              assignedTenantIds: [] as string[],
              previousOwnerIds: [] as string[],
            };
          }
          const { result, previousOwners } = await this.assignments.assignBatch(m, {
            employeeId,
            items: apply.map((r) => ({
              tenantId: r.clinic!.id,
              kind: r.kind,
              note: r.note,
            })),
            onConflict,
            actorUserId,
          });
          const lateSkips = new Map(
            result.skipped.map((s) => [s.tenantId, s.reason] as const),
          );
          return {
            classified: rows,
            late: lateSkips,
            assigned: result.assigned,
            reassigned: result.reassigned,
            assignedTenantIds: apply
              .map((r) => r.clinic!.id)
              .filter((id) => !lateSkips.has(id)),
            previousOwnerIds: [...new Set(Object.values(previousOwners))],
          };
        }));
    } catch (err) {
      // Only the acquired-credit index can race past the ON CONFLICT guard.
      if (isUniqueViolation(err)) {
        throw new AppError(ErrorCode.SALES_CLINIC_ALREADY_ASSIGNED, {
          cause: err,
        });
      }
      throw err;
    }

    const errors: SalesImportRow[] = [];
    let alreadyYours = 0;
    for (const row of classified) {
      let status = row.status;
      const lateReason = row.clinic ? late.get(row.clinic.id) : undefined;
      if (SALES_IMPORT_APPLICABLE.has(status) && lateReason) {
        status = LATE_SKIP_STATUS[lateReason];
      } else if (SALES_IMPORT_APPLICABLE.has(status)) {
        continue; // applied
      }
      if (status === 'already_yours') {
        alreadyYours += 1;
        continue;
      }
      errors.push({
        ...row,
        status,
        message:
          status === row.status
            ? row.message
            : 'The clinic changed hands while the import was running',
      });
    }

    if (assigned > 0) {
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.SALES_IMPORT_COMMITTED,
        userId: actorUserId,
        entityType: 'SalesEmployee',
        entityId: employeeId,
        before:
          previousOwnerIds.length > 0
            ? { previousOwnerEmployeeIds: previousOwnerIds }
            : undefined,
        after: {
          onConflict,
          totalRows: classified.length,
          assigned,
          reassigned,
          alreadyYours,
          skipped: errors.length,
          tenantIds: assignedTenantIds.slice(0, SALES_IMPORT_AUDIT_IDS_MAX),
        },
      });
    }

    return {
      totalRows: classified.length,
      assigned,
      reassigned,
      alreadyYours,
      skipped: errors.length,
      errors,
    };
  }

  // ─────────────────────────────── Export ────────────────────────────────── //

  /**
   * Streams assignments into an `.xlsx` a keyset page at a time, so memory
   * holds one page of rows however large the export is. Every cell is
   * formula-escaped (SEC-05): a clinic or employee name starting with `=` must
   * not run when an admin opens the file.
   */
  async exportAssignments(
    query: QueryAssignmentsExportDto,
    pageSize: number = SALES_EXPORT_PAGE_SIZE,
  ): Promise<{ buffer: Buffer; rowCount: number }> {
    if (query.employeeId) await this.employees.requireEmployee(query.employeeId);
    const status = query.status ?? 'active';

    const filters: string[] = ['t.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.employeeId) {
      params.push(query.employeeId);
      filters.push(`a.sales_user_id = $${params.length}::uuid`);
    }
    if (status === 'active') filters.push('a.ended_at IS NULL');
    if (status === 'ended') filters.push('a.ended_at IS NOT NULL');

    const ExcelJS = loadExcelJs();
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      out.on('end', resolve);
      out.on('error', reject);
    });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: out,
      useStyles: false,
      useSharedStrings: false,
    });
    const sheet = workbook.addWorksheet('Assignments');
    sheet.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key }));

    let rowCount = 0;
    let cursor: [string, string, string] | null = null;
    for (;;) {
      const pageParams: unknown[] = [...params];
      const pageFilters = [...filters];
      if (cursor) {
        pageParams.push(cursor[0], cursor[1], cursor[2]);
        const n = pageParams.length;
        pageFilters.push(
          `(t.slug, a.assigned_at, a.id) > ($${n - 2}::text, $${n - 1}::timestamptz, $${n}::uuid)`,
        );
      }
      pageParams.push(pageSize);
      const rows = (await this.dataSource.query(
        `SELECT a.id, a.kind, a.note, a.assigned_at, a.ended_at, a.end_reason,
                a.assigned_at::text AS assigned_key,
                t.id AS tenant_id, t.slug, t.name, t.approval_status,
                u.email, u.full_name
           FROM sales_clinic_assignments a
           INNER JOIN tenants t ON t.id = a.tenant_id
           LEFT JOIN users u ON u.id = a.sales_user_id
          WHERE ${pageFilters.join(' AND ')}
          ORDER BY t.slug, a.assigned_at, a.id
          LIMIT $${pageParams.length}`,
        pageParams,
      )) as Array<{
        id: string;
        kind: string;
        note: string | null;
        assigned_at: Date | string;
        ended_at: Date | string | null;
        end_reason: string | null;
        assigned_key: string;
        tenant_id: string;
        slug: string;
        name: string;
        approval_status: string;
        email: string | null;
        full_name: string | null;
      }>;

      for (const r of rows) {
        sheet
          .addRow(
            escapeSpreadsheetRow({
              clinic_slug: r.slug,
              clinic_id: r.tenant_id,
              kind: r.kind,
              note: r.note ?? '',
              clinic_name: r.name,
              clinic_status: r.approval_status,
              employee_email: r.email ?? '',
              employee_name: r.full_name ?? '',
              assignment_status: r.ended_at ? 'ended' : 'active',
              assigned_at: iso(r.assigned_at) ?? '',
              ended_at: iso(r.ended_at) ?? '',
              end_reason: r.end_reason ?? '',
            }),
          )
          .commit();
        rowCount += 1;
      }
      if (rows.length < pageSize) break;
      const last = rows[rows.length - 1];
      cursor = [last.slug, last.assigned_key, last.id];
    }

    sheet.commit();
    await workbook.commit();
    out.end();
    await done;
    return { buffer: Buffer.concat(chunks), rowCount };
  }

  // ─────────────────────────────── Internals ─────────────────────────────── //

  private async readRows(
    file: UploadedFileLike | undefined,
    defaultKind: 'acquired' | 'managed',
  ): Promise<ParsedImportRow[]> {
    const { headerIndex, dataRows } = await parseXlsxRows(file, {
      policy: SALES_IMPORT_UPLOAD_POLICY,
      columns: SALES_IMPORT_COLUMNS,
      maxBytes: SALES_IMPORT_MAX_BYTES,
      maxRows: SALES_IMPORT_MAX_ROWS,
      scanRowCeiling: SALES_IMPORT_SCAN_ROW_CEILING,
    });
    if (!headerIndex.has('slug') && !headerIndex.has('id')) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message:
          'Missing column: clinic_slug (or clinic_id). Download the template for the expected format.',
      });
    }
    return dataRows.map((d) => {
      const raw = extractRow(headerIndex, d.cells);
      const row: RawImportRow = {
        row: d.rowNumber,
        slug: raw.slug,
        id: raw.id,
        kind: raw.kind,
        note: raw.note,
      };
      return parseImportRow(row, defaultKind);
    });
  }

  /** Three bulk lookups for the whole file, however many rows it has. */
  private async loadLookups(
    runner: EntityManager | DataSource,
    rows: readonly ParsedImportRow[],
  ): Promise<ImportLookups> {
    const live = rows.filter((r) => !r.error);
    const slugs = [...new Set(live.flatMap((r) => (r.slug ? [r.slug] : [])))];
    const ids = [...new Set(live.flatMap((r) => (r.id ? [r.id] : [])))];

    const bySlug = new Map<string, ImportClinic>();
    const byId = new Map<string, ImportClinic>();
    if (slugs.length || ids.length) {
      const tenants = (await runner.query(
        `SELECT id, name, slug, approval_status FROM tenants
          WHERE deleted_at IS NULL
            AND (slug = ANY($1::text[]) OR id = ANY($2::uuid[]))`,
        [slugs, ids],
      )) as Array<{ id: string; name: string; slug: string; approval_status: string }>;
      for (const t of tenants) {
        const clinic: ImportClinic = {
          id: t.id,
          name: t.name,
          slug: t.slug,
          approvalStatus: t.approval_status,
        };
        bySlug.set(t.slug.toLowerCase(), clinic);
        byId.set(t.id.toLowerCase(), clinic);
      }
    }

    const activeOwner = new Map<string, ImportOwner>();
    const credited = new Set<string>();
    const resolved = [...byId.keys()];
    if (resolved.length) {
      const owners = (await runner.query(
        `SELECT a.tenant_id, a.sales_user_id, COALESCE(u.full_name, u.email) AS name
           FROM sales_clinic_assignments a
           LEFT JOIN users u ON u.id = a.sales_user_id
          WHERE a.tenant_id = ANY($1::uuid[]) AND a.ended_at IS NULL`,
        [resolved],
      )) as Array<{ tenant_id: string; sales_user_id: string; name: string | null }>;
      for (const o of owners) {
        activeOwner.set(o.tenant_id, { employeeId: o.sales_user_id, name: o.name });
      }

      if (live.some((r) => r.kind === 'acquired')) {
        const rowsCredited = (await runner.query(
          `SELECT tenant_id FROM sales_clinic_assignments
            WHERE tenant_id = ANY($1::uuid[]) AND kind = 'acquired'`,
          [resolved],
        )) as Array<{ tenant_id: string }>;
        for (const r of rowsCredited) credited.add(r.tenant_id);
      }
    }

    return { bySlug, byId, activeOwner, credited };
  }
}
