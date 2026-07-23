import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 — two-way integration lifecycle. Fully ADDITIVE: new tables + two new
 * nullable columns on `integration_connections`. No existing column is altered or
 * dropped, and every statement is idempotent (IF NOT EXISTS / guarded DO blocks)
 * so a partial re-run is safe.
 *
 * Design choices (see ADR follow-ups):
 *  - History/conflict tables reference `integration_connections` with ON DELETE
 *    SET NULL (not CASCADE), so an import/sync/conflict record is NEVER destroyed
 *    by a connection removal — disconnect is a soft-delete, so this stays
 *    populated in normal operation.
 *  - `integration_sync_jobs` gets a PARTIAL UNIQUE INDEX so the DATABASE (not just
 *    a service check) rejects a second active run for the same
 *    (tenant, connection, resource, direction).
 */
export class IntegrationTwoWayLifecycle1730008000000 implements MigrationInterface {
  name = 'IntegrationTwoWayLifecycle1730008000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── connection health columns ────────────────────────────────────────────
    await q.query(`
      ALTER TABLE "integration_connections"
        ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "last_latency_ms" integer
    `);

    // ── integration_import_jobs ──────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_import_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid,
        "resource_type" character varying(20) NOT NULL,
        "status" character varying(24) NOT NULL DEFAULT 'pending',
        "mode" character varying(16) NOT NULL DEFAULT 'partial',
        "dry_run" boolean NOT NULL DEFAULT false,
        "total" integer NOT NULL DEFAULT 0,
        "processed" integer NOT NULL DEFAULT 0,
        "created_count" integer NOT NULL DEFAULT 0,
        "updated_count" integer NOT NULL DEFAULT 0,
        "linked_count" integer NOT NULL DEFAULT 0,
        "skipped_count" integer NOT NULL DEFAULT 0,
        "conflicted_count" integer NOT NULL DEFAULT 0,
        "failed_count" integer NOT NULL DEFAULT 0,
        "duplicates_in_batch" integer NOT NULL DEFAULT 0,
        "cancel_requested" boolean NOT NULL DEFAULT false,
        "payload" jsonb,
        "error_summary" text,
        "requested_byId" uuid,
        "correlation_id" character varying(100),
        "started_at" TIMESTAMP WITH TIME ZONE,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_import_jobs_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_import_jobs_tenantId') THEN
          ALTER TABLE "integration_import_jobs" ADD CONSTRAINT "FK_integration_import_jobs_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_import_jobs_connectionId') THEN
          ALTER TABLE "integration_import_jobs" ADD CONSTRAINT "FK_integration_import_jobs_connectionId"
            FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_import_jobs_requestedById') THEN
          ALTER TABLE "integration_import_jobs" ADD CONSTRAINT "FK_integration_import_jobs_requestedById"
            FOREIGN KEY ("requested_byId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_integration_import_jobs_tenant" ON "integration_import_jobs" ("tenantId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_integration_import_jobs_connection" ON "integration_import_jobs" ("connectionId")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_integration_import_jobs_status" ON "integration_import_jobs" ("status")`);

    // ── integration_import_items ─────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_import_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "jobId" uuid NOT NULL,
        "external_id" character varying(255) NOT NULL,
        "outcome" character varying(20) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "internal_resource_id" uuid,
        "changed_fields" jsonb,
        "error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_import_items_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_import_items_jobId') THEN
          ALTER TABLE "integration_import_items" ADD CONSTRAINT "FK_integration_import_items_jobId"
            FOREIGN KEY ("jobId") REFERENCES "integration_import_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_integration_import_items_job" ON "integration_import_items" ("jobId")`);

    // ── integration_sync_jobs ────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_sync_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid,
        "resource_type" character varying(20) NOT NULL,
        "direction" character varying(20) NOT NULL,
        "mode" character varying(16) NOT NULL DEFAULT 'incremental',
        "status" character varying(24) NOT NULL DEFAULT 'pending',
        "cursor" character varying(255),
        "last_successful_cursor" character varying(255),
        "processed" integer NOT NULL DEFAULT 0,
        "created_count" integer NOT NULL DEFAULT 0,
        "updated_count" integer NOT NULL DEFAULT 0,
        "skipped_count" integer NOT NULL DEFAULT 0,
        "conflicted_count" integer NOT NULL DEFAULT 0,
        "failed_count" integer NOT NULL DEFAULT 0,
        "retry_count" integer NOT NULL DEFAULT 0,
        "cancel_requested" boolean NOT NULL DEFAULT false,
        "error_summary" text,
        "triggered_byId" uuid,
        "scheduled" boolean NOT NULL DEFAULT false,
        "correlation_id" character varying(100),
        "started_at" TIMESTAMP WITH TIME ZONE,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_sync_jobs_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_sync_jobs_tenantId') THEN
          ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "FK_integration_sync_jobs_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_sync_jobs_connectionId') THEN
          ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "FK_integration_sync_jobs_connectionId"
            FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_sync_jobs_triggeredById') THEN
          ALTER TABLE "integration_sync_jobs" ADD CONSTRAINT "FK_integration_sync_jobs_triggeredById"
            FOREIGN KEY ("triggered_byId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_integration_sync_jobs_lookup" ON "integration_sync_jobs" ("tenantId", "connectionId", "resource_type", "direction")`);
    // DB-level duplicate-active-run prevention: only ONE pending/running row per tuple.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_sync_active"
        ON "integration_sync_jobs" ("tenantId", "connectionId", "resource_type", "direction")
        WHERE "status" IN ('pending', 'running')
    `);

    // ── integration_conflicts ────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_conflicts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid,
        "resource_type" character varying(20) NOT NULL,
        "external_id" character varying(255) NOT NULL,
        "internal_resource_id" uuid,
        "conflicting_fields" jsonb NOT NULL,
        "external_hash" character varying(64),
        "platform_hash" character varying(64),
        "policy" character varying(24) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "resolution" character varying(24),
        "resolved_byId" uuid,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_conflicts_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_conflicts_tenantId') THEN
          ALTER TABLE "integration_conflicts" ADD CONSTRAINT "FK_integration_conflicts_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_conflicts_connectionId') THEN
          ALTER TABLE "integration_conflicts" ADD CONSTRAINT "FK_integration_conflicts_connectionId"
            FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_conflicts_resolvedById') THEN
          ALTER TABLE "integration_conflicts" ADD CONSTRAINT "FK_integration_conflicts_resolvedById"
            FOREIGN KEY ("resolved_byId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IX_integration_conflicts_lookup" ON "integration_conflicts" ("tenantId", "connectionId", "resource_type", "status")`);
    // One pending conflict per external record per connection (dedupe target).
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_conflicts_pending"
        ON "integration_conflicts" ("tenantId", "connectionId", "resource_type", "external_id")
        WHERE "status" = 'pending'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Children before parents. This migration OWNS the health columns (it added
    // them), so a clean rollback drops them too — `up` re-adds them idempotently.
    // Verified by an up → down → up replay on real Postgres.
    await q.query(`DROP TABLE IF EXISTS "integration_conflicts"`);
    await q.query(`DROP TABLE IF EXISTS "integration_import_items"`);
    await q.query(`DROP TABLE IF EXISTS "integration_import_jobs"`);
    await q.query(`DROP TABLE IF EXISTS "integration_sync_jobs"`);
    await q.query(`ALTER TABLE "integration_connections" DROP COLUMN IF EXISTS "consecutive_failures"`);
    await q.query(`ALTER TABLE "integration_connections" DROP COLUMN IF EXISTS "last_latency_ms"`);
  }
}
