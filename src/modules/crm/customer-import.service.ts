import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import type ExcelJSType from 'exceljs';

import { Customer } from '../../entities/CRM/Customer';
import { AppError, ErrorCode, mapTypeOrmError } from '../../common/errors';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CustomerService } from './customer.service';
import { UploadedFileLike } from '../storage/uploads.controller';
import {
  assertMagicBytes,
  extensionMatchesMimeForPolicy,
  policyAllowsMime,
} from '../storage/storage.constants';
import {
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_IMPORT_MAX_BYTES,
  CUSTOMER_IMPORT_MAX_ROWS,
  CUSTOMER_IMPORT_SCAN_ROW_CEILING,
  CUSTOMER_IMPORT_UPLOAD_POLICY,
} from './customer-import.constants';

export interface CustomerImportRowData {
  full_name?: string;
  phone?: string;
  email?: string;
  national_id?: string;
  gender?: string;
  date_of_birth?: string;
  preferred_locale?: string;
  source?: string;
  marketing_opt_in?: boolean;
  has_chronic_diseases?: boolean;
  chronic_diseases?: string;
  has_health_insurance?: boolean;
}

export interface CustomerImportRowResult {
  /** 1-based spreadsheet row number (header is row 1), for the user to find the row in Excel. */
  row: number;
  valid: boolean;
  errors: string[];
  data: CustomerImportRowData;
}

export interface CustomerImportPreviewResult {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  rows: CustomerImportRowResult[];
}

export interface CustomerImportCommitResult {
  totalRows: number;
  imported: number;
  rejected: number;
  errors: { row: number; messages: string[] }[];
}

const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0']);

/**
 * Bulk customer import from an uploaded `.xlsx` file.
 *
 * Deliberately synchronous (parse → validate → write, all within one HTTP
 * request) rather than an async job — `CUSTOMER_IMPORT_MAX_ROWS` keeps that
 * bounded and cheap. Writes go through `CustomerService.create` — the exact
 * same tenant scoping, plan-cap check and email/national_id uniqueness rules
 * as the manual "Add customer" endpoint. There is no separate storage path
 * and no separate business-rule implementation: this module only parses a
 * spreadsheet into `CreateCustomerDto`-shaped rows and drives the existing
 * service, row by row, so a failure on one row can never affect another.
 *
 * `phone` is intentionally NEVER treated as a duplicate signal, matching
 * `Customer`'s documented schema (see `entities/CRM/Customer.ts`) — only
 * `email` and `national_id` are checked, both in-file and against the
 * tenant's existing live customers.
 */
@Injectable()
export class CustomerImportService {
  private readonly logger = new Logger('CustomerImportService');

  constructor(
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    private readonly customerService: CustomerService,
  ) {}

