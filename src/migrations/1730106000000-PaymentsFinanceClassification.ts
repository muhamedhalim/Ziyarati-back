import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payments — finance classification (Tap migration, Phase 2 / plan §17 M1).
 *
 * ADDS three columns to `payments` (all additive; nothing renamed, nothing
 * deleted, no Moyasar id rewritten):
 *
 *   purpose            varchar(24) NOT NULL DEFAULT 'BOOKING'
 *   settlement_mode    varchar(16) NOT NULL DEFAULT 'INTERNAL'
 *   fees_reconciled_at timestamptz NULL
 *
 * WHY. `payments` mixed two different kinds of money and nothing recorded
 * which was which: a patient paying a clinic (the clinic's money) and a clinic
 * paying the platform for an add-on or an upgrade (the platform's money). The
 * settlement run claims every PAID payment of a tenant, so a clinic's own
 * add-on purchase was being batched as money owed BACK to that clinic.
 *
 * BACKFILL (each statement is a single set-based UPDATE — no loop, so there is
 * no batch-iteration hazard):
 *   1. purpose = 'BILLING_UPGRADE' + settlement_mode = 'NONE'
 *        where billing_upgrade_requests."paymentId" points at the row;
 *   2. purpose = 'ADDON' + settlement_mode = 'NONE'
 *        where resource_purchases."paymentId" points at the row;
 *   3. purpose = 'MANUAL' where there is no appointment and (1)/(2) did not match;
 *   4. fees_reconciled_at = paid_at for historical `gateway = 'moyasar'` rows that
 *      carry a NON-ZERO fee. Moyasar reports the fee in the payment object at
 *      capture, so a recorded fee was final. A row whose fee is 0 is left NULL
 *      (provisional): we cannot prove 0 was a real fee rather than an absent one.
 *      Noop/simulator rows are never stamped.
 * Everything else keeps the column defaults, i.e. BOOKING / INTERNAL, which is
 * exactly how those rows have always been treated.
 *
 * NOT TOUCHED, ON PURPOSE: `settlement_status` of rows that were already claimed
 * into a settlement before this fix. Re-writing settlement history is a business
 * decision, not a migration's. phase-2 spec §"Operator" has the read-only SQL
 * that lists any add-on / upgrade payment already IN_BATCH or SETTLED.
 *
 * `merchant_accounts` / `settlements` columns from plan §17 M1 are deliberately
 * NOT added here: nothing reads them until Tap onboarding (Phase 4) and payout
 * import (Phase 5), and a column nothing reads is misleading. Those phases add them.
 *
 * Every object below is ALSO declared on the `Payment` entity (same names), so a
 * schema built from metadata carries it and `synchronize` does not drop it.
 *
 * REVERSIBLE.
 */
export class PaymentsFinanceClassification1730106000000 implements MigrationInterface {
  name = 'PaymentsFinanceClassification1730106000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "payments"
         ADD COLUMN IF NOT EXISTS "purpose" varchar(24) NOT NULL DEFAULT 'BOOKING'`,
    );
    await q.query(
      `ALTER TABLE "payments"
         ADD COLUMN IF NOT EXISTS "settlement_mode" varchar(16) NOT NULL DEFAULT 'INTERNAL'`,
    );
    await q.query(
      `ALTER TABLE "payments"
         ADD COLUMN IF NOT EXISTS "fees_reconciled_at" timestamptz NULL`,
    );

    // 1. Platform revenue: billing upgrades.
    await q.query(
      `UPDATE "payments" p
          SET "purpose" = 'BILLING_UPGRADE', "settlement_mode" = 'NONE'
         FROM "billing_upgrade_requests" b
        WHERE b."paymentId" = p."id"`,
    );
    // 2. Platform revenue: resource add-ons.
    await q.query(
      `UPDATE "payments" p
          SET "purpose" = 'ADDON', "settlement_mode" = 'NONE'
         FROM "resource_purchases" r
        WHERE r."paymentId" = p."id"`,
    );
    // 3. Clinic money that is not tied to a booking (staff POS style).
    await q.query(
      `UPDATE "payments"
          SET "purpose" = 'MANUAL'
        WHERE "appointmentId" IS NULL AND "purpose" = 'BOOKING'`,
    );
    // 4. Historical Moyasar fees that were final at capture.
    await q.query(
      `UPDATE "payments"
          SET "fees_reconciled_at" = "paid_at"
        WHERE "gateway" = 'moyasar'
          AND "gateway_fee" > 0
          AND "paid_at" IS NOT NULL
          AND "status" IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED')
          AND "fees_reconciled_at" IS NULL`,
    );

    await q.query(
      `CREATE INDEX IF NOT EXISTS "idx_payments_tenant_purpose_status"
         ON "payments" ("tenantId", "purpose", "status")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_payments_tenant_purpose_status"`);
    await q.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "fees_reconciled_at"`,
    );
    await q.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "settlement_mode"`,
    );
    await q.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "purpose"`);
  }
}
