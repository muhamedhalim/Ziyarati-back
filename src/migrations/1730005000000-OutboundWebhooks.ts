import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 — Outbound Webhooks: tenant-registered webhook endpoints + their
 * delivery history.
 *
 *  1. `webhook_endpoints` — one row per tenant-registered external endpoint.
 *     `secret_ciphertext` is the AES-256-GCM-encrypted secret (reversible —
 *     needed to HMAC-sign outgoing payloads); `secret_prefix` is a safe,
 *     display-only fragment of the plaintext, mirroring `api_keys.key_prefix`.
 *  2. `webhook_deliveries` — one row per (event instance × endpoint) delivery,
 *     updated in place across retries. FK to `webhook_endpoints` cascades on
 *     delete (a deleted endpoint's delivery history is deleted with it; the
 *     fact that the endpoint existed and was deleted is separately captured
 *     in `audit_logs`, which is never touched by this cascade).
 *
 * Fully additive; no existing table/column changes.
 */
export class OutboundWebhooks1730005000000 implements MigrationInterface {
  name = 'OutboundWebhooks1730005000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "name" character varying(100),
        "url" character varying(2048) NOT NULL,
        "secret_ciphertext" text NOT NULL,
        "secret_prefix" character varying(16),
        "events" jsonb NOT NULL DEFAULT '[]',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_endpoints_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_webhook_endpoints_tenantId'
        ) THEN
          ALTER TABLE "webhook_endpoints"
            ADD CONSTRAINT "FK_webhook_endpoints_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_webhook_endpoints_tenantId" ON "webhook_endpoints" ("tenantId")
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "webhookEndpointId" uuid NOT NULL,
        "event_type" character varying(100) NOT NULL,
        "payload" jsonb NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'PENDING',
        "http_status" integer,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "response_preview" text,
        "last_error" text,
        "last_attempted_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries_id" PRIMARY KEY ("id")
      )
    `);
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_webhook_deliveries_tenantId'
        ) THEN
          ALTER TABLE "webhook_deliveries"
            ADD CONSTRAINT "FK_webhook_deliveries_tenantId"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_webhook_deliveries_webhookEndpointId'
        ) THEN
          ALTER TABLE "webhook_deliveries"
            ADD CONSTRAINT "FK_webhook_deliveries_webhookEndpointId"
            FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoints"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_webhook_deliveries_tenantId_created" ON "webhook_deliveries" ("tenantId", "created_at")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IX_webhook_deliveries_endpointId_created" ON "webhook_deliveries" ("webhookEndpointId", "created_at")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "public"."IX_webhook_deliveries_endpointId_created"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_webhook_deliveries_tenantId_created"`);
    await q.query(`DROP TABLE IF EXISTS "webhook_deliveries"`);
    await q.query(`DROP INDEX IF EXISTS "public"."IX_webhook_endpoints_tenantId"`);
    await q.query(`DROP TABLE IF EXISTS "webhook_endpoints"`);
  }
}
