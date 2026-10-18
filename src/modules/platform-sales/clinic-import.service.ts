import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';

import { AppError, ErrorCode } from '../../common/errors';
import {
  extractRow,
  loadExcelJs,
  parseXlsxRows,
} from '../../common/import/xlsx-row-parser';
import { Role } from '../../entities/Auth&RBAC/Role';
import { ROLE } from '../../rbac/rbac.constants';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import type { UploadedFileLike } from '../storage/uploads.controller';
import { TenantService } from '../tenant/tenant.service';

import {
  CLINIC_IMPORT_AUDIT_IDS_MAX,
  CLINIC_IMPORT_CONCURRENCY,
  CLINIC_IMPORT_MAX_BYTES,
  CLINIC_IMPORT_MAX_ROWS,
  CLINIC_IMPORT_ROW_STATUS,
  CLINIC_IMPORT_SCAN_ROW_CEILING,
  CLINIC_IMPORT_UPLOAD_POLICY,
} from './clinic-import.constants';
import type { ClinicImportConflict } from './clinic-import.constants';
import {
  CLINIC_IMPORT_COLUMNS,
  ClassifiedClinicRow,
  ClinicImportLookups,
  ClinicImportRow,
  ParsedClinicRow,
  RawClinicRow,
  classifyClinicRows,
  countClinicRows,
  parseClinicRow,
  toClinicImportRow,
} from './clinic-import.util';
import type { ClinicImportOptionsDto } from './dto/clinic-import.dto';
import {
  SalesAssignmentService,
  isUniqueViolation,
} from './sales-assignment.service';
import { SalesEmployeeService } from './sales-employee.service';

export interface ClinicImportPreview {
  totalRows: number;
  counts: Record<(typeof CLINIC_IMPORT_ROW_STATUS)[number], number>;
  /** Clinics a commit would try to create. */
  willCreate: number;
  rows: ClinicImportRow[];
}

export interface ClinicImportResult {
  /** Identifies this run in the audit trail. */
  importId: string;
  totalRows: number;
  created: number;
  skipped: number;
  failed: number;
  /** Set-password invitations actually handed to the mailer (only when requested). */
  invited: number;
  /** The final status of EVERY row: `created`, or why it was not. */
  rows: ClinicImportRow[];
}

/** Files being committed right now in this process, so a double-submit is refused outright. */
const inFlight = new Set<string>();

const OWNER_ROLE_LABEL = 'Clinic Owner';

/**
 * Platform clinic import: create NEW clinics (tenant + owner account) from an
 * Excel file, for the sales console.
 *
 * TEMPLATE → PREVIEW → COMMIT, and nothing is trusted from an earlier step: the
 * commit re-parses and re-classifies the file itself. Writes reuse the existing
 * clinic-creation building blocks — `TenantService.createInTransaction` (tenant,
 * default settings, approval event) and `AuthService.createUserWithRole` (the
 * single owner-account chokepoint, global email uniqueness included) — so an
 * imported clinic is indistinguishable from one the platform admin creates.
 *
 * Each clinic is its OWN transaction: a failing row rolls back only itself (no
 * orphan tenant or user), the rest still import, and the report says which was
 * which. The unique indexes, not the pre-check, are the guard against races and
 * re-uploads. Existing clinics are only ever REPORTED, never updated.
 *
 * No password is read from the file: the owner gets a random placeholder hash
 * nobody ever sees, and reaches the account through a set-password link (sent
 * on request) or "forgot password". No subscription, payment or credit is
 * created; the clinic starts pending verification exactly as self-signup does.
 */
@Injectable()
export class ClinicImportService {
  private readonly logger = new Logger(ClinicImportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenants: TenantService,
    private readonly auth: AuthService,
    private readonly assignments: SalesAssignmentService,
    private readonly employees: SalesEmployeeService,
    private readonly audit: PlatformAdminAuditService,
    private readonly email: EmailService,
  ) {}

  // ─────────────────────────────── Template ──────────────────────────────── //

