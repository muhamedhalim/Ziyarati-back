import type { Logger, QueryRunner } from 'typeorm';

/**
 * Measurement-only TypeORM `Logger` implementation (specs/006-platform-performance-audit,
 * T027 / MP-database-03). Counts queries issued during a flow so N+1 and
 * duplicate-call findings carry a number, not a description (FR-DB-012).
 *
 * Used ONLY from the Jest harness (`test/perf/`) — swapped in as a
 * per-DataSource `logger` option on a test-local connection, or passed to
 * `dataSource.setOptions({ logger })` inside a spec. NEVER registered in
 * `src/config/typeorm.config.ts` or any other application runtime path
 * (Standing Rule 6).
 */
export class QueryCounterLogger implements Logger {
  private queries: string[] = [];

  get count(): number {
    return this.queries.length;
  }

  /** Full text of every query counted so far, for debugging an unexpected count. */
  get queryLog(): readonly string[] {
    return this.queries;
  }

  reset(): void {
    this.queries = [];
  }

  logQuery(query: string, _parameters?: unknown[], _queryRunner?: QueryRunner): void {
    this.queries.push(query);
  }

  // The remaining Logger methods are intentionally no-ops — this logger
  // exists to count SELECT/INSERT/UPDATE/DELETE query events only, per its
  // single stated purpose. Slow-query/error/schema/migration logging is a
  // different concern with its own existing seam (TYPEORM_LOGGING).
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}
