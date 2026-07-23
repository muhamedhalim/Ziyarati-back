import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 gap-closure — preserve outbound-webhook delivery history + audit
 * evidence across endpoint deletion:
 *
 *  1. `webhook_endpoints.deleted_at` — the dashboard "delete" action becomes a
 *     SOFT delete (sets this + is_active=false) instead of removing the row.
 *  2. `webhook_deliveries.webhookEndpointId` becomes NULLABLE with
 *     `ON DELETE SET NULL` (was NOT NULL / CASCADE) — a DB-level backstop so
 *     that even a hypothetical future hard-delete of an endpoint can never
 *     cascade-destroy its delivery history.
 *  3. `webhook_deliveries.webhook_endpoint_url_snapshot` — an immutable copy
 *     of the URL a delivery was actually sent to, captured once at dispatch
 *     time; survives both endpoint URL edits and endpoint deletion.
 *  4. `webhook_deliveries.replayed_from_id` — links a manually-replayed
 *     delivery row back to the original it replayed, without a DB-level FK
 *     (self-referential, display/audit purposes only).
 */
export class WebhookDeliveryRetention1730006000000 implements MigrationInterface {
  name = 'WebhookDeliveryRetention1730006000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "webhook_endpoints"
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP WITH TIME ZONE
    `);

    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ADD COLUMN IF NOT EXISTS "webhook_endpoint_url_snapshot" character varying(2048)
    `);
    await q.query(`
      UPDATE "webhook_deliveries" d
      SET "webhook_endpoint_url_snapshot" = e."url"
      FROM "webhook_endpoints" e
      WHERE e."id" = d."webhookEndpointId"
        AND d."webhook_endpoint_url_snapshot" IS NULL
    `);
    await q.query(`
      UPDATE "webhook_deliveries"
      SET "webhook_endpoint_url_snapshot" = ''
      WHERE "webhook_endpoint_url_snapshot" IS NULL
    `);
    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ALTER COLUMN "webhook_endpoint_url_snapshot" SET NOT NULL
    `);

    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ADD COLUMN IF NOT EXISTS "replayed_from_id" uuid
    `);

    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_webhook_deliveries_webhookEndpointId'
        ) THEN
          ALTER TABLE "webhook_deliveries"
            DROP CONSTRAINT "FK_webhook_deliveries_webhookEndpointId";
        END IF;
      END $$;
    `);
    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ALTER COLUMN "webhookEndpointId" DROP NOT NULL
    `);
    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ADD CONSTRAINT "FK_webhook_deliveries_webhookEndpointId"
        FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoints"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_webhook_deliveries_webhookEndpointId'
        ) THEN
          ALTER TABLE "webhook_deliveries"
            DROP CONSTRAINT "FK_webhook_deliveries_webhookEndpointId";
        END IF;
      END $$;
    `);
    // Deliveries whose endpoint was hard-deleted while this migration's FK was
    // live have a NULL webhookEndpointId — cannot restore NOT NULL/CASCADE
    // without data loss, so those rows are removed before reverting.
    await q.query(`DELETE FROM "webhook_deliveries" WHERE "webhookEndpointId" IS NULL`);
    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ALTER COLUMN "webhookEndpointId" SET NOT NULL
    `);
    await q.query(`
      ALTER TABLE "webhook_deliveries"
        ADD CONSTRAINT "FK_webhook_deliveries_webhookEndpointId"
        FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoints"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await q.query(`ALTER TABLE "webhook_deliveries" DROP COLUMN IF EXISTS "replayed_from_id"`);
    await q.query(`ALTER TABLE "webhook_deliveries" DROP COLUMN IF EXISTS "webhook_endpoint_url_snapshot"`);
    await q.query(`ALTER TABLE "webhook_endpoints" DROP COLUMN IF EXISTS "deleted_at"`);
  }
}