  async buildTemplate(): Promise<Buffer> {
    const ExcelJS = loadExcelJs();
    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet('Clinics');
    sheet.addRow(CLINIC_IMPORT_COLUMNS.map((c) => c.headers[0]));
    sheet.getRow(1).font = { bold: true };
    // A deliberately INVALID example (the email is not an email): if it is left
    // in the file it is reported as an error and never creates a clinic.
    sheet.addRow([
      'Delete this example row',
      'Owner full name',
      'replace-with-owner-email',
      'CR-1010123456',
      'al-noor-clinic',
      '+966501234567',
      '',
      '',
      '',
      'SAR',
      'Asia/Riyadh',
      '',
    ]);
    sheet.columns.forEach((col) => {
      col.width = 28;
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.addRow(['Column', 'Required', 'Notes']);
    notes.getRow(1).font = { bold: true };
    const rows: Array<[string, string, string]> = [
      [
        'clinic_name',
        'Yes',
        'Display name of the clinic (max 100 characters).',
      ],
      ['owner_name', 'Yes', 'Full name of the clinic owner.'],
      [
        'owner_email',
        'Yes',
        "The owner's login email. Must not belong to any existing account.",
      ],
      [
        'commercial_registration_number',
        'Yes',
        'Commercial registration number (letters, digits, space, - . _ /).',
      ],
      [
        'clinic_slug',
        'No',
        'Lower-case letters, digits and dashes. Blank = built from the clinic name; give it when the name has no Latin letters. Cannot be changed later.',
      ],
      [
        'owner_phone',
        'No',
        'Digits with an optional leading +, up to 20 characters.',
      ],
      ['clinic_email', 'No', 'Clinic contact email. Blank = the owner email.'],
      ['clinic_phone', 'No', 'Clinic contact phone. Blank = the owner phone.'],
      ['legal_name', 'No', 'Registered business name.'],
      ['default_currency', 'No', 'Three-letter code, e.g. SAR. Blank = USD.'],
      [
        'default_timezone',
        'No',
        'IANA timezone, e.g. Asia/Riyadh. Blank = UTC.',
      ],
      [
        'sales_rep_email',
        'No',
        'Email of an ACTIVE sales employee; the new clinic is assigned to them.',
      ],
    ];
    rows.forEach((r) => notes.addRow(r));
    notes.addRow([]);
    notes.addRow([
      `Up to ${CLINIC_IMPORT_MAX_ROWS} rows per file. Every new clinic starts "pending verification", with no plan, subscription or payment.`,
    ]);
    notes.addRow([
      'Existing clinics are never changed: a row whose slug, email or registration number already exists is reported and skipped. Uploading the same file twice is safe.',
    ]);
    notes.addRow([
      'No password goes in this file. Owners set their own through the invitation link, or "forgot password".',
    ]);
    notes.addRow([
      'Delete the example row before uploading. Formulas are never evaluated.',
    ]);
    notes.columns.forEach((col) => {
      col.width = 46;
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // ─────────────────────────────── Preview ───────────────────────────────── //

  /** Validates only. Nothing is written. */
  async preview(
    file: UploadedFileLike | undefined,
  ): Promise<ClinicImportPreview> {
    const parsed = await this.readRows(file);
    const lookups = await this.loadLookups(parsed);
    const rows = classifyClinicRows(parsed, lookups);
    const counts = countClinicRows(rows, CLINIC_IMPORT_ROW_STATUS);
    return {
      totalRows: rows.length,
      counts,
      willCreate: counts.will_create,
      rows: rows.map(toClinicImportRow),
    };
  }

  // ─────────────────────────────── Commit ────────────────────────────────── //

  async commit(
    file: UploadedFileLike | undefined,
    options: ClinicImportOptionsDto,
    actorUserId: string,
  ): Promise<ClinicImportResult> {
    const parsed = await this.readRows(file);

    // The same bytes cannot be committed twice at once in this process. Across
    // processes the unique indexes still guarantee no duplicate clinic.
    const fileKey = createHash('sha256')
      .update(file!.buffer)
      .update(options.sendInvitations === 'true' ? '1' : '0')
      .digest('hex');
    if (inFlight.has(fileKey)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: 'This file is already being imported. Wait for it to finish.',
      });
    }
    inFlight.add(fileKey);
    try {
      return await this.runCommit(parsed, options, actorUserId);
    } finally {
      inFlight.delete(fileKey);
    }
  }

  private async runCommit(
    parsed: ParsedClinicRow[],
    options: ClinicImportOptionsDto,
    actorUserId: string,
  ): Promise<ClinicImportResult> {
    const importId = randomUUID();
    const kind = options.assignmentKind ?? 'acquired';
    const ownerRole = await this.dataSource.manager.findOne(Role, {
      where: { slug: ROLE.OWNER, tenant: IsNull() },
    });
    if (!ownerRole) {
      throw new AppError(ErrorCode.ROLE_NOT_FOUND, {
        message: 'The owner role is not seeded',
      });
    }

    // Re-validated here — a preview is never trusted.
    const lookups = await this.loadLookups(parsed);
    const classified = classifyClinicRows(parsed, lookups);

    const created: Array<{
      tenantId: string;
      userId: string;
      row: ClassifiedClinicRow;
    }> = [];

    // Each clinic is its own transaction and its own bcrypt hash (~0.3 s), so a
    // few run side by side: it uses the libuv pool bcrypt already runs on and at
    // most CLINIC_IMPORT_CONCURRENCY pool connections. Rows are independent (the
    // in-file duplicate check already ran), and results keep file order.
    const finalRows: ClinicImportRow[] = new Array<ClinicImportRow>(
      classified.length,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < classified.length) {
        const i = next++;
        const row = classified[i];
        if (row.status !== 'will_create' || !row.values) {
          finalRows[i] = toClinicImportRow(row);
          continue;
        }
        try {
          const ids = await this.createClinic(
            row,
            lookups.reps.get(row.values.salesRepEmail ?? '')?.id,
            kind,
            ownerRole,
            actorUserId,
          );
          created.push({ ...ids, row });
          finalRows[i] = { ...toClinicImportRow(row), status: 'created' };
        } catch (err) {
          finalRows[i] = await this.failedRow(row, err);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(CLINIC_IMPORT_CONCURRENCY, classified.length) },
        worker,
      ),
    );

    const invited =
      options.sendInvitations === 'true' ? await this.invite(created) : 0;

    const counts = countClinicRows(finalRows, CLINIC_IMPORT_ROW_STATUS);
    const result: ClinicImportResult = {
      importId,
      totalRows: finalRows.length,
      created: counts.created,
      failed: counts.failed,
      skipped: finalRows.length - counts.created - counts.failed,
      invited,
      rows: finalRows,
    };

    if (result.created > 0) {
      await this.audit.record({
        action: PLATFORM_ADMIN_AUDIT_ACTION.CLINIC_IMPORT_COMMITTED,
        userId: actorUserId,
        entityType: 'ClinicImport',
        entityId: importId,
        // Counts and ids only — no names, emails or phone numbers.
        after: {
          totalRows: result.totalRows,
          created: result.created,
          skipped: result.skipped,
          failed: result.failed,
          invitationsRequested: options.sendInvitations === 'true',
          invited,
          tenantIds: created
            .map((c) => c.tenantId)
            .slice(0, CLINIC_IMPORT_AUDIT_IDS_MAX),
        },
      });
    }
    return result;
  }

  /** One clinic = one transaction: tenant, settings, approval event, owner, role link, optional assignment. */
  private async createClinic(
    row: ClassifiedClinicRow,
    repId: string | undefined,
    kind: 'acquired' | 'managed',
    ownerRole: Role,
    actorUserId: string,
  ): Promise<{ tenantId: string; userId: string }> {
    const v = row.values!;
    return this.dataSource.transaction(async (m) => {
      const tenant = await this.tenants.createInTransaction(
        m,
        {
          name: v.clinicName,
          slug: v.slug,
          commercialRegistrationNumber: v.commercialRegistration,
          contactEmail: v.clinicEmail,
          contactPhone: v.clinicPhone,
          legalName: v.legalName,
          defaultCurrency: v.currency,
          defaultTimezone: v.timezone,
        },
        actorUserId,
      );

      // Never returned, logged or emailed: the owner reaches the account only
      // through a single-use set-password token.
      const user = await this.auth.createUserWithRole(
        m,
        {
          email: v.ownerEmail,
          password: randomBytes(24).toString('base64url'),
          fullName: v.ownerName,
          phone: v.ownerPhone,
        },
        ownerRole,
        tenant.id,
      );

      if (repId) {
        await this.employees.requireEmployee(repId, {
          manager: m,
          requireActive: true,
        });
        const { result } = await this.assignments.assignBatch(m, {
          employeeId: repId,
          items: [{ tenantId: tenant.id, kind, note: null }],
          onConflict: 'skip',
          actorUserId,
        });
        // The whole clinic rolls back rather than exist without its rep.
        if (result.assigned !== 1) {
          throw new AppError(ErrorCode.SALES_CLINIC_ALREADY_ASSIGNED);
        }
      }
      return { tenantId: tenant.id, userId: user.id };
    });
  }

  /**
   * Turns a write failure into a row status. A lost race (unique violation or
   * the shared email guard) is re-classified against the database so the report
   * names what collided; anything else is a plain `failed` and only its row
   * number and error class are logged — never the row data.
   */
  private async failedRow(
    row: ClassifiedClinicRow,
    err: unknown,
  ): Promise<ClinicImportRow> {
    const raced =
      isUniqueViolation(err) ||
      (err instanceof AppError && err.code === ErrorCode.EMAIL_ALREADY_EXISTS);
    if (raced) {
      const [again] = classifyClinicRows(
        [{ ...row, errors: [] }],
        await this.loadLookups([row]),
      );
      const conflicts: ClinicImportConflict[] = again?.conflicts ?? [];
      return {
        ...toClinicImportRow(row),
        status: 'already_exists',
        conflicts,
      };
    }
    this.logger.warn(
      `Clinic import row ${row.row} failed: ${(err as Error)?.name ?? 'Error'}`,
    );
    return { ...toClinicImportRow(row), status: 'failed' };
  }

  /** Best-effort set-password invitation per created owner; a failed mail never undoes a clinic. */
  private async invite(
    created: ReadonlyArray<{
      tenantId: string;
      userId: string;
      row: ClassifiedClinicRow;
    }>,
  ): Promise<number> {
    let sent = 0;
    for (const c of created) {
      const v = c.row.values!;
      try {
        const token = await this.auth.issuePasswordSetupToken(c.userId);
        await this.email.sendInvitation({
          to: v.ownerEmail,
          name: v.ownerName,
          clinicName: v.clinicName,
          role: OWNER_ROLE_LABEL,
          invitationUrl: this.auth.passwordSetupUrl(token),
          tenantId: c.tenantId,
          token,
        });
        sent += 1;
      } catch (err) {
        this.logger.warn(
          `Clinic import invitation for row ${c.row.row} failed: ${(err as Error)?.name ?? 'Error'}`,
        );
      }
    }
    return sent;
  }

  // ─────────────────────────────── Internals ─────────────────────────────── //

  private async readRows(
    file: UploadedFileLike | undefined,
  ): Promise<ParsedClinicRow[]> {
    const { headerIndex, dataRows } = await parseXlsxRows(file, {
      policy: CLINIC_IMPORT_UPLOAD_POLICY,
      columns: CLINIC_IMPORT_COLUMNS,
      maxBytes: CLINIC_IMPORT_MAX_BYTES,
      maxRows: CLINIC_IMPORT_MAX_ROWS,
      scanRowCeiling: CLINIC_IMPORT_SCAN_ROW_CEILING,
    });
    return dataRows.map((d) => {
      const raw = extractRow(headerIndex, d.cells);
      const row: RawClinicRow = {
        row: d.rowNumber,
        clinicName: raw.clinicName,
        ownerName: raw.ownerName,
        ownerEmail: raw.ownerEmail,
        commercialRegistration: raw.commercialRegistration,
        slug: raw.slug,
        ownerPhone: raw.ownerPhone,
        clinicEmail: raw.clinicEmail,
        clinicPhone: raw.clinicPhone,
        legalName: raw.legalName,
        currency: raw.currency,
        timezone: raw.timezone,
        salesRepEmail: raw.salesRepEmail,
      };
      return parseClinicRow(row);
    });
  }

  /**
   * Five bulk lookups for the whole file, however many rows it has. Soft-deleted
   * tenants are INCLUDED for slug and contact email: their unique indexes are
   * not partial, so those values stay taken.
   */
  private async loadLookups(
    rows: ReadonlyArray<Pick<ParsedClinicRow, 'values'>>,
  ): Promise<ClinicImportLookups> {
    const vs = rows.flatMap((r) => (r.values ? [r.values] : []));
    const uniq = (xs: string[]) => [...new Set(xs)];
    const slugs = uniq(vs.map((v) => v.slug));
    const clinicEmails = uniq(vs.map((v) => v.clinicEmail));
    const ownerEmails = uniq(vs.map((v) => v.ownerEmail));
    const registrations = uniq(
      vs.map((v) => v.commercialRegistration.toLowerCase()),
    );
    const repEmails = uniq(
      vs.flatMap((v) => (v.salesRepEmail ? [v.salesRepEmail] : [])),
    );

    const [tenantRows, userRows, repRows] = await Promise.all([
      vs.length
        ? (this.dataSource.query(
            `SELECT slug, lower(contact_email) AS contact_email,
                    lower(commercial_registration_number) AS registration,
                    deleted_at IS NULL AS live
               FROM tenants
              WHERE slug = ANY($1::text[])
                 OR lower(contact_email) = ANY($2::text[])
                 OR (deleted_at IS NULL AND lower(commercial_registration_number) = ANY($3::text[]))`,
            [slugs, clinicEmails, registrations],
          ) as Promise<
            Array<{
              slug: string;
              contact_email: string | null;
              registration: string | null;
              live: boolean;
            }>
          >)
        : Promise.resolve([]),
      vs.length
        ? (this.dataSource.query(
            `SELECT email FROM users WHERE deleted_at IS NULL AND email = ANY($1::text[])`,
            [ownerEmails],
          ) as Promise<Array<{ email: string }>>)
        : Promise.resolve([]),
      repEmails.length
        ? (this.dataSource.query(
            `SELECT u.id, lower(u.email) AS email, u.full_name
               FROM users u
              WHERE u."tenantId" IS NULL AND u.deleted_at IS NULL AND u.is_active
                AND lower(u.email) = ANY($1::text[])
                AND EXISTS (
                  SELECT 1 FROM user_roles ur
                  INNER JOIN roles r ON r.id = ur."roleId"
                  WHERE ur."userId" = u.id AND r.slug = '${ROLE.PLATFORM_SALES}' AND r."tenantId" IS NULL
                )`,
            [repEmails],
          ) as Promise<
            Array<{ id: string; email: string; full_name: string | null }>
          >)
        : Promise.resolve([]),
    ]);

    return {
      slugs: new Set(tenantRows.map((t) => t.slug)),
      clinicEmails: new Set(
        tenantRows.flatMap((t) => (t.contact_email ? [t.contact_email] : [])),
      ),
      userEmails: new Set(userRows.map((u) => u.email)),
      registrations: new Set(
        tenantRows.flatMap((t) =>
          t.live && t.registration ? [t.registration] : [],
        ),
      ),
      reps: new Map(
        repRows.map((r) => [r.email, { id: r.id, name: r.full_name }] as const),
      ),
    };
  }
}
