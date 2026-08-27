import type {
  AllowedUploadType,
  UploadPolicy,
} from '../storage/storage.constants';

/**
 * Excel customer-import upload policy.
 *
 * A thin, feature-scoped extension of the shared upload-policy shape (see
 * `storage.constants.ts`) rather than a new one: it reuses the same
 * MIME/extension/magic-byte verification machinery
 * (`policyAllowsMime`/`extensionMatchesMimeForPolicy`/`assertMagicBytes`).
 * It does NOT live in `storage.constants.ts` itself because this feature
 * never writes to the object storage bucket — the workbook is parsed in
 * memory and discarded, never persisted — so it has nothing to do with that
 * module's "what kind of object can live in the bucket" concern.
 *
 * Only `.xlsx` (OOXML) is accepted — the only spreadsheet format the
 * `exceljs` dependency this feature adds can actually parse. Legacy `.xls`
 * and `.csv` are deliberately out of scope (req: "only Excel files supported
 * by the project's existing libraries").
 */
export const CUSTOMER_IMPORT_ALLOWED_TYPES: readonly AllowedUploadType[] = [
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
  },
] as const;

export const CUSTOMER_IMPORT_UPLOAD_POLICY: UploadPolicy = {
  name: 'Excel customer import',
  allowedTypes: CUSTOMER_IMPORT_ALLOWED_TYPES,
  requireMagicBytes: true,
  requireExtensionMatch: true,
};

/** Hard cap on the source `.xlsx` file. Override with `CUSTOMER_IMPORT_MAX_BYTES`. */
export const DEFAULT_CUSTOMER_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export function resolveCustomerImportMaxBytes(): number {
  const raw = Number(process.env.CUSTOMER_IMPORT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_CUSTOMER_IMPORT_MAX_BYTES;
}

export const CUSTOMER_IMPORT_MAX_BYTES = resolveCustomerImportMaxBytes();

/**
 * Hard cap on data rows per import. This is a synchronous, single-request
 * flow (no job queue) by design — matching the size of this tool — so the
 * cap bounds one request's parse+validate+write cost to something that
 * cannot exhaust memory or blow past a reverse-proxy timeout. Larger
 * datasets must be split into multiple files. Override with
 * `CUSTOMER_IMPORT_MAX_ROWS`.
 */
export const DEFAULT_CUSTOMER_IMPORT_MAX_ROWS = 500;

export function resolveCustomerImportMaxRows(): number {
  const raw = Number(process.env.CUSTOMER_IMPORT_MAX_ROWS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_CUSTOMER_IMPORT_MAX_ROWS;
}

export const CUSTOMER_IMPORT_MAX_ROWS = resolveCustomerImportMaxRows();

/**
 * Physical-row scan ceiling — bounds how many worksheet rows we will even
 * iterate over (not just how many end up as data rows), so a workbook with a
 * huge nominal dimension but sparse data (e.g. formatting applied across
 * thousands of otherwise-empty rows) cannot force an unbounded loop. Chosen
 * as a generous multiple of the data-row cap so ordinary blank trailing rows
 * are never a problem.
 */
export const CUSTOMER_IMPORT_SCAN_ROW_CEILING =
  CUSTOMER_IMPORT_MAX_ROWS * 20 + 1;

export interface CustomerImportColumn {
  /** `CreateCustomerDto` field this column maps to. */
  field: string;
  /** Recognized header labels (lower-cased, trimmed) — first alias is canonical (used in the template). */
  headers: string[];
  required: boolean;
}

/**
 * Column header → `CreateCustomerDto` field map. Header matching is
 * case-insensitive and whitespace-trimmed. Keep in sync with
 * `CustomerImportService.buildTemplate()`'s generated header row.
 */
export const CUSTOMER_IMPORT_COLUMNS: readonly CustomerImportColumn[] = [
  { field: 'full_name', headers: ['full name', 'name'], required: false },
  { field: 'phone', headers: ['phone', 'phone number'], required: true },
  { field: 'email', headers: ['email', 'email address'], required: true },
  {
    field: 'national_id',
    headers: ['national id', 'id number'],
    required: false,
  },
  { field: 'gender', headers: ['gender'], required: false },
  {
    field: 'date_of_birth',
    headers: ['date of birth', 'dob', 'birth date'],
    required: false,
  },
  {
    field: 'preferred_locale',
    headers: ['preferred language', 'language', 'locale'],
    required: false,
  },
  {
    field: 'source',
    headers: ['source', 'acquisition source'],
    required: false,
  },
  {
    field: 'marketing_opt_in',
    headers: ['marketing opt-in', 'marketing opt in'],
    required: false,
  },
  {
    field: 'has_chronic_diseases',
    headers: ['has chronic diseases', 'chronic diseases?'],
    required: false,
  },
  {
    field: 'chronic_diseases',
    headers: ['chronic disease details', 'chronic diseases details'],
    required: false,
  },
  {
    field: 'has_health_insurance',
    headers: ['has health insurance', 'health insurance?'],
    required: false,
  },
] as const;
