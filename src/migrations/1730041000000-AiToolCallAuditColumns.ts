import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M1 (`AI-008`, `AI-016`, `AI-017`, `AI-024`) — three nullable, additive
 * columns on `ai_tool_calls` so a denied/refused attempt and a completed
 * business action alike carry enough context for incident reconstruction:
 *
 *   - `correlation_id` — the request/turn correlation id (AI-016). Written
 *     as explicit null when none can be established, never omitted, so an
 *     operator can tell "not recorded" from "not applicable" (FR-032).
 *   - `actor_user_id` — the acting staff principal (AI-017). Null for
 *     guests by design, never omitted (FR-034).
 *   - `resource_tenant_id` — the tenant that OWNS the resource acted upon,
 *     set only where it differs from `tenant_id` (today: public booking).
 *     Additive; `tenant_id` (the conversation tenant, a load-bearing
 *     isolation property) is never repurposed or overwritten (FR-035,
 *     FR-036, AI-024).
 *
 * No backfill (FR-108) — `status` stays `varchar(20)` with no check
 * constraint, so the new `DENIED`/`REFUSED` terminal states (added in
 * application code at T067, not here) widen the domain without touching a
 * single existing row. `uq_ai_tool_call_idem` and `idx_ai_tool_calls_conv`
 * are not altered (FR-110).
 *
 * `CONCURRENTLY` (`transaction = false`, same pattern as M-01/M-04) so
 * index creation never blocks a write against a table this hot.
 */
export class AiToolCallAuditColumns1730041000000
  implements MigrationInterface
{
  name = 'AiToolCallAuditColumns1730041000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    // ── T061: the three columns ──────────────────────────────────────────
    await q.query(
      `ALTER TABLE ai_tool_calls ADD COLUMN IF NOT EXISTS correlation_id varchar`,
    );
    await q.query(
      `ALTER TABLE ai_tool_calls ADD COLUMN IF NOT EXISTS actor_user_id uuid`,
    );
    await q.query(
      `ALTER TABLE ai_tool_calls ADD COLUMN IF NOT EXISTS resource_tenant_id uuid`,
    );

    // ── T062: indexes assessed against the ledger's real query patterns ──
    // Each is a partial index over rows where the new column is actually
    // set — every pre-M1 row (and, for correlation_id/actor_user_id, every
    // guest-authored row) stays null forever (no backfill), so excluding
    // null keeps these indexes from growing with rows they can never serve.

    // Incident lookup: "every record for this one request/turn."
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_tool_calls_correlation
         ON ai_tool_calls (correlation_id)
       WHERE correlation_id IS NOT NULL`,
    );

    // Incident lookup: "everything this staff member did," tenant-scoped —
    // mirrors idx_ai_tool_calls_conv's (tenant_id, X, created_at) shape.
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_tool_calls_actor
         ON ai_tool_calls (tenant_id, actor_user_id, created_at)
       WHERE actor_user_id IS NOT NULL`,
    );

    // Clinic-scoped audit (AI-024): the query is `tenant_id = X OR
    // resource_tenant_id = X` — an OR, not an AND, so a single composite
    // index would not serve it; a standalone index lets the planner
    // BitmapOr this with idx_ai_tool_calls_conv's leading tenant_id.
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_tool_calls_resource_tenant
         ON ai_tool_calls (resource_tenant_id)
       WHERE resource_tenant_id IS NOT NULL`,
    );

    // Retention purge (FR-029c), denial/refusal half: the two new terminal
    // states are the clearest, cheapest attempt-only signal to index now.
    await q.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_tool_calls_retention
         ON ai_tool_calls (created_at)
       WHERE status IN ('DENIED', 'REFUSED')`,
    );

    // ASSESSED AND REJECTED (recorded per T062, not a foregone conclusion):
    // an index for the 7 session-state public tools' attempt-only rows,
    // identified by their `attempt:<tool>:<uuid>` idempotency_key prefix
    // (R3) rather than by status (their status is whatever the session
    // write produced — often SUCCEEDED, not DENIED/REFUSED). A btree index
    // only accelerates a `LIKE 'attempt:%'` prefix scan under the
    // `varchar_pattern_ops` opclass, a choice that belongs with T076's
    // actual retention-service predicate once it is written, not
    // preemptively here — building it now risks indexing the wrong shape
    // and needing to rebuild once T076 lands. The retention sweep is a
    // low-frequency, batched background job (bounded per-run cap,
    // documented at T076), not a latency-sensitive path, so a
    // `created_at`-bounded scan without this specific index is an
    // acceptable interim cost.

    // Structural correctness check, mirroring M-04's own precedent: a
    // CONCURRENTLY build that fails partway leaves an INVALID index rather
    // than silently half-applying.
    const invalid: { indexname: string }[] = await q.query(
      `SELECT c.relname AS indexname
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN (
          'idx_ai_tool_calls_correlation',
          'idx_ai_tool_calls_actor',
          'idx_ai_tool_calls_resource_tenant',
          'idx_ai_tool_calls_retention'
        )
          AND NOT i.indisvalid`,
    );
    if (invalid.length > 0) {
      throw new Error(
        `M1: the following indexes were created but are NOT valid — a CONCURRENTLY build failed ` +
          `partway: ${invalid.map((r) => r.indexname).join(', ')}. Investigate, drop the invalid ` +
          `index(es), and re-run this migration.`,
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_ai_tool_calls_retention`);
    await q.query(`DROP INDEX IF EXISTS idx_ai_tool_calls_resource_tenant`);
    await q.query(`DROP INDEX IF EXISTS idx_ai_tool_calls_actor`);
    await q.query(`DROP INDEX IF EXISTS idx_ai_tool_calls_correlation`);
    await q.query(
      `ALTER TABLE ai_tool_calls DROP COLUMN IF EXISTS resource_tenant_id`,
    );
    await q.query(
      `ALTER TABLE ai_tool_calls DROP COLUMN IF EXISTS actor_user_id`,
    );
    await q.query(
      `ALTER TABLE ai_tool_calls DROP COLUMN IF EXISTS correlation_id`,
    );
  }
}
