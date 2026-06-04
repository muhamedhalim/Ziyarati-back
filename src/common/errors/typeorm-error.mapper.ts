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
  INVALID_TEXT_REPRESENTATION: '22P02', // e.g. malformed uuid / bad enum value
} as const;

/**
 * Friendly, client-safe messages keyed by DB constraint name. This is the ONLY
 * place a constraint name maps to a public message — the constraint name itself
 * is never sent to the client. Add entries as new constraints appear.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  uq_user_tenant_email: 'Email already exists in this tenant',
  uq_superadmin_email: 'A super-admin with this email already exists',
  uq_role_tenant_slug: 'A role with this slug already exists',
};

/**
 * Converts a TypeORM QueryFailedError into a clean AppError. The original error
 * is preserved as `cause` for server-side logging; no SQL, table, or constraint
 * detail leaks into the resulting client message.
 */
export function mapTypeOrmError(error: QueryFailedError): AppError {
  const driver = error as unknown as PgDriverError;

  switch (driver.code) {
    case PG.UNIQUE_VIOLATION:
      return new AppError(ErrorCode.UNIQUE_VIOLATION, {
        message: driver.constraint
          ? CONSTRAINT_MESSAGES[driver.constraint]
          : undefined,
        cause: error,
      });

    case PG.FOREIGN_KEY_VIOLATION:
      return new AppError(ErrorCode.FOREIGN_KEY_VIOLATION, { cause: error });

    case PG.NOT_NULL_VIOLATION:
      return new AppError(ErrorCode.NOT_NULL_VIOLATION, {
        // Column == API field name, safe to surface; helps the caller fix input.
        message: driver.column
          ? `Required field "${driver.column}" is missing`
          : undefined,
        context: driver.column ? { field: driver.column } : undefined,
        cause: error,
      });

    case PG.INVALID_TEXT_REPRESENTATION:
      return new AppError(ErrorCode.BAD_REQUEST, {
        message: 'One or more values have an invalid format',
        cause: error,
      });

    case PG.CHECK_VIOLATION:
      return new AppError(ErrorCode.BAD_REQUEST, {
        message: 'A value violates a data constraint',
        cause: error,
      });

    default:
      // Unknown DB failure — generic message, full detail goes to logs only.
      return new AppError(ErrorCode.DATABASE_ERROR, { cause: error });
  }
}
