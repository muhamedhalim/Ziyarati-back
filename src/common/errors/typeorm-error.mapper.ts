import { QueryFailedError } from 'typeorm';
import { AppError } from './app-error';
import { ErrorCode } from './error-code';

/**
 * Shape of the underlying `pg` driver error carried by a QueryFailedError.
 * All fields are optional/untyped at the TypeORM level, so we read defensively.
 */
interface PgDriverError {
  code?: string; // SQLSTATE
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

// PostgreSQL SQLSTATE codes we translate explicitly.
const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01', // EXCLUDE constraint (e.g. overlapping appointment)
  INVALID_TEXT_REPRESENTATION: '22P02', // e.g. malformed uuid / bad enum value
} as const;

/**
 * Friendly, client-safe messages keyed by DB constraint name. This is the ONLY
 * place a constraint name maps to a public message — the constraint name itself
 * is never sent to the client. Add entries as new constraints appear.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  // D7 — global active-user email uniqueness (GlobalUserEmailUniqueness
  // migration). Replaces two dead names (`uq_user_tenant_email`,
  // `uq_superadmin_email`) that no migration in this tree ever created — the
  // real pre-migration constraint is the TypeORM-generated hash below, kept
  // mapped to the same message during the migration -> deploy window (mirrors
  // the FND-040/M-01 customers-email precedent two lines down).
  uq_user_email_global: 'This email is already in use',
  UQ_7346b08032078107fce81e014f6: 'This email is already in use', // pre-migration shape
  uq_role_tenant_slug: 'A role with this slug already exists',
  appointments_no_overlap:
    'This time slot was just booked for the selected staff member. Please choose another time.',
  // FND-040/M-01: both mapped to the SAME tenant-scoped message so the
  // client-visible error is identical regardless of which shape fires during
  // the migration → backend deploy window — the new constraint
  // (UQ_customers_tenant_email) once the migration has run, or the old
  // global one (its literal name — a TypeORM-generated hash, not a
  // hand-written identifier) beforehand.
  UQ_customers_tenant_email: 'A customer with this email already exists',
  UQ_8536b8b85c06969f84f0c098b03: 'A customer with this email already exists',
  // FND-032/M-04: a second concurrent request lost the race to open a new
  // invoice for a subscription that already has one OPEN.
  UQ_sub_invoice_open_per_subscription:
    'This subscription already has an open invoice. Pay or resolve it before requesting another.',
};

/**
 * True when `error` is a Postgres UNIQUE violation (SQLSTATE 23505). Lets a
 * caller distinguish "lost an insert race / duplicate key" from other failures
 * without depending on `instanceof QueryFailedError` details at each call site.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as unknown as PgDriverError).code === PG.UNIQUE_VIOLATION
  );
}

/**
 * Converts a TypeORM QueryFailedError into a clean AppError. The original error
 * is preserved as `cause` for server-side logging; no SQL, table, or constraint
 * detail leaks into the resulting client message or `publicContext`. Every
 * branch attaches the raw SQLSTATE/constraint/table/column to `internalContext`
 * instead — visible only in logs (via `AllExceptionsFilter.writeLog`), never in
 * the API response.
 */
export function mapTypeOrmError(error: QueryFailedError): AppError {
  const driver = error as unknown as PgDriverError;

  /** Diagnostic detail for logs only — never touches the client. */
  const internalContext = (extra?: Record<string, unknown>): Record<string, unknown> => ({
    sqlState: driver.code,
    constraint: driver.constraint,
    table: driver.table,
    column: driver.column,
    detail: driver.detail,
    ...extra,
  });

  switch (driver.code) {
    case PG.UNIQUE_VIOLATION:
      return new AppError(ErrorCode.UNIQUE_VIOLATION, {
        message: driver.constraint
          ? CONSTRAINT_MESSAGES[driver.constraint]
          : undefined,
        internalContext: internalContext(),
        cause: error,
      });

    case PG.EXCLUSION_VIOLATION:
      // Overlapping appointment caught by `appointments_no_overlap` (the race
      // backstop). Surface a clean 409 so the client can re-pick a time.
      return new AppError(ErrorCode.CONFLICT, {
        message: driver.constraint
          ? CONSTRAINT_MESSAGES[driver.constraint] ?? 'The selected time is no longer available'
          : 'The selected time is no longer available',
        internalContext: internalContext(),
        cause: error,
      });

    case PG.FOREIGN_KEY_VIOLATION:
      return new AppError(ErrorCode.FOREIGN_KEY_VIOLATION, {
        internalContext: internalContext(),
        cause: error,
      });

    case PG.NOT_NULL_VIOLATION:
      return new AppError(ErrorCode.NOT_NULL_VIOLATION, {
        // Column == API field name, safe to surface; helps the caller fix input.
        message: driver.column
          ? `Required field "${driver.column}" is missing`
          : undefined,
        publicContext: driver.column ? { field: driver.column } : undefined,
        internalContext: internalContext(),
        cause: error,
      });

    case PG.INVALID_TEXT_REPRESENTATION:
      return new AppError(ErrorCode.BAD_REQUEST, {
        message: 'One or more values have an invalid format',
        internalContext: internalContext(),
        cause: error,
      });

    case PG.CHECK_VIOLATION:
      return new AppError(ErrorCode.BAD_REQUEST, {
        message: 'A value violates a data constraint',
        internalContext: internalContext(),
        cause: error,
      });

    default:
      // Unknown DB failure — generic message, full detail goes to logs only.
      return new AppError(ErrorCode.DATABASE_ERROR, {
        internalContext: internalContext(),
        cause: error,
      });
  }
}
