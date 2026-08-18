import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pricing Catalog — schema for admin-priced, self-serve resource add-ons
 * (plan §16). Five new tables, additive and idempotent (IF NOT EXISTS),
 * styled on `1730012000000-BillingUpgradeRequests.ts`: quoted identifiers,
 * named PK/FK constraints, partial unique indexes for the append-only rules.
 *
 *  - `resource_price_catalog`        — admin-owned unit pricing per sellable
 *    item (see `sellable-resource.registry.ts`, Phase 1.1).
 *  - `resource_price_change_events`  — append-only price-change audit trail.
 *  - `resource_purchases`            — the commercial record AND the price
 *    snapshot (plan §17): once inserted, nothing downstream re-reads the
 *    catalog for price/unit_size/quantity.
 *  - `tenant_entitlement_ledger`     — append-only capacity grants/revokes,
 *    positive magnitude + `direction`, mirroring `settlement_adjustments`'
 *    house pattern (never UPDATEd or DELETEd; a revoke is an opposite row).
 *  - `tenant_metric_credits`         — the maintained (not derived) prepaid
 *    credit balance per (tenant, metric) for the four metered metrics.
 *
 * No existing table is altered by this migration — `subscription_plans`'
 * `limit_declarations` column belongs to Phase 0.2, tracked separately.
 */