  /** Parses + validates an uploaded workbook. Never writes to the database. */
  async validateFile(
    tenantId: string,
    file: UploadedFileLike | undefined,
  ): Promise<CustomerImportPreviewResult> {
    const { headerIndex, dataRows } = await this.parseWorkbook(file);

    const rows: CustomerImportRowResult[] = [];
    const seenEmails = new Map<string, number>();
    const seenNationalIds = new Map<string, number>();

    for (const { rowNumber, cells } of dataRows) {
      const errors: string[] = [];
      const raw = this.extractRow(headerIndex, cells);

      const marketingOptIn = this.parseBoolean(
        raw.marketing_opt_in,
        'marketing_opt_in',
        errors,
      );
      const hasChronicDiseases = this.parseBoolean(
        raw.has_chronic_diseases,
        'has_chronic_diseases',
        errors,
      );
      const hasHealthInsurance = this.parseBoolean(
        raw.has_health_insurance,
        'has_health_insurance',
        errors,
      );

      const data: CustomerImportRowData = {
        full_name: raw.full_name,
        phone: raw.phone,
        email: raw.email?.toLowerCase(),
        national_id: raw.national_id,
        gender: raw.gender,
        date_of_birth: raw.date_of_birth,
        preferred_locale: raw.preferred_locale?.toLowerCase(),
        source: raw.source,
        marketing_opt_in: marketingOptIn,
        has_chronic_diseases: hasChronicDiseases,
        chronic_diseases: raw.chronic_diseases,
        has_health_insurance: hasHealthInsurance,
      };

      const instance = plainToInstance(CreateCustomerDto, data);
      const classErrors = await validate(instance);
      errors.push(...this.flattenErrors(classErrors));

      if (data.email) {
        const firstRow = seenEmails.get(data.email);
        if (firstRow) {
          errors.push(
            `Duplicate email — already used by row ${firstRow} in this file`,
          );
        } else {
          seenEmails.set(data.email, rowNumber);
        }
      }
      if (data.national_id) {
        const key = data.national_id.toLowerCase();
        const firstRow = seenNationalIds.get(key);
        if (firstRow) {
          errors.push(
            `Duplicate ID number — already used by row ${firstRow} in this file`,
          );
        } else {
          seenNationalIds.set(key, rowNumber);
        }
      }

      rows.push({ row: rowNumber, valid: errors.length === 0, errors, data });
    }

    await this.flagExistingInDatabase(tenantId, rows);

    return {
      totalRows: rows.length,
      validCount: rows.filter((r) => r.valid).length,
      invalidCount: rows.filter((r) => !r.valid).length,
      rows,
    };
  }

  /**
   * Re-parses and re-validates the file — a prior `validateFile` preview is
   * never trusted as-is — then imports every row that is still valid. One
   * row's failure (a lost uniqueness race, an unexpected error) is caught and
   * reported, never allowed to abort or roll back the rows already written.
   */
  async commit(
    tenantId: string,
    file: UploadedFileLike | undefined,
  ): Promise<CustomerImportCommitResult> {
    const preview = await this.validateFile(tenantId, file);

    let imported = 0;
    const errors: { row: number; messages: string[] }[] = [];

    for (const row of preview.rows) {
      if (!row.valid) {
        errors.push({ row: row.row, messages: row.errors });
        continue;
      }
      try {
        await this.customerService.create(
          tenantId,
          row.data as CreateCustomerDto,
        );
        imported += 1;
      } catch (err) {
        errors.push({
          row: row.row,
          messages: [this.messageFor(err, row.row)],
        });
      }
    }

    return {
      totalRows: preview.totalRows,
      imported,
      rejected: preview.totalRows - imported,
      errors,
    };
  }

