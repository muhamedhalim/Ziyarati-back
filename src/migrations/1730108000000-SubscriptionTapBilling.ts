import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tap migration (Phase 3, plan §17 M3) — what the subscription lifecycle needs
 * to take a real payment. All additive; nothing renamed, deleted or rewritten.
 *
 *  subscriptions
 *    + pending_plan_id uuid NULL  FK -> subscription_plans ON DELETE SET NULL
 *        (D4: a downgrade scheduled for the next renewal)
 *
 *  subscription_invoices
 *    + kind                varchar(16) NULL   INITIAL | UPGRADE | RENEWAL | REACTIVATION
 *                                              (NULL = a legacy invoice; settling one only marks it PAID)
 *    + target_plan_id      uuid NULL          the plan this invoice pays for
 *    + provider            varchar(32) NULL   which gateway settled / is settling it
 *    + payment_method_id   uuid NULL          the saved card it was charged to
 *    + checkout_charge_id  varchar(64) NULL   most recent hosted charge
 *    + checkout_started_at timestamptz NULL   when that checkout was opened
 *    + checkout_attempts   integer NOT NULL DEFAULT 0   makes each checkout's idempotency key unique
 *      No FK on target_plan_id / payment_method_id: this table has never had foreign
 *      keys (`tenant_id` is varchar, `subscription_id` has none — P03-006), so adding
 *      two here would be the odd one out and could not be declared in entity
 *      metadata without a relation this table does not otherwise use.
 *
 *  tenant_payment_methods (new)
 *    A clinic's saved card AS THE GATEWAY KNOWS IT: three opaque gateway ids plus
 *    brand / scheme / last four. No PAN, CVV or expiry. One ACTIVE default per
 *    tenant; one card id across the whole platform.
 *
 * Backfill: NONE. Existing subscriptions and invoices keep NULL in every new
 * column, which is exactly how the code reads "legacy".
 *
 * Every object below is ALSO declared on its entity (same names), so a schema
 * built from metadata carries it and `synchronize` cannot drop it.
 *
 * REVERSIBLE (drops only what this migration adds).
 */
export class SubscriptionTapBilling1730108000000 implements MigrationInterface {
  name = 'SubscriptionTapBilling1730108000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pending_plan_id" uuid`,
    );
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_subscriptions_pending_plan'
        ) THEN
          ALTER TABLE "subscriptions"
            ADD CONSTRAINT "FK_subscriptions_pending_plan"
            FOREIGN KEY ("pending_plan_id") REFERENCES "subscription_plans"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
        END IF;
      END $$;
    `);

    await q.query(`
      ALTER TABLE "subscription_invoices"
        ADD COLUMN IF NOT EXISTS "kind" varchar(16),
        ADD COLUMN IF NOT EXISTS "target_plan_id" uuid,
        ADD COLUMN IF NOT EXISTS "provider" varchar(32),
        ADD COLUMN IF NOT EXISTS "payment_method_id" uuid,
        ADD COLUMN IF NOT EXISTS "checkout_charge_id" varchar(64),
        ADD COLUMN IF NOT EXISTS "checkout_started_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "checkout_attempts" integer NOT NULL DEFAULT 0
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "tenant_payment_methods" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "provider" varchar(32) NOT NULL,
        "provider_customer_id" varchar(64) NOT NULL,
        "provider_card_id" varchar(64) NOT NULL,
        "provider_payment_agreement_id" varchar(96) NOT NULL,
        "brand" varchar(32),
        "scheme" varchar(32),
        "last_four" char(4),
        "recurring_capable" boolean NOT NULL DEFAULT true,
        "is_default" boolean NOT NULL DEFAULT false,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "source_invoice_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        CONSTRAINT "PK_tenant_payment_methods" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tenant_payment_methods_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_payment_method_card"
         ON "tenant_payment_methods" ("provider_card_id")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_payment_method_default"
         ON "tenant_payment_methods" ("tenant_id")
         WHERE "is_default" = true AND "status" = 'ACTIVE'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "tenant_payment_methods"`);
    await q.query(`
      ALTER TABLE "subscription_invoices"
        DROP COLUMN IF EXISTS "checkout_attempts",
        DROP COLUMN IF EXISTS "checkout_started_at",
        DROP COLUMN IF EXISTS "checkout_charge_id",
        DROP COLUMN IF EXISTS "payment_method_id",
        DROP COLUMN IF EXISTS "provider",
        DROP COLUMN IF EXISTS "target_plan_id",
        DROP COLUMN IF EXISTS "kind"
    `);
    await q.query(
      `ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_subscriptions_pending_plan"`,
    );
    await q.query(
      `ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "pending_plan_id"`,
    );
  }
}
