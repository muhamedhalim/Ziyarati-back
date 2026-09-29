import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { Service } from '../../entities/Services/Service';
import { ServiceCategory } from '../../entities/Services/ServiceCategory';
import { AppError, mapTypeOrmError } from '../../common/errors';
import {
  extractRow,
  loadExcelJs,
  parseBooleanCell,
  parseXlsxRows,
  titleCase,
} from '../../common/import/xlsx-row-parser';
import type { UploadedFileLike } from '../storage/uploads.controller';
import { CreateServiceDto } from './dto/create-service.dto';
import { ServiceService } from './service.service';
import {
  SERVICE_IMPORT_COLUMNS,
  SERVICE_IMPORT_MAX_BYTES,
  SERVICE_IMPORT_MAX_ROWS,
  SERVICE_IMPORT_SCAN_ROW_CEILING,
  SERVICE_IMPORT_UPLOAD_POLICY,
} from './service-import.constants';

export interface ServiceImportRowData {
  name?: string;
  description?: string;
  durationMinutes?: number;
  pricingType?: string;
  basePrice?: number;
  /** Category NAME as written in the sheet — resolved to an id server-side, never trusted as an id. */
  category?: string;
  isActive?: boolean;
}

export interface ServiceImportRowResult {
  /** 1-based spreadsheet row number (header is row 1). */
  row: number;
  valid: boolean;
  errors: string[];
  data: ServiceImportRowData;
}

export interface ServiceImportPreviewResult {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  rows: ServiceImportRowResult[];
}

export interface ServiceImportCommitResult {
  totalRows: number;
  imported: number;
  rejected: number;
  errors: { row: number; messages: string[] }[];
}

/** Sheet columns whose value has to be a number — a bad one gets a friendly message instead of the DTO's. */
const NUMERIC_FIELDS = ['durationMinutes', 'basePrice'] as const;

/**
 * Bulk service-catalog import from an uploaded `.xlsx`.
 *
 * Mirrors `CustomerImportService`: synchronous parse → validate → write, with
 * every write going through `ServiceService.create` (tenant scope, category
 * checks, unique name, public slug) — no second implementation of those rules.
 * A category is matched BY NAME against this tenant's active categories; it is
 * never created implicitly, and a sheet can never point at another tenant's
 * category because only this tenant's rows are ever looked up.
 */
@Injectable()
export class ServiceImportService {
  private readonly logger = new Logger('ServiceImportService');

  constructor(
    @InjectRepository(Service)
    private readonly services: Repository<Service>,
    @InjectRepository(ServiceCategory)
    private readonly categories: Repository<ServiceCategory>,
    private readonly serviceService: ServiceService,
  ) {}

  /** Parses + validates an uploaded workbook. Never writes to the database. */
  async validateFile(
    tenantId: string,
    file: UploadedFileLike | undefined,
  ): Promise<ServiceImportPreviewResult> {
    return (await this.validateWithIds(tenantId, file)).preview;
  }

