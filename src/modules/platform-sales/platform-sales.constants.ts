import type { UploadPolicy } from '../storage/storage.constants';

/** Most clinics one bulk request may touch (assign / end / transfer / import commit). */
export const SALES_BULK_MAX = 200;

export const SALES_PAGE_SIZE_DEFAULT = 20;
export const SALES_PAGE_SIZE_MAX = 100;

/**
 * Sort allow-lists. Column names are NEVER taken from the client: a DTO
 * `@IsIn(...)` admits only these keys and the service maps each to a fixed SQL
 * fragment (same pattern as `TENANT_USAGE_SORTABLE` in platform-usage).
 */
export const SALES_EMPLOYEE_SORTABLE = [
  'name',
  'assigned',
  'lastActivity',
  'createdAt',
] as const;
export type SalesEmployeeSort = (typeof SALES_EMPLOYEE_SORTABLE)[number];

export const SALES_PICKER_SORTABLE = ['name', 'createdAt'] as const;
export type SalesPickerSort = (typeof SALES_PICKER_SORTABLE)[number];

export const SALES_PORTFOLIO_SORTABLE = [
  'assignedAt',
  'name',
  'lastActivity',
] as const;
export type SalesPortfolioSort = (typeof SALES_PORTFOLIO_SORTABLE)[number];

export const SALES_SORT_DIRECTIONS = ['ASC', 'DESC'] as const;
export type SalesSortDirection = (typeof SALES_SORT_DIRECTIONS)[number];

/** `assignment` filter of the clinic picker. */
export const SALES_PICKER_ASSIGNMENT = ['unassigned', 'assigned', 'any'] as const;
export type SalesPickerAssignment = (typeof SALES_PICKER_ASSIGNMENT)[number];

/** `status` filter of an employee's portfolio. */
export const SALES_PORTFOLIO_STATUS = ['active', 'ended', 'all'] as const;
export type SalesPortfolioStatus = (typeof SALES_PORTFOLIO_STATUS)[number];

/** What to do with a clinic that another employee already owns. */
export const SALES_ON_CONFLICT = ['skip', 'reassign'] as const;
export type SalesOnConflict = (typeof SALES_ON_CONFLICT)[number];

/** Why a clinic was NOT assigned by a bulk request. Stable, machine-readable. */
export const SALES_SKIP_REASON = [
  'clinic_not_found',
  'clinic_rejected',
  'already_assigned_to_employee',
  'assigned_to_other',
  'acquisition_already_credited',
  'concurrent_assignment',
] as const;
export type SalesSkipReason = (typeof SALES_SKIP_REASON)[number];

/** Widest month range one targets request may cover. */
export const SALES_TARGET_RANGE_MAX_MONTHS = 24;

/** Longest free-text reason accepted on a target change. */
export const SALES_REASON_MAX = 500;

/** Largest value a target / bonus amount may take (`numeric(14,2)` holds 12 integer digits). */
export const SALES_AMOUNT_MAX = 999_999_999_999.99;

/** Highest achievement threshold (%) a bonus rule may use (`numeric(6,2)`). */
export const SALES_THRESHOLD_PCT_MAX = 1000;

/** Longest note / prospect name an activity may carry (`sales_activities` columns). */
export const SALES_ACTIVITY_NOTE_MAX = 1000;
export const SALES_ACTIVITY_PROSPECT_MAX = 200;

/**
 * An activity may not be dated in the future — but the admin's browser clock can
 * run a little ahead of the server's, so a few minutes of skew are tolerated.
 */
export const SALES_ACTIVITY_FUTURE_SKEW_MS = 5 * 60_000;

/** Older than this is treated as a data-entry slip (a mistyped year), not a real backfill. */
export const SALES_ACTIVITY_MAX_AGE_DAYS = 730;

// ─────────────────────────── Excel import / export ─────────────────────────── //

/** `.xlsx` only, MIME + extension + magic-byte agreement (same policy as the clinic-side imports). */
export const SALES_IMPORT_UPLOAD_POLICY: UploadPolicy = {
  name: 'Excel sales assignment import',
  allowedTypes: [
    {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extensions: ['xlsx'],
    },
  ],
  requireMagicBytes: true,
  requireExtensionMatch: true,
};

/** Data rows one import may carry. Set-based writes make this cheap; measured in Phase 7. */
export const SALES_IMPORT_MAX_ROWS = 2000;

/** Hard cap on the uploaded file. */
export const SALES_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Physical worksheet rows we are willing to iterate (formatting can inflate `rowCount`). */
export const SALES_IMPORT_SCAN_ROW_CEILING = SALES_IMPORT_MAX_ROWS * 20 + 1;

/** Longest note a row may carry (`sales_clinic_assignments.note`). */
export const SALES_IMPORT_NOTE_MAX = 500;

/**
 * What an import row resolved to. Stable, machine-readable — the UI translates
 * them. `will_*` rows are applied by a commit; every other status is reported
 * and skipped (`already_yours` is a harmless no-op, the rest are errors).
 */
export const SALES_IMPORT_ROW_STATUS = [
  'will_assign',
  'will_reassign',
  'already_yours',
  'assigned_to_other',
  'acquisition_already_credited',
  'not_found',
  'clinic_rejected',
  'duplicate_in_file',
  'invalid_identifier',
  'invalid_kind',
  'invalid_note',
  'slug_id_mismatch',
  /** Lost a race at write time: another admin took the clinic between validation and commit. */
  'concurrent_assignment',
] as const;
export type SalesImportRowStatus = (typeof SALES_IMPORT_ROW_STATUS)[number];

/** Statuses a commit applies. */
export const SALES_IMPORT_APPLICABLE: ReadonlySet<SalesImportRowStatus> = new Set([
  'will_assign',
  'will_reassign',
]);

/** Filter of the assignments export. */
export const SALES_EXPORT_STATUS = ['active', 'ended', 'all'] as const;
export type SalesExportStatus = (typeof SALES_EXPORT_STATUS)[number];

/** Rows fetched per keyset page while streaming the export. */
export const SALES_EXPORT_PAGE_SIZE = 1000;

/** Most tenant ids an import audit entry lists (the assignment rows are the durable record). */
export const SALES_IMPORT_AUDIT_IDS_MAX = SALES_BULK_MAX;
