import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clinic-wide Activity log (US14 follow-up) — trigram search support for the
 * Activity surface's free-text `q` and its suggestions endpoint.
 *
 * WHY pg_trgm: the Activity search is an unanchored, case-insensitive
 * substring match (`ILIKE '%ah%'` must find "Ahmed"). No btree index can
 * serve a leading-wildcard pattern, so before this migration every search
 * degraded to a scan of the tenant's whole audit history. A GIN index built
 * with `gin_trgm_ops` is exactly the index Postgres's planner will use for
 * `LIKE`/`ILIKE '%…%'` — the predicate in `ActivityLogService` needs no
 * rewrite to benefit, which is why the search still works correctly (just
 * more slowly) anywhere this extension is unavailable.
 *
 * EXTENSION AVAILABILITY: follows `AiPgVector1730000000000`'s established
 * pattern — probe `pg_available_extensions` FIRST and skip cleanly when the
 * extension is absent, rather than issuing a `CREATE EXTENSION` that fails.
 * Unlike pgvector this degrades safely in production too, so there is no
 * fail-fast branch: search remains correct without the indexes, only slower,
 * and refusing to boot over a performance optimisation would be the worse
 * trade. `pg_trgm` is a core contrib module and has been a TRUSTED extension
 * since PostgreSQL 13, so a plain database owner can create it — no
 * superuser needed on managed hosts.
 *
 * WHICH COLUMNS GET AN INDEX, AND WHY NOT THE OTHERS — the search predicate
 * (`ActivityLogService.list`, and the suggestions query) matches exactly
 * four expressions, and each is judged on its own:
 *
 *   - `audit_logs.action`      → INDEXED. High cardinality relative to the
 *                                allow-list, and searching it is the single
 *                                most common case ("appoint" → every
 *                                appointment action).
 *   - `audit_logs.entity_label`→ INDEXED. Free-text human labels; this is the
 *                                column the whole feature exists to search.
 *   - `users.full_name`        → INDEXED. "Who did this?" is the primary
 *                                audit question, and the suggestions endpoint
 *                                ranks actor names by `similarity()`.
 *   - `users.email`            → INDEXED. Same reason; distinct enough from
 *                                `full_name` that one index cannot serve both.
 *   - `audit_logs.entity_type` → DELIBERATELY NOT INDEXED. It holds a dozen
 *                                short constants ('Appointment',
 *                                'ClinicalEntry', …). A trigram index over a
 *                                near-enum column is large, churns on every
 *                                audit insert, and the planner would ignore
 *                                it in favour of the tenant/date index it
 *                                already has. Cheaper to filter in memory
 *                                over the already-narrowed row set.
 *
 * `users` is indexed rather than a denormalised copy of the actor's name on
 * `audit_logs`: the name must stay correct when a user is renamed, and
 * duplicating it per audit row would be both a large write amplification and
 * a second place for PII to live.
 *
 * `CONCURRENTLY` + `transaction = false`: `audit_logs` and `users` are both
 * written on hot paths (every audited action; every login). Matches
 * `AuditLogIndexes1730062000000`. `CREATE EXTENSION` is likewise safe outside
 * a transaction.
 */
export class AuditLogTrigramSearch1730085000000 implements MigrationInterface {
  name = 'AuditLogTrigramSearch1730085000000';
  public transaction = false;

  private static readonly INDEXES: ReadonlyArray<{
    name: string;
    ddl: string;
  }> = [
    {
      name: 'IDX_audit_logs_action_trgm',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_action_trgm" ON "audit_logs" USING gin ("action" gin_trgm_ops)`,
    },
    {
      name: 'IDX_audit_logs_entity_label_trgm',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_entity_label_trgm" ON "audit_logs" USING gin ("entity_label" gin_trgm_ops)`,
    },
    {
      name: 'IDX_users_full_name_trgm',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_users_full_name_trgm" ON "users" USING gin ("full_name" gin_trgm_ops)`,
    },
    {
      name: 'IDX_users_email_trgm',
      ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_users_email_trgm" ON "users" USING gin ("email" gin_trgm_ops)`,
    },
  ];

  public async up(q: QueryRunner): Promise<void> {
    const available: unknown[] = await q.query(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm'`,
    );
    if (available.length === 0) {
      console.warn(
        '[AuditLogTrigramSearch] "pg_trgm" is not available on this Postgres server — ' +
          'skipping the Activity search trigram indexes. Activity search remains CORRECT ' +
          '(the ILIKE predicate is unchanged) but will scan rather than use an index; ' +
          'install the postgresql-contrib package to enable it.',
      );
      return;
    }

    await q.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    for (const { name, ddl } of AuditLogTrigramSearch1730085000000.INDEXES) {
      await q.query(ddl);
      await this.assertValid(q, name);
    }
  }

  /** Same guard as `AuditLogIndexes1730062000000` — an INVALID index left by a
   *  half-finished CONCURRENTLY build is silently ignored by the planner, so
   *  "the index exists" would be true while every search still scanned. */
  private async assertValid(q: QueryRunner, indexName: string): Promise<void> {
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        `AuditLogTrigramSearch: "${indexName}" was created but is NOT valid — a CONCURRENTLY ` +
          'build failed partway. Investigate, drop the invalid index, and re-run this migration.',
      );
    }
  }

  /** Drops the indexes only. The extension itself is left installed: other
   *  work may since have come to depend on it, and dropping a shared
   *  extension to reverse one feature's indexes would be a destructive
   *  side effect well outside this migration's scope. */
  public async down(q: QueryRunner): Promise<void> {
    for (const { name } of AuditLogTrigramSearch1730085000000.INDEXES) {
      await q.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
    }
  }
}
