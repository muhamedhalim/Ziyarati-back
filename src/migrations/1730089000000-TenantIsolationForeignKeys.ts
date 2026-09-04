import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P0.7 — adds a tenant foreign key to the 10 tenant-scoped tables the
 * forensic review (`tests/load/reports/P0.7_TENANT_ISOLATION_MATRIX.md`)
 * classified **A — safe to add now**: zero orphan rows on both `ziyarati`
 * (dev) and `ziyarati_e2e` (the migration-built reference matching how
 * production is built), verified via
 * `tests/load/reports/P0.7_TENANT_FK_VERIFICATION.sql`.
 *
 * NOT the other 5 of the 15 tables production reported without one (P0.4,
 * operator-run 2026-09-04) — each excluded for a specific, documented
 * reason, none of them "forgot":
 *  - `subscription_invoices`, `subscription_usage` — `tenant_id` is
 *    `character varying`, not `uuid` (P03-006). An FK is structurally
 *    impossible without an `ALTER COLUMN ... TYPE uuid` table rewrite first
 *    — that is its own migration, its own window, and its own decision;
 *    never batched with this one.
 *  - `tenant_counters` — has exactly 1 orphaned row on `ziyarati` today.
 *    Adding this FK now would need that row resolved first, and choosing
 *    what "resolved" means for someone else's data is a decision this
 *    migration does not make (RULE 9, carried from P0.3).
 *  - `verification_audit_logs` — deliberately has no FK BY DESIGN
 *    (`VerificationAuditLog.ts`: "must survive deletion of the tenant it
 *    references"), and the column is `NOT NULL`, so `SET NULL` is not an
 *    option either. Never gets one.
 *  - `ai_memory_embeddings` — a pgvector sidecar TypeORM never manages,
 *    cascade-linked to `ai_memories` already; a direct tenant FK here would
 *    be redundant with the one this migration adds to `ai_memories` itself.
 *
 * TWO-MIGRATION SPLIT, DELIBERATE (P0.3 REPAIR_RUNBOOK's own pattern):
 * `ADD CONSTRAINT ... NOT VALID` here is metadata-only — no table scan, no
 * lock stronger than the ALTER itself needs, and it does NOT enforce
 * anything against EXISTING rows (only future writes). Whether production
 * has an orphan behind any of these 10 is not yet known — that question is
 * answered by `VALIDATE CONSTRAINT`, deferred to
 * `1730090000000-TenantIsolationValidateForeignKeys.ts`, so a surprise
 * orphan fails cleanly and separately from this migration succeeding.
 *
 * ON DELETE: `NO ACTION` (Postgres's default, so simply omitted) for every
 * one — matching the dominant existing convention in this schema (88 of the
 * 113 pre-existing tenant foreign keys already use it; measured via
 * `pg_constraint.confdeltype`) and deliberate: none of these ten is a pure
 * derived cache, and this codebase has no tenant-delete code path at all
 * today (grepped — `TenantsService` has no `remove`/`delete`, `tenants.
 * deleted_at` is written by nothing). Cascade behaviour for a future
 * tenant-delete feature is that feature's decision, not a side effect of
 * this migration.
 *
 * FK NAMES computed with TypeORM's own `DefaultNamingStrategy.foreignKeyName`
 * (verified against this exact schema: reproduced the four names TypeORM's
 * synchronizer already assigned on `ziyarati` for the four tables whose
 * entities declare `@ManyToOne(() => Tenant)` — `ai_execution_metrics`,
 * `ai_memories`, `workflows`, `workflow_runs` — byte for byte), so a future
 * `migration:generate` sees no drift to "fix". The other six use the same
 * function for the same reason: consistency with the other 113 foreign keys
 * in this schema, all of which are named this way, none of them by hand.
 *
 * IDEMPOTENT — a database where a name already exists (exactly the four
 * above, on any `ziyarati`-family database a `TYPEORM_SYNCHRONIZE=true` boot
 * has ever touched) is left untouched for that table and reported as such.
 */
export class TenantIsolationForeignKeys1730089000000 implements MigrationInterface {
  name = 'TenantIsolationForeignKeys1730089000000';

  public async up(q: QueryRunner): Promise<void> {
    // `admin_notifications` is the only one of the ten with no existing
    // index leading with the tenant column (verified, P0.7 §4) — a
    // supporting index is not required by Postgres for a foreign key, but
    // its absence would mean nothing here can look up "this tenant's
    // notifications" without a full scan, and an unindexed FK also makes a
    // future validate/delete on the parent (`tenants`) scan every row.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_7894c7c116ed11bd03bf9dfe75"
        ON "admin_notifications" ("tenant_id")
    `);

    await this.addNotValid(
      q,
      'admin_notifications',
      'tenant_id',
      'FK_3c0f90545fccf48cdc9af769900',
    );
    await this.addNotValid(
      q,
      'ai_execution_metrics',
      '"tenantId"',
      'FK_b36838c9d4e9f6661b8dbdbc381',
    );
    await this.addNotValid(
      q,
      'ai_kb_embeddings',
      'tenant_id',
      'FK_d8615fbaf07b49c97e568d1244b',
    );
    await this.addNotValid(
      q,
      'ai_memories',
      '"tenantId"',
      'FK_9d5a5a6e12bfbd4d0f2574be137',
    );
    await this.addNotValid(
      q,
      'ai_tool_calls',
      'tenant_id',
      'FK_3b51d63b4efb853544af8f3728b',
    );
    await this.addNotValid(
      q,
      'email_logs',
      'tenant_id',
      'FK_71c1fbaf7386c15669cdc86dbdb',
    );
    await this.addNotValid(
      q,
      'free_access_overrides',
      'tenant_id',
      'FK_fe98256a5df434c39572775c2ca',
    );
    await this.addNotValid(
      q,
      'settlement_adjustments',
      'tenant_id',
      'FK_d7109aa26f841e470dc16dafad0',
    );
    await this.addNotValid(
      q,
      'workflows',
      '"tenantId"',
      'FK_50b693c75be8214931a320c9231',
    );
    await this.addNotValid(
      q,
      'workflow_runs',
      '"tenantId"',
      'FK_345785d9f346ec88001942297d6',
    );
  }

  /** One `ADD CONSTRAINT ... NOT VALID`, skipped (with a NOTICE) if a
   *  constraint of this exact name already exists on this table. */
  private async addNotValid(
    q: QueryRunner,
    table: string,
    column: string,
    constraintName: string,
  ): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
           WHERE c.conname = '${constraintName}' AND t.relname = '${table}'
        ) THEN
          RAISE NOTICE '${constraintName} already present on "${table}" — nothing to add.';
          RETURN;
        END IF;

        ALTER TABLE "${table}"
          ADD CONSTRAINT "${constraintName}"
          FOREIGN KEY (${column}) REFERENCES "tenants"("id")
          NOT VALID;
      END $$;
    `);
  }

  /**
   * Drops exactly what `up()` added, in the same idempotent style. Safe to
   * run even where `up()` no-opped (the four already-drifted-onto-`ziyarati`
   * cases): dropping a constraint this migration did not itself create
   * would re-open the exact gap P0.7 exists to close on THAT database, so
   * `down()` only removes a constraint whose validated state still matches
   * what `up()` would have produced (`NOT VALID` — i.e. never reached
   * `1730090000000`'s `VALIDATE`). A validated one is left in place;
   * revert `1730090000000` first.
   */
  public async down(q: QueryRunner): Promise<void> {
    const targets: Array<[string, string]> = [
      ['admin_notifications', 'FK_3c0f90545fccf48cdc9af769900'],
      ['ai_execution_metrics', 'FK_b36838c9d4e9f6661b8dbdbc381'],
      ['ai_kb_embeddings', 'FK_d8615fbaf07b49c97e568d1244b'],
      ['ai_memories', 'FK_9d5a5a6e12bfbd4d0f2574be137'],
      ['ai_tool_calls', 'FK_3b51d63b4efb853544af8f3728b'],
      ['email_logs', 'FK_71c1fbaf7386c15669cdc86dbdb'],
      ['free_access_overrides', 'FK_fe98256a5df434c39572775c2ca'],
      ['settlement_adjustments', 'FK_d7109aa26f841e470dc16dafad0'],
      ['workflows', 'FK_50b693c75be8214931a320c9231'],
      ['workflow_runs', 'FK_345785d9f346ec88001942297d6'],
    ];
    for (const [table, constraintName] of targets) {
      await q.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
             WHERE c.conname = '${constraintName}' AND t.relname = '${table}'
               AND NOT c.convalidated
          ) THEN
            ALTER TABLE "${table}" DROP CONSTRAINT "${constraintName}";
          END IF;
        END $$;
      `);
    }
    await q.query(`DROP INDEX IF EXISTS "IDX_7894c7c116ed11bd03bf9dfe75"`);
  }
}
