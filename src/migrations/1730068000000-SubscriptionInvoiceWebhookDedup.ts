import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T083 (US5, FR-B013-FR-B015).
 *
 * Subscription charges are deliberately NOT routed through the tenant
 * `payments`/`transactions` ledger (`subscription-billing.module.ts`'s own
 * docblock: "Subscription charges are PLATFORM revenue... separate
 * financial stream"). `Transaction.payment` is a REQUIRED foreign key, so
 * `TransactionService.recordWebhookOnce`'s existing dedup mechanism cannot
 * be reused literally for a `SubscriptionInvoice` webhook without either
 * relaxing that FK (a change to an append-only financial ledger table, out
 * of proportion to a feature with no real provider to exercise it yet) or
 * giving `subscription_invoices` its own, identically-shaped dedup column.
 * This migration does the latter — the exact same PATTERN
 * `uq_txn_webhook_event` already established (partial unique index on the
 * provider's own event id), scoped to this table instead.
 */
export class SubscriptionInvoiceWebhookDedup1730068000000 implements MigrationInterface {
  name = 'SubscriptionInvoiceWebhookDedup1730068000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_invoices"
        ADD COLUMN IF NOT EXISTS "webhook_event_id" varchar
    `);

    await q.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_sub_invoice_webhook_event" ON "subscription_invoices" ("webhook_event_id") WHERE "webhook_event_id" IS NOT NULL`,
    );
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"UQ_sub_invoice_webhook_event"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        'SubscriptionInvoiceWebhookDedup: "UQ_sub_invoice_webhook_event" was created but is NOT ' +
          'valid — a CONCURRENTLY build failed partway. Investigate, drop the invalid index, ' +
          'resolve the underlying data, and re-run this migration.',
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_sub_invoice_webhook_event"`);
    await q.query(
      `ALTER TABLE "subscription_invoices" DROP COLUMN IF EXISTS "webhook_event_id"`,
    );
  }
}
