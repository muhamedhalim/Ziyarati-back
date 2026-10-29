import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, QueryFailedError } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { Customer } from '../../entities/CRM/Customer';
import { AppError, mapTypeOrmError } from '../../common/errors';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CustomerService } from './customer.service';
import { UploadedFileLike } from '../storage/uploads.controller';
import {
  extractRow,
  loadExcelJs,
  parseBooleanCell,
  parseXlsxRows,
  titleCase,
} from '../../common/import/xlsx-row-parser';
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
 * `phone` ALONE is never treated as a duplicate signal, matching `Customer`'s
 * documented schema (see `entities/CRM/Customer.ts`) — `email` and
 * `national_id` are checked, both in-file and against the tenant's existing
 * live customers. A row whose phone AND name match an existing patient is
 * refused by `CustomerService.create` itself (CRM-DUP-01) and reported as that
 * row's error, so re-importing the same sheet does not double every patient.
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
    const { headerIndex, dataRows } = await parseXlsxRows(file, {
      policy: CUSTOMER_IMPORT_UPLOAD_POLICY,
      columns: CUSTOMER_IMPORT_COLUMNS,
      maxBytes: CUSTOMER_IMPORT_MAX_BYTES,
      maxRows: CUSTOMER_IMPORT_MAX_ROWS,
      scanRowCeiling: CUSTOMER_IMPORT_SCAN_ROW_CEILING,
    });

    const rows: CustomerImportRowResult[] = [];
    const seenEmails = new Map<string, number>();
    const seenNationalIds = new Map<string, number>();

    for (const { rowNumber, cells } of dataRows) {
      const errors: string[] = [];
      const raw = extractRow(headerIndex, cells);

      const marketingOptIn = parseBooleanCell(
        raw.marketing_opt_in,
        'marketing_opt_in',
        errors,
      );
      const hasChronicDiseases = parseBooleanCell(
        raw.has_chronic_diseases,
        'has_chronic_diseases',
        errors,
      );
      const hasHealthInsurance = parseBooleanCell(
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
          { source: 'import' },
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
    const ExcelJS = loadExcelJs();
    const workbook = new ExcelJS.Workbook();

    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(CUSTOMER_IMPORT_COLUMNS.map((c) => titleCase(c.headers[0])));
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
        titleCase(c.headers[0]),
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
    const emailSet = new Set(
      existingEmails.flatMap((c) => (c.email ? [c.email.toLowerCase()] : [])),
    );
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
}
