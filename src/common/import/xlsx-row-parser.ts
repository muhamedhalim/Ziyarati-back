import type ExcelJSType from 'exceljs';

import { AppError, ErrorCode } from '../errors';
import type { UploadedFileLike } from '../../modules/storage/uploads.controller';
import {
  assertMagicBytes,
  extensionMatchesMimeForPolicy,
  policyAllowsMime,
  type UploadPolicy,
} from '../../modules/storage/storage.constants';
import {
  assertZipInflationBounded,
  ZipInflationError,
} from './zip-inflation-bound';

/**
 * Shared `.xlsx` parsing for the owner-facing Excel imports (customers,
 * services). Extracted from `CustomerImportService` so every import applies the
 * same upload policy — size cap, MIME + extension + magic-byte agreement, row
 * caps — instead of each feature re-implementing (and drifting from) it.
 *
 * Nothing here touches the database or knows what a "customer" or "service" is:
 * it turns a workbook into `{ headerIndex, dataRows }`, and helpers turn cells
 * into trimmed strings. Field validation stays with each import service.
 */

export interface XlsxImportColumn {
  /** DTO field this column maps to. */
  field: string;
  /** Recognized header labels (lower-cased, trimmed) — first alias is canonical (used in the template). */
  headers: readonly string[];
  required: boolean;
}

export interface XlsxParseOptions {
  policy: UploadPolicy;
  columns: readonly XlsxImportColumn[];
  maxBytes: number;
  /** Data rows accepted (blank rows are skipped, not counted). */
  maxRows: number;
  /** Physical worksheet rows we are willing to iterate over. */
  scanRowCeiling: number;
  /** RL-06: total bytes the workbook may inflate to. Default {@link XLSX_MAX_UNCOMPRESSED_BYTES}. */
  maxUncompressedBytes?: number;
}

/**
 * RL-06 — an import workbook of a few thousand rows inflates to a few MB of
 * XML; 16 MiB leaves wide headroom (embedded images are stored, not
 * re-inflated, and count once) while keeping what `exceljs` then builds in
 * memory far below the API task's 1 GB.
 */
export const XLSX_MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
/** A normal workbook has a few dozen parts; this only stops pathological archives. */
export const XLSX_MAX_ZIP_ENTRIES = 1000;

export interface XlsxDataRow {
  /** 1-based spreadsheet row number (header is row 1). */
  rowNumber: number;
  cells: Map<number, unknown>;
}

export interface XlsxParsedSheet {
  headerIndex: Map<string, number>;
  dataRows: XlsxDataRow[];
}

/**
 * `exceljs` is required lazily so the boot path and the queue worker process
 * (which never handles an upload) never pay for loading it.
 */
export function loadExcelJs(): typeof ExcelJSType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('exceljs') as typeof ExcelJSType;
}

export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function cellToString(value: unknown): string | undefined {
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
    if (v.result !== undefined) return cellToString(v.result);
    return undefined;
  }
  return String(value);
}

/** Maps every recognised column of a data row to its trimmed string (`undefined` when blank). */
export function extractRow(
  headerIndex: Map<string, number>,
  cells: Map<number, unknown>,
): Record<string, string | undefined> {
  const raw: Record<string, string | undefined> = {};
  for (const [field, colNumber] of headerIndex) {
    raw[field] = cellToString(cells.get(colNumber))?.trim() || undefined;
  }
  return raw;
}

const TRUE_TOKENS = new Set(['true', 'yes', 'y', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', '0']);

export function parseBooleanCell(
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

/** Validates the upload and reads the first worksheet into header-indexed rows. */
export async function parseXlsxRows(
  file: UploadedFileLike | undefined,
  opts: XlsxParseOptions,
): Promise<XlsxParsedSheet> {
  const { policy, columns, maxBytes, maxRows, scanRowCeiling } = opts;

  if (!file) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: 'No file uploaded. Send the file under the field name "file".',
    });
  }
  if (file.size > maxBytes) {
    throw new AppError(ErrorCode.FILE_TOO_LARGE, {
      message: `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
    });
  }
  if (!policyAllowsMime(policy, file.mimetype)) {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
      message: 'Only .xlsx Excel files are supported.',
    });
  }
  if (
    !extensionMatchesMimeForPolicy(file.originalname, file.mimetype, policy)
  ) {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
      message:
        'The file extension does not match its declared type (.xlsx expected).',
    });
  }
  assertMagicBytes(file.buffer, file.mimetype);

  // RL-06: bound the INFLATED size before exceljs builds the whole workbook —
  // the row ceiling below runs only after that, too late to protect memory.
  try {
    assertZipInflationBounded(file.buffer, {
      maxUncompressedBytes:
        opts.maxUncompressedBytes ?? XLSX_MAX_UNCOMPRESSED_BYTES,
      maxEntries: XLSX_MAX_ZIP_ENTRIES,
    });
  } catch (err) {
    if (!(err instanceof ZipInflationError)) throw err;
    throw err.reason === 'too_large' || err.reason === 'too_many_entries'
      ? new AppError(ErrorCode.FILE_TOO_LARGE, {
          message:
            'The workbook expands to more data than this import can process. Remove unused sheets, formatting or images, or split the file.',
          cause: err,
        })
      : new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
          message: 'The file could not be read as a valid Excel workbook.',
          cause: err,
        });
  }

  const ExcelJS = loadExcelJs();
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
  if (worksheet.rowCount > scanRowCeiling) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: `The worksheet reports ${worksheet.rowCount} rows, which exceeds what this tool can process. Remove empty rows/formatting or split the file.`,
    });
  }

  const headerRow = worksheet.getRow(1);
  const headerIndex = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const label = cellToString(cell.value)?.trim().toLowerCase();
    if (!label) return;
    const column = columns.find((c) => c.headers.includes(label));
    if (column && !headerIndex.has(column.field)) {
      headerIndex.set(column.field, colNumber);
    }
  });

  const missingRequired = columns.filter(
    (c) => c.required && !headerIndex.has(c.field),
  );
  if (missingRequired.length) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: `Missing required column(s): ${missingRequired
        .map((c) => titleCase(c.headers[0]))
        .join(', ')}. Download the template for the expected format.`,
    });
  }

  const dataRows: XlsxDataRow[] = [];
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

    if (dataRows.length >= maxRows) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `The file has more than ${maxRows} data rows. Split it into smaller files and import in batches.`,
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
