import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 (inbound webhooks, staff provisioning, OAuth client, mapping
 * lifecycle, conflict concurrency, sync cursor semantics).
 *
 * Deliberately written WITHOUT blanket `IF NOT EXISTS` on the objects it owns:
 * each object either does not exist (fresh apply) or this migration is already
 * recorded in the `migrations` table. Unconditional DDL makes genuine schema
 * drift fail loudly instead of silently accepting a wrong schema. `up` ends with
 * explicit post-condition checks that RAISE when anything is missing.
 *
 * ADDITIVE and backfill-safe against production data:
 *  - new tables,
 *  - new columns, all nullable or with a DEFAULT so existing rows adopt them,
 *  - one partial unique index WIDENED (see the conflicts section) — strictly
 *    more restrictive than before, and verified below to have no violating rows
 *    before it is created.
 *
 * `down` is DESTRUCTIVE: it drops the four new tables (inbound delivery history,
 * webhook endpoints + their signing secrets, staff provisioning decisions, OAuth
 * handshake state) and the new columns (including stored OAuth tokens and all
 * mapping unlink history). It MUST NOT be run once production data exists — the
 * dropped rows are the audit trail. It is provided so the chain can be replayed
 * on a throwaway database.
 */
export class IntegrationInboundOAuthLifecycle1730010000000 implements MigrationInterface {
  name = 'IntegrationInboundOAuthLifecycle1730010000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── integration_webhook_endpoints ────────────────────────────────────────
    // One endpoint per connection; the secret is stored ENCRYPTED and only its
    // display prefix is readable afterwards.
    await q.query(`
      CREATE TABLE "integration_webhook_endpoints" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "secret_ciphertext" text NOT NULL,
        "secret_prefix" character varying(16) NOT NULL,
        "secret_rotated_at" TIMESTAMP WITH TIME ZONE,
        "signature_scheme" character varying(40) NOT NULL DEFAULT 'hmac_sha256_timestamped',
        "allowed_events" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "tolerance_seconds" integer NOT NULL DEFAULT 300,
        "accepted_count" integer NOT NULL DEFAULT 0,
        "rejected_count" integer NOT NULL DEFAULT 0,
        "last_accepted_at" TIMESTAMP WITH TIME ZONE,
        "last_rejected_at" TIMESTAMP WITH TIME ZONE,
        "last_rejection_reason" character varying(40),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_webhook_endpoints_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      ALTER TABLE "integration_webhook_endpoints"
        ADD CONSTRAINT "FK_integration_webhook_endpoints_tenantId"
        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
    `);
    // CASCADE: an endpoint is meaningless without its connection. Delivery
    // HISTORY is not lost — that lives on integration_inbound_events, whose
    // endpoint/connection FKs are SET NULL.
    await q.query(`
      ALTER TABLE "integration_webhook_endpoints"
        ADD CONSTRAINT "FK_integration_webhook_endpoints_connectionId"
        FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE
    `);
    await q.query(`
      CREATE INDEX "IX_integration_webhook_endpoints_tenant"
        ON "integration_webhook_endpoints" ("tenantId")
    `);
    // One endpoint per connection — the delivery URL must identify exactly one
    // secret to verify against.
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_webhook_endpoints_connection"
        ON "integration_webhook_endpoints" ("connectionId")
    `);

    // ── integration_inbound_events ───────────────────────────────────────────
    await q.query(`
      CREATE TABLE "integration_inbound_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "endpointId" uuid,
        "connectionId" uuid,
        "provider_event_id" character varying(255) NOT NULL,
        "event_type" character varying(60) NOT NULL,
        "resource_type" character varying(20),
        "external_id" character varying(255),
        "status" character varying(20) NOT NULL DEFAULT 'accepted',
        "rejection_reason" character varying(40),
        "payload" jsonb,
        "signature_timestamp" bigint,
        "upsert_outcome" character varying(20),
        "internal_resource_id" uuid,
        "attempts" integer NOT NULL DEFAULT 0,
        "error_summary" text,
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_inbound_events_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      ALTER TABLE "integration_inbound_events"
        ADD CONSTRAINT "FK_integration_inbound_events_tenantId"
        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
    `);
    // SET NULL on both: delivery history OUTLIVES the endpoint and connection.
    await q.query(`
      ALTER TABLE "integration_inbound_events"
        ADD CONSTRAINT "FK_integration_inbound_events_endpointId"
        FOREIGN KEY ("endpointId") REFERENCES "integration_webhook_endpoints"("id") ON DELETE SET NULL
    `);
    await q.query(`
      ALTER TABLE "integration_inbound_events"
        ADD CONSTRAINT "FK_integration_inbound_events_connectionId"
        FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL
    `);
    await q.query(`
      CREATE INDEX "IX_integration_inbound_events_lookup"
        ON "integration_inbound_events" ("tenantId", "endpointId", "status")
    `);
    await q.query(`
      CREATE INDEX "IX_integration_inbound_events_received"
        ON "integration_inbound_events" ("tenantId", "received_at")
    `);
    // THE REPLAY GUARD. A second delivery of an event id cannot insert — this
    // is the guarantee, not a service-level "have I seen this?" read that two
    // concurrent deliveries could both pass.
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_inbound_events_replay"
        ON "integration_inbound_events" ("tenantId", "endpointId", "provider_event_id")
    `);

    // ── integration_staff_provisioning ───────────────────────────────────────
    await q.query(`
      CREATE TABLE "integration_staff_provisioning" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid,
        "external_id" character varying(255) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "proposed_full_name" character varying(200),
        "proposed_email" character varying(255),
        "proposed_profile" jsonb,
        "candidate_staff_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "approved_role_slug" character varying(60),
        "staffProfileId" uuid,
        "createdUserId" uuid,
        "reviewedById" uuid,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "invitation_sent" boolean NOT NULL DEFAULT false,
        "invitation_sent_at" TIMESTAMP WITH TIME ZONE,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_staff_provisioning_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      ALTER TABLE "integration_staff_provisioning"
        ADD CONSTRAINT "FK_integration_staff_provisioning_tenantId"
        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
    `);
    await q.query(`
      ALTER TABLE "integration_staff_provisioning"
        ADD CONSTRAINT "FK_integration_staff_provisioning_connectionId"
        FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL
    `);
    await q.query(`
      ALTER TABLE "integration_staff_provisioning"
        ADD CONSTRAINT "FK_integration_staff_provisioning_staffProfileId"
        FOREIGN KEY ("staffProfileId") REFERENCES "staff_profiles"("id") ON DELETE SET NULL
    `);
    await q.query(`
      ALTER TABLE "integration_staff_provisioning"
        ADD CONSTRAINT "FK_integration_staff_provisioning_createdUserId"
        FOREIGN KEY ("createdUserId") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    await q.query(`
      ALTER TABLE "integration_staff_provisioning"
        ADD CONSTRAINT "FK_integration_staff_provisioning_reviewedById"
        FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    await q.query(`
      CREATE INDEX "IX_integration_staff_provisioning_lookup"
        ON "integration_staff_provisioning" ("tenantId", "connectionId", "status")
    `);
    // One OPEN request per external staff member per connection, so a repeated
    // import refreshes the pending request instead of queueing duplicates (and
    // therefore cannot lead to two accounts for one person).
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_staff_provisioning_open"
        ON "integration_staff_provisioning" ("tenantId", "connectionId", "external_id")
        WHERE "status" IN ('pending','ambiguous')
    `);

    // ── integration_oauth_states ─────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "integration_oauth_states" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "connectionId" uuid NOT NULL,
        "state" character varying(128) NOT NULL,
        "code_verifier" character varying(128) NOT NULL,
        "provider" character varying(60) NOT NULL,
        "redirect_uri" text NOT NULL,
        "consumed_at" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "initiatedById" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integration_oauth_states_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      ALTER TABLE "integration_oauth_states"
        ADD CONSTRAINT "FK_integration_oauth_states_tenantId"
        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
    `);
    await q.query(`
      ALTER TABLE "integration_oauth_states"
        ADD CONSTRAINT "FK_integration_oauth_states_connectionId"
        FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE
    `);
    await q.query(`
      ALTER TABLE "integration_oauth_states"
        ADD CONSTRAINT "FK_integration_oauth_states_initiatedById"
        FOREIGN KEY ("initiatedById") REFERENCES "users"("id") ON DELETE SET NULL
    `);
    await q.query(`
      CREATE INDEX "IX_integration_oauth_states_tenant"
        ON "integration_oauth_states" ("tenantId")
    `);
    // The CSRF token must be globally unique — a callback is matched by `state`
    // alone before tenant ownership is re-checked.
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_oauth_states_state"
        ON "integration_oauth_states" ("state")
    `);

    // ── integration_connections: OAuth token storage (all ENCRYPTED) ─────────
    await q.query(`
      ALTER TABLE "integration_connections"
        ADD COLUMN "oauth_access_token_ciphertext" text,
        ADD COLUMN "oauth_refresh_token_ciphertext" text,
        ADD COLUMN "oauth_expires_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "oauth_scope" text,
        ADD COLUMN "oauth_connected_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "oauth_refreshed_at" TIMESTAMP WITH TIME ZONE
    `);

    // ── integration_id_map: soft-unlink lifecycle ────────────────────────────
    await q.query(`
      ALTER TABLE "integration_id_map"
        ADD COLUMN "unlinked_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "unlink_reason" character varying(32),
        ADD COLUMN "replaced_connection_id" uuid
    `);

    // The two 1:1 uniqueness guarantees must now apply to ACTIVE mappings only,
    // so an unlinked historical row never blocks a re-map. Rebuilt as PARTIAL
    // indexes. Both are re-created below regardless of what the originals were
    // named, and their presence is asserted in the post-conditions.
    await q.query(`DROP INDEX IF EXISTS "UQ_integration_id_map_external"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_integration_id_map_internal"`);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_id_map_external"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type", "external_id")
        WHERE "unlinked_at" IS NULL
    `);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_id_map_internal"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type", "internal_resource_id")
        WHERE "unlinked_at" IS NULL
    `);

    // ── integration_conflicts: concurrency fields ────────────────────────────
    await q.query(`
      ALTER TABLE "integration_conflicts"
        ADD COLUMN "stale_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "last_stale_at" TIMESTAMP WITH TIME ZONE
    `);

    // The single-open-conflict guarantee must cover the new open states
    // (`resolving`, `stale`) too, otherwise a stale conflict could be joined by
    // a second open row for the same record. This is STRICTLY MORE RESTRICTIVE
    // than the old predicate, so verify no violating rows exist first and fail
    // loudly rather than letting index creation surface a confusing error.
    await q.query(`
      DO $$
      DECLARE dupes integer;
      BEGIN
        SELECT COUNT(*) INTO dupes FROM (
          SELECT 1 FROM "integration_conflicts"
          WHERE "status" IN ('pending','resolving','stale')
          GROUP BY "tenantId", "connectionId", "resource_type", "external_id"
          HAVING COUNT(*) > 1
        ) d;
        IF dupes > 0 THEN
          RAISE EXCEPTION 'Cannot widen UQ_integration_conflicts_pending: % duplicate open conflict group(s) exist', dupes;
        END IF;
      END $$;
    `);
    await q.query(`DROP INDEX IF EXISTS "UQ_integration_conflicts_pending"`);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integration_conflicts_open"
        ON "integration_conflicts" ("tenantId", "connectionId", "resource_type", "external_id")
        WHERE "status" IN ('pending','resolving','stale')
    `);

    // ── integration_sync_jobs: explicit cursor semantics ─────────────────────
    await q.query(`
      ALTER TABLE "integration_sync_jobs"
        ADD COLUMN "attempted_cursor" character varying(255),
        ADD COLUMN "next_cursor" character varying(255),
        ADD COLUMN "cursor_kind" character varying(16) NOT NULL DEFAULT 'opaque',
        ADD COLUMN "pages_fetched" integer NOT NULL DEFAULT 0,
        ADD COLUMN "stop_reason" character varying(24)
    `);

    // ── Explicit post-conditions: fail loudly rather than silently drift ─────
    await q.query(`
      DO $$
      DECLARE missing text;
      BEGIN
        -- Tables
        FOREACH missing IN ARRAY ARRAY[
          'integration_webhook_endpoints',
          'integration_inbound_events',
          'integration_staff_provisioning',
          'integration_oauth_states'
        ] LOOP
          IF to_regclass(missing) IS NULL THEN
            RAISE EXCEPTION 'Migration post-condition failed: table % is missing', missing;
          END IF;
        END LOOP;

        -- Indexes that carry a correctness guarantee, not just performance.
        FOREACH missing IN ARRAY ARRAY[
          'UQ_integration_inbound_events_replay',
          'UQ_integration_webhook_endpoints_connection',
          'UQ_integration_staff_provisioning_open',
          'UQ_integration_oauth_states_state',
          'UQ_integration_id_map_external',
          'UQ_integration_id_map_internal',
          'UQ_integration_conflicts_open'
        ] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = missing) THEN
            RAISE EXCEPTION 'Migration post-condition failed: index % is missing', missing;
          END IF;
        END LOOP;

        -- Columns whose presence the runtime depends on.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'integration_connections' AND column_name = 'oauth_refresh_token_ciphertext'
        ) THEN
          RAISE EXCEPTION 'Migration post-condition failed: oauth token columns are missing';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'integration_id_map' AND column_name = 'unlinked_at'
        ) THEN
          RAISE EXCEPTION 'Migration post-condition failed: integration_id_map.unlinked_at is missing';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'integration_sync_jobs' AND column_name = 'last_successful_cursor'
        ) THEN
          RAISE EXCEPTION 'Migration post-condition failed: sync cursor columns are missing';
        END IF;

        -- The partial indexes must actually be partial, or the unlink lifecycle
        -- would be blocked by historical rows.
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE indexname = 'UQ_integration_id_map_external' AND indexdef LIKE '%unlinked_at IS NULL%'
        ) THEN
          RAISE EXCEPTION 'Migration post-condition failed: UQ_integration_id_map_external is not partial';
        END IF;
      END $$;
    `);
  }

  /**
   * DESTRUCTIVE. Drops the inbound delivery history, webhook endpoints (and
   * their signing secrets), staff provisioning decisions, OAuth handshake state,
   * stored OAuth tokens, all mapping unlink history, conflict staleness
   * counters, and the sync cursor detail columns.
   *
   * DO NOT RUN once production data exists — those rows ARE the audit trail.
   * Provided so the migration chain can be replayed on a throwaway database.
   */
  public async down(q: QueryRunner): Promise<void> {
    // Restore the previous, non-partial sync/conflict/mapping index shapes.
    await q.query(`DROP INDEX IF EXISTS "UQ_integration_conflicts_open"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_conflicts_pending"
        ON "integration_conflicts" ("tenantId", "connectionId", "resource_type", "external_id")
        WHERE "status" = 'pending'
    `);
    await q.query(`
      ALTER TABLE "integration_conflicts"
        DROP COLUMN IF EXISTS "stale_attempts",
        DROP COLUMN IF EXISTS "last_stale_at"
    `);

    await q.query(`
      ALTER TABLE "integration_sync_jobs"
        DROP COLUMN IF EXISTS "attempted_cursor",
        DROP COLUMN IF EXISTS "next_cursor",
        DROP COLUMN IF EXISTS "cursor_kind",
        DROP COLUMN IF EXISTS "pages_fetched",
        DROP COLUMN IF EXISTS "stop_reason"
    `);

    await q.query(`DROP INDEX IF EXISTS "UQ_integration_id_map_external"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_integration_id_map_internal"`);
    // Unlinked rows would violate the non-partial uniqueness being restored, so
    // they are removed first — part of why this down is destructive.
    await q.query(`DELETE FROM "integration_id_map" WHERE "unlinked_at" IS NOT NULL`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_id_map_external"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type", "external_id")
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_integration_id_map_internal"
        ON "integration_id_map" ("tenantId", "connectionId", "resource_type", "internal_resource_id")
    `);
    await q.query(`
      ALTER TABLE "integration_id_map"
        DROP COLUMN IF EXISTS "unlinked_at",
        DROP COLUMN IF EXISTS "unlink_reason",
        DROP COLUMN IF EXISTS "replaced_connection_id"
    `);

    await q.query(`
      ALTER TABLE "integration_connections"
        DROP COLUMN IF EXISTS "oauth_access_token_ciphertext",
        DROP COLUMN IF EXISTS "oauth_refresh_token_ciphertext",
        DROP COLUMN IF EXISTS "oauth_expires_at",
        DROP COLUMN IF EXISTS "oauth_scope",
        DROP COLUMN IF EXISTS "oauth_connected_at",
        DROP COLUMN IF EXISTS "oauth_refreshed_at"
    `);

    // Children before parents.
    await q.query(`DROP TABLE IF EXISTS "integration_oauth_states"`);
    await q.query(`DROP TABLE IF EXISTS "integration_staff_provisioning"`);
    await q.query(`DROP TABLE IF EXISTS "integration_inbound_events"`);
    await q.query(`DROP TABLE IF EXISTS "integration_webhook_endpoints"`);
  }
}
