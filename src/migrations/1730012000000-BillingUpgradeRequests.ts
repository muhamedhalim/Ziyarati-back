import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Billing upgrade requests: a clinic owner requests a plan-excluded feature or
 * a usage-limit increase, a super admin quotes it, the owner accepts & pays
 * through the existing Moyasar/Payment flow, and the entitlement/limit is
 * applied only after confirmed payment. Plus its append-only status-history
 * table and the per-tenant usage-limit override that the entitlement lands on
 * (mirrors `feature_flags` for the boolean-feature case). Additive; idempotent
 * via IF NOT EXISTS, matching the SupportTickets migration precedent.
 */
export class BillingUpgradeRequests1730012000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "billing_upgrade_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "requestedById" uuid,
        "requested_by_name" character varying(160),
        "requested_by_email" character varying(255),
        "type" character varying(24) NOT NULL,
        "feature_key" character varying,
        "usage_metric" character varying(32),
        "current_usage" bigint,
        "current_limit" bigint,
        "requested_quantity" bigint,
        "approved_quantity" bigint,
        "status" character varying(32) NOT NULL DEFAULT 'pending_review',
        "currency" character varying(3) NOT NULL DEFAULT 'SAR',
        "billing_period" character varying(16),
        "ai_estimated_provider_cost_minor" bigint,
        "ai_estimated_infra_cost_minor" bigint,
        "ai_recommended_price_minor" bigint,
        "ai_confidence_score" numeric(5,4),
        "ai_assumptions" jsonb,
        "ai_pricing_breakdown" jsonb,
        "ai_estimate_error" text,
        "ai_estimate_generated_at" TIMESTAMP WITH TIME ZONE,
        "final_price_minor" bigint,
        "quote_expires_at" TIMESTAMP WITH TIME ZONE,
        "reviewerId" uuid,
        "reviewer_name" character varying(160),
        "reviewer_notes" text,
        "owner_approved_at" TIMESTAMP WITH TIME ZONE,
        "paymentId" uuid,
        "payment_reference" character varying,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "rejected_at" TIMESTAMP WITH TIME ZONE,
        "rejection_reason" text,
        "cancelled_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_upgrade_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_upgrade_requests_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id"),
        CONSTRAINT "FK_billing_upgrade_requests_requested_by" FOREIGN KEY ("requestedById")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_billing_upgrade_requests_reviewer" FOREIGN KEY ("reviewerId")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_billing_upgrade_requests_payment" FOREIGN KEY ("paymentId")
          REFERENCES "payments"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_upgrade_requests_tenant" ON "billing_upgrade_requests" ("tenantId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_upgrade_requests_status" ON "billing_upgrade_requests" ("status")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_upgrade_requests_created_at" ON "billing_upgrade_requests" ("created_at")`,
    );
    // Prevent a second concurrent request for the same tenant + feature/metric
    // while one is already active (pending_review / awaiting_owner_approval /
    // payment_processing / payment_failed) — one active request per target.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_upgrade_requests_active_target"
      ON "billing_upgrade_requests" ("tenantId", COALESCE("feature_key", "usage_metric"))
      WHERE "status" IN ('pending_review', 'awaiting_owner_approval', 'payment_processing', 'payment_failed')
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "billing_upgrade_request_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "requestId" uuid NOT NULL,
        "type" character varying(32) NOT NULL,
        "from_value" character varying(32),
        "to_value" character varying(32),
        "note" text,
        "metadata" jsonb,
        "internal_only" boolean NOT NULL DEFAULT false,
        "actorId" uuid,
        "actor_name" character varying(160),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_upgrade_request_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_upgrade_request_events_request" FOREIGN KEY ("requestId")
          REFERENCES "billing_upgrade_requests"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_billing_upgrade_request_events_actor" FOREIGN KEY ("actorId")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_upgrade_request_events_request" ON "billing_upgrade_request_events" ("requestId")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_upgrade_request_events_created_at" ON "billing_upgrade_request_events" ("created_at")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "tenant_usage_limit_overrides" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "metric" character varying(32) NOT NULL,
        "override_limit" bigint NOT NULL,
        "sourceRequestId" uuid,
        "grantedById" uuid,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_tenant_usage_limit_overrides" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tenant_usage_limit_overrides_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tenant_usage_limit_overrides_source_request" FOREIGN KEY ("sourceRequestId")
          REFERENCES "billing_upgrade_requests"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_tenant_usage_limit_overrides_granted_by" FOREIGN KEY ("grantedById")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_usage_limit_overrides_tenant" ON "tenant_usage_limit_overrides" ("tenantId")`,
    );
    // At most one ACTIVE override per (tenant, metric) — grant/extend replaces it.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_usage_limit_overrides_active"
      ON "tenant_usage_limit_overrides" ("tenantId", "metric")
      WHERE "is_active" = true
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "tenant_usage_limit_overrides"`);
    await q.query(`DROP TABLE IF EXISTS "billing_upgrade_request_events"`);
    await q.query(`DROP TABLE IF EXISTS "billing_upgrade_requests"`);
  }
}
