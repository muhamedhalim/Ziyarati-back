import type { XlsxImportColumn } from '../../common/import/xlsx-row-parser';
import type { UploadPolicy } from '../storage/storage.constants';

/**
 * Excel service-catalog import. Same upload policy machinery as the customer
 * import (`.xlsx` only, MIME + extension + magic-byte agreement); the workbook is
 * parsed in memory and never stored.
 */
export const SERVICE_IMPORT_UPLOAD_POLICY: UploadPolicy = {
  name: 'Excel service import',
  allowedTypes: [
    {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extensions: ['xlsx'],
    },
  ],
  requireMagicBytes: true,
  requireExtensionMatch: true,
};

function positiveNumberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Hard cap on the source file. Override with `SERVICE_IMPORT_MAX_BYTES`. */
export const SERVICE_IMPORT_MAX_BYTES = positiveNumberFromEnv(
  'SERVICE_IMPORT_MAX_BYTES',
  5 * 1024 * 1024,
);

/**
 * Data rows per import. Synchronous single-request flow, like the customer
 * import — a clinic's catalog is tens to low hundreds of services, so no job
 * queue. Override with `SERVICE_IMPORT_MAX_ROWS`.
 */
export const SERVICE_IMPORT_MAX_ROWS = positiveNumberFromEnv(
  'SERVICE_IMPORT_MAX_ROWS',
  500,
);

/** Physical-row scan ceiling (see `CUSTOMER_IMPORT_SCAN_ROW_CEILING`). */
export const SERVICE_IMPORT_SCAN_ROW_CEILING = SERVICE_IMPORT_MAX_ROWS * 20 + 1;

/**
 * Column header → `CreateServiceDto` field. Header matching is
 * case-insensitive and whitespace-trimmed; the first alias is canonical (used
 * in the template). Keep in sync with `ServiceImportService.buildTemplate()`.
 */
export const SERVICE_IMPORT_COLUMNS: readonly XlsxImportColumn[] = [
  { field: 'name', headers: ['name', 'service name'], required: true },
  { field: 'description', headers: ['description'], required: false },
  {
    field: 'durationMinutes',
    headers: ['duration (minutes)', 'duration minutes', 'duration'],
    required: true,
  },
  { field: 'pricingType', headers: ['pricing type'], required: false },
  {
    field: 'basePrice',
    headers: ['price', 'base price'],
    required: false,
  },
  { field: 'category', headers: ['category'], required: false },
  {
    field: 'isActive',
    headers: ['active', 'is active'],
    required: false,
  },
] as const;
