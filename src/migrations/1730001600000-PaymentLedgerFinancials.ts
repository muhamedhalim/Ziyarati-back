import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace financial ledger: persist the per-payment fee breakdown and
 * supporting fields on the existing `payments` table (no parallel ledger).
 * Fees may change over time, so the figures used at capture are frozen here.
 * Adds indexes for the admin financial dashboard (paid_at, status, appointment).
 */
export class PaymentLedgerFinancials1730001600000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "gateway_fee" numeric(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "platform_fee" numeric(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "net_amount" numeric(14,2),
        ADD COLUMN IF NOT EXISTS "payment_method" character varying,
        ADD COLUMN IF NOT EXISTS "merchant_id" character varying,
        ADD COLUMN IF NOT EXISTS "sub_merchant_id" character varying,
        ADD COLUMN IF NOT EXISTS "refunded_amount" numeric(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "refund_status" character varying,
        ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "failure_reason" text,
        ADD COLUMN IF NOT EXISTS "metadata" jsonb
    `);

    // Backfill net_amount for historical PAID rows (gross, since fees were 0).
    await q.query(
      `UPDATE "payments" SET "net_amount" = "amount" WHERE "net_amount" IS NULL AND "status" = 'PAID'`,
    );

    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_paid_at" ON "payments" ("paid_at")`,
    );
    // The appointment FK column is "appointmentId" (TypeORM default naming).
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_appointment" ON "payments" ("appointmentId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_payments_settlement_status" ON "payments" ("settlement_status")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_payments_settlement_status"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_payments_appointment"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_payments_paid_at"`);
    await q.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "metadata",
        DROP COLUMN IF EXISTS "failure_reason",
        DROP COLUMN IF EXISTS "refunded_at",
        DROP COLUMN IF EXISTS "refund_status",
        DROP COLUMN IF EXISTS "refunded_amount",
        DROP COLUMN IF EXISTS "sub_merchant_id",
        DROP COLUMN IF EXISTS "merchant_id",
        DROP COLUMN IF EXISTS "payment_method",
        DROP COLUMN IF EXISTS "net_amount",
        DROP COLUMN IF EXISTS "platform_fee",
        DROP COLUMN IF EXISTS "gateway_fee"
    `);
  }
}