export class ResourcePricingCatalog1730043000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ── resource_price_catalog ──────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "resource_price_catalog" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "item_key" character varying(64) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "unit_label" character varying(32) NOT NULL,
        "unit_size" bigint NOT NULL DEFAULT 1,
        "unit_price_minor" bigint NOT NULL DEFAULT 0,
        "currency" character varying(3) NOT NULL DEFAULT 'SAR',
        "min_quantity" integer NOT NULL DEFAULT 1,
        "max_quantity" integer,
        "is_active" boolean NOT NULL DEFAULT false,
        "sort_order" integer NOT NULL DEFAULT 0,
        "updatedById" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_price_catalog" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_resource_price_catalog_unit_price_minor" CHECK ("unit_price_minor" >= 0),
        CONSTRAINT "CHK_resource_price_catalog_min_quantity" CHECK ("min_quantity" >= 1),
        CONSTRAINT "CHK_resource_price_catalog_max_quantity" CHECK ("max_quantity" IS NULL OR "max_quantity" >= "min_quantity"),
        CONSTRAINT "FK_resource_price_catalog_updated_by" FOREIGN KEY ("updatedById")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_resource_price_catalog_item_key" ON "resource_price_catalog" ("item_key")`,
    );

    // ── resource_price_change_events ────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "resource_price_change_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "catalogItemId" uuid NOT NULL,
        "item_key" character varying(64) NOT NULL,
        "field" character varying(32) NOT NULL,
        "from_value" text,
        "to_value" text,
        "actorId" uuid,
        "actor_email" character varying(255),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_price_change_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_resource_price_change_events_catalog_item" FOREIGN KEY ("catalogItemId")
          REFERENCES "resource_price_catalog"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_resource_price_change_events_actor" FOREIGN KEY ("actorId")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resource_price_change_events_catalog_item" ON "resource_price_change_events" ("catalogItemId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resource_price_change_events_created_at" ON "resource_price_change_events" ("created_at")`,
    );

    // ── resource_purchases ───────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "resource_purchases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "purchasedById" uuid,
        "purchased_by_email" character varying(255),
        "catalogItemId" uuid,
        "item_key" character varying(64) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "unit_label" character varying(32) NOT NULL,
        "unit_size" bigint NOT NULL,
        "quantity" integer NOT NULL,
        "unit_price_minor" bigint NOT NULL,
        "total_minor" bigint NOT NULL,
        "delta_units" bigint NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'SAR',
        "status" character varying(32) NOT NULL DEFAULT 'payment_processing',
        "idempotency_key" character varying(64) NOT NULL,
        "paymentId" uuid,
        "payment_reference" character varying,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "failed_at" TIMESTAMP WITH TIME ZONE,
        "refunded_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_resource_purchases" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_resource_purchases_unit_size" CHECK ("unit_size" > 0),
        CONSTRAINT "CHK_resource_purchases_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "CHK_resource_purchases_unit_price_minor" CHECK ("unit_price_minor" > 0),
        CONSTRAINT "CHK_resource_purchases_total_minor" CHECK ("total_minor" > 0),
        CONSTRAINT "CHK_resource_purchases_delta_units" CHECK ("delta_units" > 0),
        CONSTRAINT "FK_resource_purchases_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id"),
        CONSTRAINT "FK_resource_purchases_purchased_by" FOREIGN KEY ("purchasedById")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_resource_purchases_catalog_item" FOREIGN KEY ("catalogItemId")
          REFERENCES "resource_price_catalog"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_resource_purchases_payment" FOREIGN KEY ("paymentId")
          REFERENCES "payments"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resource_purchases_tenant" ON "resource_purchases" ("tenantId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resource_purchases_status" ON "resource_purchases" ("status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_resource_purchases_created_at" ON "resource_purchases" ("created_at")`,
    );
    // Client-generated idempotency key (plan §13) — tenant-scoped, no TTL.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_resource_purchases_tenant_idempotency"
      ON "resource_purchases" ("tenantId", "idempotency_key")
    `);

    // ── tenant_entitlement_ledger ────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "tenant_entitlement_ledger" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "metric" character varying(48) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "direction" character varying(8) NOT NULL,
        "amount_units" bigint NOT NULL,
        "unrecoverable_units" bigint NOT NULL DEFAULT 0,
        "reason" character varying(32) NOT NULL,
        "sourcePurchaseId" uuid,
        "sourceRefundId" uuid,
        "actorId" uuid,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_entitlement_ledger" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_tenant_entitlement_ledger_amount_units" CHECK ("amount_units" > 0),
        CONSTRAINT "CHK_tenant_entitlement_ledger_direction" CHECK ("direction" IN ('grant', 'revoke')),
        CONSTRAINT "FK_tenant_entitlement_ledger_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tenant_entitlement_ledger_source_purchase" FOREIGN KEY ("sourcePurchaseId")
          REFERENCES "resource_purchases"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_tenant_entitlement_ledger_source_refund" FOREIGN KEY ("sourceRefundId")
          REFERENCES "refunds"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_tenant_entitlement_ledger_actor" FOREIGN KEY ("actorId")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_entitlement_ledger_tenant_metric_kind" ON "tenant_entitlement_ledger" ("tenantId", "metric", "kind")`,
    );
    // One grant per paid purchase — the DB backstop behind the listener's
    // own idempotency check (plan §20).
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_entitlement_ledger_source_purchase"
      ON "tenant_entitlement_ledger" ("sourcePurchaseId")
      WHERE "sourcePurchaseId" IS NOT NULL AND "direction" = 'grant'
    `);
    // A given refund reverses entitlement exactly once — mirrors
    // `uq_settlement_adj_refund` on `settlement_adjustments`.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_entitlement_ledger_source_refund"
      ON "tenant_entitlement_ledger" ("sourceRefundId")
      WHERE "sourceRefundId" IS NOT NULL
    `);

    // ── tenant_metric_credits ────────────────────────────────────────────
    // Composite PK (tenantId, metric) — the MAINTAINED balance (not derived
    // from the ledger), so the hot debit path is a single-row PK hit.
    await q.query(`
      CREATE TABLE IF NOT EXISTS "tenant_metric_credits" (
        "tenantId" uuid NOT NULL,
        "metric" character varying(48) NOT NULL,
        "credited_units" bigint NOT NULL DEFAULT 0,
        "debited_units" bigint NOT NULL DEFAULT 0,
        "balance_units" bigint NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_metric_credits" PRIMARY KEY ("tenantId", "metric"),
        CONSTRAINT "CHK_tenant_metric_credits_balance_units" CHECK ("balance_units" >= 0),
        CONSTRAINT "FK_tenant_metric_credits_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "tenant_metric_credits"`);
    await q.query(`DROP TABLE IF EXISTS "tenant_entitlement_ledger"`);
    await q.query(`DROP TABLE IF EXISTS "resource_purchases"`);
    await q.query(`DROP TABLE IF EXISTS "resource_price_change_events"`);
    await q.query(`DROP TABLE IF EXISTS "resource_price_catalog"`);
  }
}
