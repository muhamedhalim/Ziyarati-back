import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tap migration, Phase 5 / plan §17 M4 (it ships as M5 because Phase 4 took the
 * `merchant_accounts` slot): everything refunds-and-reconciliation needs to STORE.
 *
 * ADDITIVE ONLY — nothing renamed, nothing deleted, no Moyasar id rewritten, and
 * every new column is nullable or has a default, so every existing row stays valid.
 *
 *  settlements   — `source` (INTERNAL = a batch ZiyaraTech built; PROVIDER = a mirror
 *                  of a payout the gateway itself made), `provider`,
 *                  `provider_payout_id`, `bank_reference`, and a partial UNIQUE index
 *                  so importing the same payout twice cannot create two settlements.
 *  payments      — `provider_payout_id`: which gateway payout paid this charge out.
 *  merchant_accounts — `provider_reports_status` / `provider_reports_checked_at`:
 *                  whether the gateway's reporting API would answer for this
 *                  merchant with OUR credentials. Tap documents that a sub-merchant
 *                  reports with its own keys, so this is a recorded fact per clinic,
 *                  not an assumption (and not an error per charge).
 *  subscription_invoices — refund bookkeeping for the platform's own refunds:
 *                  `refund_reference`, `refund_requested_at`, `refunded_at`,
 *                  `refund_attempts` (makes each attempt's idempotency key unique),
 *                  `refund_reason`.
 *  payment_reconciliation_exceptions — NEW. One row per discrepancy a human must
 *                  look at (duplicate capture, amount / status / fee / settlement
 *                  mismatch, a charge we do not know, …). UNIQUE (kind,
 *                  provider_object_id) so a re-run of the same sweep re-finds the
 *                  same row instead of piling up duplicates.
 *
 * Every object is ALSO declared on its entity (same names), so a schema built
 * from metadata carries it and `synchronize` does not drop it.
 *
 * REVERSIBLE.
 */
export class PaymentsReconciliation1730110000000 implements MigrationInterface {
  name = 'PaymentsReconciliation1730110000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "settlements"
         ADD COLUMN IF NOT EXISTS "source" varchar(16) NOT NULL DEFAULT 'INTERNAL',
         ADD COLUMN IF NOT EXISTS "provider" varchar(32),
         ADD COLUMN IF NOT EXISTS "provider_payout_id" varchar(64),
         ADD COLUMN IF NOT EXISTS "bank_reference" varchar(64)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_settlements_provider_payout"
         ON "settlements" ("provider", "provider_payout_id")
         WHERE "provider_payout_id" IS NOT NULL`,
    );

    await q.query(
      `ALTER TABLE "payments"
         ADD COLUMN IF NOT EXISTS "provider_payout_id" varchar(64)`,
    );

    await q.query(
      `ALTER TABLE "merchant_accounts"
         ADD COLUMN IF NOT EXISTS "provider_reports_status" varchar(16),
         ADD COLUMN IF NOT EXISTS "provider_reports_checked_at" timestamptz`,
    );

    await q.query(
      `ALTER TABLE "subscription_invoices"
         ADD COLUMN IF NOT EXISTS "refund_reference" varchar(64),
         ADD COLUMN IF NOT EXISTS "refund_requested_at" timestamptz,
         ADD COLUMN IF NOT EXISTS "refunded_at" timestamptz,
         ADD COLUMN IF NOT EXISTS "refund_attempts" integer NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS "refund_reason" text`,
    );

    await q.query(
      `CREATE TABLE IF NOT EXISTS "payment_reconciliation_exceptions" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "kind" varchar(40) NOT NULL,
         "provider" varchar(32) NOT NULL,
         "provider_object_id" varchar(96) NOT NULL,
         "tenant_id" uuid,
         "payment_id" uuid,
         "merchant_id" varchar(64),
         "details" jsonb,
         "details_hash" varchar(64),
         "status" varchar(16) NOT NULL DEFAULT 'OPEN',
         "occurrences" integer NOT NULL DEFAULT 1,
         "first_seen_at" timestamptz NOT NULL DEFAULT now(),
         "last_seen_at" timestamptz NOT NULL DEFAULT now(),
         "resolved_at" timestamptz,
         "resolved_by" uuid,
         "resolution_note" text,
         CONSTRAINT "PK_payment_reconciliation_exceptions" PRIMARY KEY ("id")
       )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_recon_exception_kind_object"
         ON "payment_reconciliation_exceptions" ("kind", "provider_object_id")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_recon_exception_status_seen"
         ON "payment_reconciliation_exceptions" ("status", "last_seen_at" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IX_recon_exception_tenant"
         ON "payment_reconciliation_exceptions" ("tenant_id")
         WHERE "tenant_id" IS NOT NULL`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IX_recon_exception_tenant"`);
    await q.query(`DROP INDEX IF EXISTS "IX_recon_exception_status_seen"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_recon_exception_kind_object"`);
    await q.query(`DROP TABLE IF EXISTS "payment_reconciliation_exceptions"`);

    await q.query(
      `ALTER TABLE "subscription_invoices"
         DROP COLUMN IF EXISTS "refund_reason",
         DROP COLUMN IF EXISTS "refund_attempts",
         DROP COLUMN IF EXISTS "refunded_at",
         DROP COLUMN IF EXISTS "refund_requested_at",
         DROP COLUMN IF EXISTS "refund_reference"`,
    );
    await q.query(
      `ALTER TABLE "merchant_accounts"
         DROP COLUMN IF EXISTS "provider_reports_checked_at",
         DROP COLUMN IF EXISTS "provider_reports_status"`,
    );
    await q.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "provider_payout_id"`,
    );
    await q.query(`DROP INDEX IF EXISTS "UQ_settlements_provider_payout"`);
    await q.query(
      `ALTER TABLE "settlements"
         DROP COLUMN IF EXISTS "bank_reference",
         DROP COLUMN IF EXISTS "provider_payout_id",
         DROP COLUMN IF EXISTS "provider",
         DROP COLUMN IF EXISTS "source"`,
    );
  }
}
