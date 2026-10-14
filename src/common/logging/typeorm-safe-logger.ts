import { Logger } from '@nestjs/common';
import {
  AdvancedConsoleLogger,
  type Logger as TypeOrmLogger,
  type QueryRunner,
} from 'typeorm';

import { LOG_EVENT } from './log-events';

/**
 * TypeORM logger that never writes SQL parameters or driver row values
 * (LOGGING-SECURITY-AUDIT LSA-01).
 *
 * TypeORM's own console loggers print a failing statement as
 * `query failed: <sql> -- PARAMETERS: [<every bound value>]` through plain
 * `console.log`, bypassing every redaction layer — a unique violation on a
 * patient table puts the patient's name, phone and notes on stdout. Here a
 * failed or slow query becomes ONE structured line built from an explicit
 * allow-list:
 *
 *   operation   first SQL keyword (SELECT/INSERT/…), from a closed set
 *   table       the first table the statement names, identifier-shaped only
 *   sqlstate    the driver's 5-character SQLSTATE
 *   constraint  / db_table / db_column — identifier-shaped driver metadata
 *   error_type  the error class name
 *
 * Never: the SQL text (ad-hoc literals), `parameters`, the driver `message`,
 * `detail` (`Key (x)=(<value>)`), `where`, `hint` or the error object itself.
 * The exception still propagates to the caller, so the request/job failure is
 * logged once by its owner (AllExceptionsFilter / job wrapper) as before.
 *
 * Per-statement query echo (`TYPEORM_LOGGING=true`) is a local-development aid
 * that production already refuses at boot (env.validation.ts); it is kept but
 * the parameters are dropped from it too.
 */
export type TypeOrmLogging = boolean | ('query' | 'error' | 'warn')[];

const OPERATIONS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'START',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'SHOW',
  'LOCK',
  'CALL',
  'COPY',
  'REFRESH',
  'VACUUM',
  'ANALYZE',
  'EXPLAIN',
]);

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
// `FROM "customers"`, `INTO "public"."customers"`, `UPDATE customers`, `JOIN "x" "alias"`.
const TABLE_RE =
  /\b(?:FROM|INTO|UPDATE|JOIN)\s+(?:ONLY\s+)?"?([A-Za-z_][A-Za-z0-9_$]{0,62})"?(?:\s*\.\s*"?([A-Za-z_][A-Za-z0-9_$]{0,62})"?)?/i;

export interface QueryFailureSummary {
  operation: string;
  table?: string;
  sqlstate?: string;
  constraint?: string;
  db_table?: string;
  db_column?: string;
  error_type: string;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER_RE.test(value)
    ? value
    : undefined;
}

/** First SQL keyword, upper-cased, from a closed set — anything else is `OTHER`. */
export function sqlOperation(query: unknown): string {
  if (typeof query !== 'string') return 'UNKNOWN';
  const word = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(query)?.[1];
  const op = word?.toUpperCase();
  return op && OPERATIONS.has(op) ? op : 'OTHER';
}

/** The first table a statement names, or undefined. Identifier-shaped by construction. */
export function sqlTable(query: unknown): string | undefined {
  if (typeof query !== 'string') return undefined;
  const m = TABLE_RE.exec(query.slice(0, 4_000));
  if (!m) return undefined;
  return m[2] ?? m[1];
}

/** The allow-listed, value-free description of a failed statement. */
export function describeQueryFailure(
  error: unknown,
  query: unknown,
): QueryFailureSummary {
  const out: QueryFailureSummary = {
    operation: sqlOperation(query),
    error_type: 'Error',
  };
  const table = sqlTable(query);
  if (table) out.table = table;

  // TypeORM hands the raw pg `DatabaseError` here; a wrapped QueryFailedError
  // keeps it under `driverError`.
  const err =
    error !== null && typeof error === 'object'
      ? ((error as { driverError?: unknown }).driverError ?? error)
      : undefined;
  if (error instanceof Error) {
    out.error_type = (error.name || 'Error').slice(0, 64);
  } else if (typeof error === 'string') {
    out.error_type = 'DriverError';
  }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string' && SQLSTATE_RE.test(e.code))
      out.sqlstate = e.code;
    const constraint = identifier(e.constraint);
    if (constraint) out.constraint = constraint;
    const dbTable = identifier(e.table);
    if (dbTable) out.db_table = dbTable;
    const dbColumn = identifier(e.column);
    if (dbColumn) out.db_column = dbColumn;
  }
  return out;
}

export class SafeTypeOrmLogger implements TypeOrmLogger {
  private readonly logger = new Logger('TypeORM');
  /** Only for per-statement echo, schema-build and migration messages — never for errors. */
  private readonly delegate: AdvancedConsoleLogger;
  private readonly errorsEnabled: boolean;

  constructor(logging: TypeOrmLogging) {
    this.delegate = new AdvancedConsoleLogger(logging);
    this.errorsEnabled =
      logging === true || (Array.isArray(logging) && logging.includes('error'));
  }

  logQuery(
    query: string,
    _parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    // Development-only echo (TYPEORM_LOGGING=true, refused in production):
    // statement text only, never the bound values.
    this.delegate.logQuery(query, undefined, queryRunner);
  }

  logQueryError(
    error: string | Error,
    query: string,
    _parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ): void {
    if (!this.errorsEnabled) return;
    try {
      this.logger.warn({
        event: LOG_EVENT.DATABASE_QUERY_FAILED,
        message: 'database query failed',
        ...describeQueryFailure(error, query),
      });
    } catch {
      // logging must never turn a query failure into a different failure
    }
  }

  logQuerySlow(
    time: number,
    query: string,
    _parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ): void {
    try {
      const table = sqlTable(query);
      this.logger.warn({
        event: LOG_EVENT.DATABASE_QUERY_SLOW,
        message: 'database query exceeded the slow-query threshold',
        operation: sqlOperation(query),
        ...(table ? { table } : {}),
        duration_ms: Number.isFinite(time) ? Math.round(time) : undefined,
      });
    } catch {
      // never throw from a logger
    }
  }

  logSchemaBuild(message: string, queryRunner?: QueryRunner): void {
    this.delegate.logSchemaBuild(message, queryRunner);
  }

  logMigration(message: string, queryRunner?: QueryRunner): void {
    this.delegate.logMigration(message, queryRunner);
  }

  log(
    level: 'log' | 'info' | 'warn',
    message: unknown,
    queryRunner?: QueryRunner,
  ): void {
    this.delegate.log(level, message, queryRunner);
  }
}
