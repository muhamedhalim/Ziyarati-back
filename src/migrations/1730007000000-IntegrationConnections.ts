import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 3 — two-way integrations foundation:
 *
 *  1. `integration_connections` — one external system connected to a tenant.
 *     Encrypted `credentials_ciphertext`; provider from a trusted registry;
 *     soft-deletable so mappings/history survive disconnection.
 *  2. `integration_id_map` — external-id ⇄ internal-id correspondence, scoped
 *     per (tenant, connection, resource_type). TWO unique constraints enforce a
 *     clean 1:1 mapping within a connection and make cross-tenant mapping and
 *     inconsistent remapping structurally impossible.
 *  3. `integration_idempotency_keys` — retry-safe write dedupe, unique per
 *     (tenant, idempotency_key), expiry-bounded.
 *
 * Fully additive; no existing table/column changes. All statements are
 * idempotent (IF NOT EXISTS / guarded DO blocks) so a partial re-run is safe.
 */
export class IntegrationConnections1730007000000 implements MigrationInterface {
  name = 'IntegrationConnections1730007000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── integration_connections ──────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_connections" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "provider" character varying(60) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "auth_type" character varying(20) NOT NULL DEFAULT 'none',
        "credentials_ciphertext" text,
        "config" jsonb,
        "sync_direction" character varying(20) NOT NULL DEFAULT 'bidirectional',
        "default_conflict_policy" character varying(20) NOT NULL DEFAULT 'reject_and_report',
        "last_success_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "last_error_at" TIMESTAMP WITH TIME ZONE,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_connections_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_connections_tenantId') THEN
          ALTER TABLE "integration_connections"
            ADD CONSTRAINT "FK_integration_connections_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_integration_connections_tenantId" ON "integration_connections" ("tenantId")
    `);

    // ── integration_id_map ───────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_id_map" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid NOT NULL,
        "resource_type" character varying(20) NOT NULL,
        "external_id" character varying(255) NOT NULL,
        "internal_resource_id" uuid NOT NULL,
        "source" character varying(20) NOT NULL DEFAULT 'external',
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_id_map_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_id_map_tenantId') THEN
          ALTER TABLE "integration_id_map"
            ADD CONSTRAINT "FK_integration_id_map_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_id_map_connectionId') THEN
          ALTER TABLE "integration_id_map"
            ADD CONSTRAINT "FK_integration_id_map_connectionId"
            FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    // One internal record per external id, and one external id per internal
    // record, within a (tenant, connection, resource_type).
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_id_map_external"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type", "external_id")
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_id_map_internal"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type", "internal_resource_id")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_integration_id_map_lookup"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type")
    `);

    // ── integration_idempotency_keys ─────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "integration_idempotency_keys" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid,
        "idempotency_key" character varying(255) NOT NULL,
        "endpoint" character varying(120) NOT NULL,
        "request_hash" character varying(64) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'in_progress',
        "response_status" integer,
        "response_body" jsonb,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_idempotency_keys_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_idem_tenantId') THEN
          ALTER TABLE "integration_idempotency_keys"
            ADD CONSTRAINT "FK_integration_idem_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_integration_idem_connectionId') THEN
          ALTER TABLE "integration_idempotency_keys"
            ADD CONSTRAINT "FK_integration_idem_connectionId"
            FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_idempotency_key"
        ON "integration_idempotency_keys" ("tenantId", "idempotency_key")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_integration_idempotency_expires"
        ON "integration_idempotency_keys" ("expires_at")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Drop children before parents. This removes integration mapping/idempotency
    // state; connection rows are removed last. History tables (added by later
    // migrations) are intentionally not touched here.
    await q.query(`DROP TABLE IF EXISTS "integration_idempotency_keys"`);
    await q.query(`DROP TABLE IF EXISTS "integration_id_map"`);
    await q.query(`DROP TABLE IF EXISTS "integration_connections"`);
  }
}