  /**
   * Re-parses and re-validates the file — a prior preview is never trusted —
   * then creates every still-valid row. One row's failure is reported, never
   * allowed to abort the rows already written.
   */
  async commit(
    tenantId: string,
    file: UploadedFileLike | undefined,
  ): Promise<ServiceImportCommitResult> {
    const { preview, categoryIds } = await this.validateWithIds(tenantId, file);

    let imported = 0;
    const errors: { row: number; messages: string[] }[] = [];

    for (const row of preview.rows) {
      if (!row.valid) {
        errors.push({ row: row.row, messages: row.errors });
        continue;
      }
      try {
        const dto = plainToInstance(CreateServiceDto, {
          name: row.data.name,
          description: row.data.description,
          durationMinutes: row.data.durationMinutes,
          pricingType: row.data.pricingType,
          basePrice: row.data.basePrice,
          categoryId: categoryIds.get(row.row),
          isActive: row.data.isActive,
        });
        await this.serviceService.create(tenantId, dto);
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

    const sheet = workbook.addWorksheet('Services');
    sheet.addRow(SERVICE_IMPORT_COLUMNS.map((c) => titleCase(c.headers[0])));
    sheet.getRow(1).font = { bold: true };
    sheet.addRow([
      'Deep cleaning',
      'Full mouth scaling and polishing',
      45,
      'FIXED',
      250,
      '',
      'yes',
    ]);
    sheet.columns.forEach((col) => {
      col.width = 24;
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.addRow(['Column', 'Required', 'Notes']);
    notes.getRow(1).font = { bold: true };
    for (const c of SERVICE_IMPORT_COLUMNS) {
      notes.addRow([
        titleCase(c.headers[0]),
        c.required ? 'Yes' : 'No',
        this.noteFor(c.field),
      ]);
    }
    notes.columns.forEach((col) => {
      col.width = 40;
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // ── Validation ───────────────────────────────────────────────────────

  private async validateWithIds(
    tenantId: string,
    file: UploadedFileLike | undefined,
  ): Promise<{
    preview: ServiceImportPreviewResult;
    /** sheet row number → resolved category id (only rows that named a category). */
    categoryIds: Map<number, string>;
  }> {
    const { headerIndex, dataRows } = await parseXlsxRows(file, {
      policy: SERVICE_IMPORT_UPLOAD_POLICY,
      columns: SERVICE_IMPORT_COLUMNS,
      maxBytes: SERVICE_IMPORT_MAX_BYTES,
      maxRows: SERVICE_IMPORT_MAX_ROWS,
      scanRowCeiling: SERVICE_IMPORT_SCAN_ROW_CEILING,
    });

    const categoryByName = await this.loadCategories(tenantId);
    const categoryIds = new Map<number, string>();
    const rows: ServiceImportRowResult[] = [];
    const seenNames = new Map<string, number>();

    for (const { rowNumber, cells } of dataRows) {
      const errors: string[] = [];
      const raw = extractRow(headerIndex, cells);
      const badFields = new Set<string>();

      const numbers: Record<string, number | undefined> = {};
      for (const field of NUMERIC_FIELDS) {
        const text = raw[field];
        if (text === undefined) continue;
        const n = Number(text);
        if (!Number.isFinite(n)) {
          errors.push(`${field}: "${text}" is not a number`);
          badFields.add(field);
        } else {
          numbers[field] = n;
        }
      }

      const data: ServiceImportRowData = {
        name: raw.name,
        description: raw.description,
        durationMinutes: numbers.durationMinutes,
        pricingType: raw.pricingType?.toUpperCase(),
        basePrice: numbers.basePrice,
        category: raw.category,
        isActive: parseBooleanCell(raw.isActive, 'active', errors),
      };

      const classErrors = await validate(
        plainToInstance(CreateServiceDto, data),
      );
      errors.push(...this.flattenErrors(classErrors, badFields));

      if (data.name) {
        const firstRow = seenNames.get(data.name);
        if (firstRow) {
          errors.push(
            `Duplicate name — already used by row ${firstRow} in this file`,
          );
        } else {
          seenNames.set(data.name, rowNumber);
        }
      }

      if (data.category) {
        const category = categoryByName.get(data.category.toLowerCase());
        if (!category) {
          errors.push(
            `Category "${data.category}" does not exist — create it first or leave the cell empty`,
          );
        } else if (!category.is_active) {
          errors.push(`Category "${data.category}" is inactive`);
        } else {
          categoryIds.set(rowNumber, category.id);
        }
      }

      rows.push({ row: rowNumber, valid: errors.length === 0, errors, data });
    }

    await this.flagExistingInDatabase(tenantId, rows);

    return {
      preview: {
        totalRows: rows.length,
        validCount: rows.filter((r) => r.valid).length,
        invalidCount: rows.filter((r) => !r.valid).length,
        rows,
      },
      categoryIds,
    };
  }

  /** This tenant's categories keyed by lower-cased name (a clinic has a handful, so one query). */
  private async loadCategories(
    tenantId: string,
  ): Promise<Map<string, ServiceCategory>> {
    const list = await this.categories.find({
      where: { tenant: { id: tenantId } },
    });
    return new Map(list.map((c) => [c.name.trim().toLowerCase(), c]));
  }

  /**
   * One bulk `IN (...)` query for names already in this tenant's catalog —
   * `ServiceService.create`'s own unique-name check stays the real backstop
   * against a race between preview and commit.
   */
  private async flagExistingInDatabase(
    tenantId: string,
    rows: ServiceImportRowResult[],
  ): Promise<void> {
    const names = [
      ...new Set(
        rows
          .filter((r) => r.valid)
          .map((r) => r.data.name)
          .filter((v): v is string => !!v),
      ),
    ];
    if (!names.length) return;

    const existing = await this.services.find({
      where: { tenant: { id: tenantId }, name: In(names) },
      select: { name: true },
    });
    const taken = new Set(existing.map((s) => s.name));
    for (const row of rows) {
      if (row.valid && row.data.name && taken.has(row.data.name)) {
        row.errors.push('A service with this name already exists');
        row.valid = false;
      }
    }
  }

  private flattenErrors(
    errors: ValidationError[],
    skipProperties: ReadonlySet<string>,
  ): string[] {
    const out: string[] = [];
    for (const err of errors) {
      if (skipProperties.has(err.property)) continue;
      if (err.constraints) out.push(...Object.values(err.constraints));
      if (err.children?.length)
        out.push(...this.flattenErrors(err.children, skipProperties));
    }
    return out;
  }

  private messageFor(err: unknown, row: number): string {
    if (err instanceof AppError) return err.message;
    if (err instanceof QueryFailedError) return mapTypeOrmError(err).message;
    this.logger.error(`Unexpected error importing row ${row}`, err as Error);
    return 'This row could not be imported due to an unexpected error.';
  }

  private noteFor(field: string): string {
    switch (field) {
      case 'name':
        return "Must be unique among this clinic's services.";
      case 'durationMinutes':
        return 'Whole minutes, at least 1.';
      case 'pricingType':
        return '"FIXED" (uses Price) or "VARIABLE" (priced per booking). Defaults to FIXED.';
      case 'basePrice':
        return 'A number, 0 or more, up to 2 decimals.';
      case 'category':
        return 'Name of an existing, active category. Leave empty for none.';
      case 'isActive':
        return '"yes" or "no". Defaults to yes.';
      default:
        return '';
    }
  }
}