  /** Generates the downloadable `.xlsx` template (header row, one example row, an instructions sheet). */
  async buildTemplate(): Promise<Buffer> {
    const ExcelJS = this.loadExcelJs();
    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(
      CUSTOMER_IMPORT_COLUMNS.map((c) => this.titleCase(c.headers[0])),
    );
    sheet.getRow(1).font = { bold: true };
    sheet.addRow([
      'Sara Al-Otaibi',
      '+966500000000',
      'sara@example.com',
      '1234567890',
      'female',
      '1990-05-20',
      'ar',
      'walk_in',
      'no',
      'no',
      '',
      'no',
    ]);
    sheet.columns.forEach((col) => {
      col.width = 22;
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.addRow(['Column', 'Required', 'Notes']);
    notes.getRow(1).font = { bold: true };
    for (const c of CUSTOMER_IMPORT_COLUMNS) {
      notes.addRow([
        this.titleCase(c.headers[0]),
        c.required ? 'Yes' : 'No',
        this.noteFor(c.field),
      ]);
    }
    notes.columns.forEach((col) => {
      col.width = 34;
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ── Parsing ──────────────────────────────────────────────────────────

  private async parseWorkbook(file: UploadedFileLike | undefined): Promise<{
    headerIndex: Map<string, number>;
    dataRows: { rowNumber: number; cells: Map<number, unknown> }[];
  }> {
    if (!file) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'No file uploaded. Send the file under the field name "file".',
      });
    }
    if (file.size > CUSTOMER_IMPORT_MAX_BYTES) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE, {
        message: `File exceeds the ${Math.round(CUSTOMER_IMPORT_MAX_BYTES / 1024 / 1024)} MB limit.`,
      });
    }
    if (!policyAllowsMime(CUSTOMER_IMPORT_UPLOAD_POLICY, file.mimetype)) {
      throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
        message: 'Only .xlsx Excel files are supported.',
      });
    }
    if (
      !extensionMatchesMimeForPolicy(
        file.originalname,
        file.mimetype,
        CUSTOMER_IMPORT_UPLOAD_POLICY,
      )
    ) {
      throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
        message:
          'The file extension does not match its declared type (.xlsx expected).',
      });
    }
    assertMagicBytes(file.buffer, file.mimetype);

    const ExcelJS = this.loadExcelJs();
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as unknown as ExcelJSType.Buffer);
    } catch (err) {
      throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
        message: 'The file could not be read as a valid Excel workbook.',
        cause: err,
      });
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'The workbook has no worksheets.',
      });
    }
    if (worksheet.rowCount > CUSTOMER_IMPORT_SCAN_ROW_CEILING) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `The worksheet reports ${worksheet.rowCount} rows, which exceeds what this tool can process. Remove empty rows/formatting or split the file.`,
      });
    }

    const headerRow = worksheet.getRow(1);
    const headerIndex = new Map<string, number>();
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const label = this.cellToString(cell.value)?.trim().toLowerCase();
      if (!label) return;
      const column = CUSTOMER_IMPORT_COLUMNS.find((c) =>
        c.headers.includes(label),
      );
      if (column && !headerIndex.has(column.field)) {
        headerIndex.set(column.field, colNumber);
      }
    });

    const missingRequired = CUSTOMER_IMPORT_COLUMNS.filter(
      (c) => c.required && !headerIndex.has(c.field),
    );
    if (missingRequired.length) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Missing required column(s): ${missingRequired
          .map((c) => this.titleCase(c.headers[0]))
          .join(', ')}. Download the template for the expected format.`,
      });
    }

    const dataRows: { rowNumber: number; cells: Map<number, unknown> }[] = [];
    for (let r = 2; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const cells = new Map<number, unknown>();
      let hasAny = false;
      for (const colNumber of headerIndex.values()) {
        const value = row.getCell(colNumber).value;
        if (
          value !== null &&
          value !== undefined &&
          String(value).trim() !== ''
        ) {
          hasAny = true;
        }
        cells.set(colNumber, value);
      }
      if (!hasAny) continue;

      if (dataRows.length >= CUSTOMER_IMPORT_MAX_ROWS) {
        throw new AppError(ErrorCode.BAD_REQUEST, {
          message: `The file has more than ${CUSTOMER_IMPORT_MAX_ROWS} data rows. Split it into smaller files and import in batches.`,
        });
      }
      dataRows.push({ rowNumber: r, cells });
    }

    if (dataRows.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'The file has no data rows.',
      });
    }

    return { headerIndex, dataRows };
  }

  private extractRow(
    headerIndex: Map<string, number>,
    cells: Map<number, unknown>,
  ): Record<string, string | undefined> {
    const raw: Record<string, string | undefined> = {};
    for (const [field, colNumber] of headerIndex) {
      raw[field] = this.cellToString(cells.get(colNumber))?.trim() || undefined;
    }
    return raw;
  }

  private cellToString(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (value instanceof Date) {
      // UTC components — Excel serial dates carry no timezone, and reading
      // local components back could shift the day depending on host TZ.
      const y = value.getUTCFullYear();
      const m = String(value.getUTCMonth() + 1).padStart(2, '0');
      const d = String(value.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    if (typeof value === 'object') {
      const v = value as {
        text?: string;
        result?: unknown;
        richText?: { text: string }[];
      };
      if (typeof v.text === 'string') return v.text;
      if (Array.isArray(v.richText))
        return v.richText.map((r) => r.text).join('');
      if (v.result !== undefined) return this.cellToString(v.result);
      return undefined;
    }
    return String(value);
  }

  private parseBoolean(
    value: string | undefined,
    field: string,
    errors: string[],
  ): boolean | undefined {
    if (value === undefined) return undefined;
    const token = value.trim().toLowerCase();
    if (TRUE_TOKENS.has(token)) return true;
    if (FALSE_TOKENS.has(token)) return false;
    errors.push(`${field}: must be yes/no, true/false or 1/0`);
    return undefined;
  }

  private flattenErrors(errors: ValidationError[]): string[] {
    const out: string[] = [];
    for (const err of errors) {
      if (err.constraints) out.push(...Object.values(err.constraints));
      if (err.children?.length) out.push(...this.flattenErrors(err.children));
    }
    return out;
  }

  /**
   * Bulk pre-check against the tenant's existing LIVE customers — two bulk
   * `IN (...)` queries regardless of row count (bounded by
   * `CUSTOMER_IMPORT_MAX_ROWS`), not one query per row. This is what lets the
   * preview accurately show "already exists" before the user commits;
   * `commit()` still re-validates and `CustomerService.create`'s own checks
   * remain the real backstop against a race between preview and commit.
   */
  private async flagExistingInDatabase(
    tenantId: string,
    rows: CustomerImportRowResult[],
  ): Promise<void> {
    const candidates = rows.filter((r) => r.valid);
    const emails = [
      ...new Set(
        candidates.map((r) => r.data.email).filter((v): v is string => !!v),
      ),
    ];
    const nationalIds = [
      ...new Set(
        candidates
          .map((r) => r.data.national_id)
          .filter((v): v is string => !!v),
      ),
    ];

    const [existingEmails, existingNationalIds] = await Promise.all([
      emails.length
        ? this.customers.find({
            where: { tenant: { id: tenantId }, email: In(emails) },
            select: { email: true },
          })
        : Promise.resolve([]),
      nationalIds.length
        ? this.customers.find({
            where: { tenant: { id: tenantId }, national_id: In(nationalIds) },
            select: { national_id: true },
          })
        : Promise.resolve([]),
    ]);
    const emailSet = new Set(existingEmails.map((c) => c.email.toLowerCase()));
    const nationalIdSet = new Set(
      existingNationalIds.map((c) => (c.national_id ?? '').toLowerCase()),
    );

    for (const row of rows) {
      if (!row.valid) continue;
      if (row.data.email && emailSet.has(row.data.email)) {
        row.errors.push('A customer with this email already exists');
        row.valid = false;
      }
      if (
        row.data.national_id &&
        nationalIdSet.has(row.data.national_id.toLowerCase())
      ) {
        row.errors.push('A customer with this ID number already exists');
        row.valid = false;
      }
    }
  }

  private messageFor(err: unknown, row: number): string {
    if (err instanceof AppError) return err.message;
    if (err instanceof QueryFailedError) return mapTypeOrmError(err).message;
    this.logger.error(`Unexpected error importing row ${row}`, err as Error);
    return 'This row could not be imported due to an unexpected error.';
  }

  private titleCase(s: string): string {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private noteFor(field: string): string {
    switch (field) {
      case 'phone':
        return 'Not required to be unique — multiple customers may share one.';
      case 'email':
        return "Must be unique among this clinic's customers.";
      case 'national_id':
        return "Optional; unique among this clinic's customers when provided.";
      case 'date_of_birth':
        return 'Format: YYYY-MM-DD.';
      case 'preferred_locale':
        return '"en" or "ar".';
      case 'marketing_opt_in':
      case 'has_chronic_diseases':
      case 'has_health_insurance':
        return '"yes" or "no".';
      case 'chronic_diseases':
        return 'Required when "Has Chronic Diseases" is yes.';
      default:
        return '';
    }
  }

  /**
   * `exceljs` is required lazily so the boot path and the queue worker
   * process (which never handles an upload) never pay for loading it —
   * mirrors `GuestAttachmentExtractionService`'s lazy `pdf-parse` require.
   */
  private loadExcelJs(): typeof ExcelJSType {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('exceljs') as typeof ExcelJSType;
  }
}
