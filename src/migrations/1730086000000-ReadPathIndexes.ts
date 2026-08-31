import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 015-db-api-efficiency-audit — Phase P9 (T060), evidence-gated (AC-22).
 * See evidence/p9-t058-explain-captures-2026-08-31.md and
 * evidence/p9-t059-index-decision-2026-08-31.md for the full before/after
 * `EXPLAIN (ANALYZE, BUFFERS)` captures and the per-candidate decision.
 *
 * Of the four candidates this phase evaluated (IDX-001 `api_logs`, IDX-002
 * `appointments`, IDX-003 `customers`, R-03 `subscriptions`), only ONE is a
 * genuine gap:
 *
 *  - IDX-001 (`api_logs.created_at`): ALREADY EXISTS — `IX_api_logs_created`,
 *    added by `PlatformHardening1730001000000`. Measured as already in use
 *    by the planner for the query it can help; the platform's OTHER `api_logs`
 *    aggregate has no top-level `WHERE` at all (only `FILTER(...)` clauses),
 *    so no index of any shape can narrow its scan. No action.
 *  - IDX-002 (`appointments (tenant, start_at)`): genuinely missing —
 *    **added below**. `AppointmentService.findAll`'s default list (no branch
 *    filter) fetched every one of the tenant's rows and sorted them in
 *    memory; this index lets Postgres walk the sort order directly.
 *  - IDX-003 (`customers (tenant, created_at)`): ALREADY EXISTS —
 *    `IDX_customers_tenant_created`, added by
 *    `CustomerSegments1730071000000`. Already an `Index Scan Backward` in
 *    the captured plan. No action.
 *  - R-03 (`subscriptions.planId`): confirmed NOT worth indexing — the table
 *    is bounded by tenant count × renewal history, not by traffic volume;
 *    the query already costs a handful of buffer hits on a full scan. No
 *    action (matches the reasoning already recorded in
 *    `PlanAdminService.withUsageFlag`'s own docstring from P7).
 *
 * `CONCURRENTLY` (`transaction = false`, mirrors `CustomerSegments
 * 1730071000000` / `AuditLogIndexes1730062000000`) — `appointments` is a hot
 * table; a locking build would stall every booking read while it runs.
 */
export class ReadPathIndexes1730086000000 implements MigrationInterface {
  name = 'ReadPathIndexes1730086000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_appointments_tenant_start_at" ON "appointments" ("tenantId", "start_at")`,
    );
    await this.assertValid(q, 'IDX_appointments_tenant_start_at');
  }

  private async assertValid(q: QueryRunner, indexName: string): Promise<void> {
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        `ReadPathIndexes: "${indexName}" was created but is NOT valid — a CONCURRENTLY build ` +
          'failed partway. Investigate, drop the invalid index, and re-run this migration.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_appointments_tenant_start_at"`);
  }
}
