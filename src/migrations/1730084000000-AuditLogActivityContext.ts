import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clinic-wide Activity log (US14 follow-up) — gives `audit_logs` the two
 * context fields the Activity surface needs and could not previously answer,
 * plus the two missing filter indexes.
 *
 * WHY THESE TWO COLUMNS, AND ONLY THESE TWO:
 *
 *  1. `branchId` — `ActivityLogService`'s own docblock already documented
 *     `branchId` as part of contracts/clinic-surfaces.md F14's response
 *     shape, noted that `audit_logs` had no branch column, and therefore
 *     omitted the key from every row rather than fabricating one. "Which
 *     branch was involved?" is a first-class question of a multi-branch
 *     clinic's audit log, so the column now exists and writers populate it
 *     where the action genuinely has a branch. Nullable: plenty of
 *     legitimate actions (a role change, a campaign launch) have no branch,
 *     and a fabricated one would be worse than none.
 *
 *  2. `entity_label` — a SHORT, NON-SENSITIVE human label for the affected
 *     resource, so the Activity page can say "Appointment · Dr. Sara Ali"
 *     instead of only a UUID, and so search has something human to match.
 *     This is the smallest schema addition that makes the log readable and
 *     searchable; the alternative (searching `old_values`/`new_values` JSONB)
 *     was rejected on two counts — it produces poor query plans, and those
 *     columns deliberately hold values that FR-U008 forbids surfacing.
 *
 * SECURITY: `entity_label` is written by audit writers, never by user input,
 * and is documented at every call site as non-sensitive only — no patient
 * names, no contact details, no clinical content. It is sized at 160 chars
 * so it cannot become a smuggling channel for a large payload.
 *
 * INDEXES: the existing `IDX_audit_logs_tenant_created` and
 * `IDX_audit_logs_tenant_action_created` (1730062000000) remain exactly as
 * they are — they still drive the default newest-first page and the action
 * filter. Added here are the two filter predicates that had NO index at all:
 * actor (`userId`) and branch. Both are ordered `("tenantId", <col>,
 * "created_at" DESC)` so a filtered page is an index-ordered scan rather
 * than a filter-then-sort.
 *
 * `CONCURRENTLY` + `transaction = false`, matching
 * `AuditLogIndexes1730062000000`'s reasoning exactly: `audit_logs` is written
 * on hot paths by a dozen services, so a locking index build would stall
 * authentication and payments. The `ALTER TABLE ... ADD COLUMN` statements
 * are safe to run unlocked — a nullable column with no default is a metadata
 * -only change in modern Postgres and does not rewrite the table.
 */
export class AuditLogActivityContext1730084000000 implements MigrationInterface {
  name = 'AuditLogActivityContext1730084000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "branchId" uuid`,
    );
    await q.query(
      `ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "entity_label" varchar(160)`,
    );

    // ON DELETE SET NULL: deleting a branch must never destroy the audit
    // history of what happened at it. The row survives, having simply
    // forgotten which branch it was — the same "history outlives the entity"
    // rule `entity_id` already follows (it is never dereferenced).
    const [fk] = await q.query(
      `SELECT 1 AS present FROM pg_constraint WHERE conname = 'FK_audit_logs_branch'`,
    );
    if (!fk) {
      await q.query(
        `ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_audit_logs_branch"
           FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL`,
      );
    }

    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_user_created" ON "audit_logs" ("tenantId", "userId", "created_at" DESC)`,
    );
    await this.assertValid(q, 'IDX_audit_logs_tenant_user_created');

    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_audit_logs_tenant_branch_created" ON "audit_logs" ("tenantId", "branchId", "created_at" DESC)`,
    );
    await this.assertValid(q, 'IDX_audit_logs_tenant_branch_created');
  }

  /** Mirrors `AuditLogIndexes1730062000000.assertValid` — a CONCURRENTLY
   *  build that fails partway leaves an INVALID index behind that the planner
   *  silently ignores, which would look like "the index exists" while every
   *  filtered page stayed a sequential scan. */
  private async assertValid(q: QueryRunner, indexName: string): Promise<void> {
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        `AuditLogActivityContext: "${indexName}" was created but is NOT valid — a CONCURRENTLY ` +
          'build failed partway. Investigate, drop the invalid index, and re-run this migration.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "IDX_audit_logs_tenant_branch_created"`,
    );
    await q.query(`DROP INDEX IF EXISTS "IDX_audit_logs_tenant_user_created"`);
    await q.query(
      `ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "FK_audit_logs_branch"`,
    );
    await q.query(
      `ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "entity_label"`,
    );
    await q.query(`ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "branchId"`);
  }
}
