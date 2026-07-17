import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Production-readiness audit fixes for the WhatsApp module.
 *
 * 1. `whatsapp_webhooks.idempotency_key` had no uniqueness at the DB layer —
 *    `WhatsappWebhookService.ingest()` did a `findOne` then `save()`, a
 *    classic check-then-insert race: two concurrent Meta redeliveries of the
 *    same event could both pass the check and get persisted (and queued)
 *    twice. Partial unique index closes the race at the only layer that
 *    actually serializes concurrent writes; the service is updated
 *    separately to treat the resulting unique-violation as a dedup, not an
 *    error. Also adds the (tenantId, created_at) index the admin `findAll`
 *    filter actually queries by.
 *
 * 2. `whatsapp_contacts` had zero indexes despite `wa_id` + `tenantId` being
 *    looked up on every single inbound WhatsApp message
 *    (`WhatsappInboundAiService.findOrCreateContact`) — and had no unique
 *    constraint, so concurrent inbound webhooks for the same number could
 *    create duplicate contact rows (already called out as a known gap in
 *    `WhatsappContactService.bulkImport`'s own comments). Adds the lookup
 *    index and a per-tenant partial-unique constraint on `wa_id`.
 *
 * Both sections dedupe existing rows (keeping the earliest) before creating
 * the unique index, since dev/staging data may already contain duplicates
 * created by the very race this migration closes.
 */
export class WhatsappReliabilityHardening1730003500000 implements MigrationInterface {
  name = 'WhatsappReliabilityHardening1730003500000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. whatsapp_webhooks idempotency ───────────────────────────────────
    await q.query(`
      DELETE FROM "whatsapp_webhooks" w
      USING "whatsapp_webhooks" dup
      WHERE w."idempotency_key" IS NOT NULL
        AND w."idempotency_key" = dup."idempotency_key"
        AND w."id" > dup."id"
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_whatsapp_webhook_idempotency_key"
      ON "whatsapp_webhooks" ("idempotency_key")
      WHERE "idempotency_key" IS NOT NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_whatsapp_webhook_tenant_created"
      ON "whatsapp_webhooks" ("tenantId", "created_at")
    `);

    // ── 2. whatsapp_contacts lookup + uniqueness ───────────────────────────
    await q.query(`
      DELETE FROM "whatsapp_contacts" c
      USING "whatsapp_contacts" dup
      WHERE c."wa_id" IS NOT NULL
        AND c."tenantId" = dup."tenantId"
        AND c."wa_id" = dup."wa_id"
        AND c."id" > dup."id"
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_whatsapp_contact_tenant_wa_id"
      ON "whatsapp_contacts" ("tenantId", "wa_id")
      WHERE "wa_id" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_whatsapp_contact_tenant_wa_id"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_whatsapp_webhook_tenant_created"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_whatsapp_webhook_idempotency_key"`);
  }
}
