import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * Idempotently ensures the free-access-override ledger, and the Pricing
 * Catalog's `tenant_entitlement_ledger` / `tenant_metric_credits` tables,
 * exist.
 *
 * Mirrors the established schema-bootstrap pattern (PaymentsSchemaBootstrap):
 * entities under `src/entities/**` are FROZEN and there is no migration in dev
 * (synchronize=true), so a NEW table is created here with `CREATE TABLE IF NOT
 * EXISTS`. This is safe to run on every boot in every environment, works under
 * dev `synchronize` and migrations-first prod alike, and fails SOFT per
 * statement so a permissions hiccup never blocks startup.
 *
 * `free_access_overrides` is accessed via raw SQL (FreeAccessOverrideService) so
 * it carries no TypeORM entity — avoiding dev `synchronize` churn and matching
 * how `settlement_adjustments` is handled in the Payments domain.
 *
 * `tenant_entitlement_ledger` / `tenant_metric_credits` are the same story
 * (`TenantEntitlementLedgerService` / `TenantMetricCreditsService`, both raw
 * SQL, no entity) — their canonical DDL lives in migration
 * `1730043000000-ResourcePricingCatalog`, which a dev `synchronize=true` box
 * never runs, so without this bootstrap those two tables simply never exist
 * there (confirmed: `relation "tenant_metric_credits" does not exist` on
 * `GET /usage/breakdown`, and the same gap silently makes every
 * `TenantEntitlementLedgerService.capacityMap` caller — branches/seats/
 * customers/uploaded/knowledge-base/training-file limits, storage, usage
 * breakdown — treat the tenant as having zero capacity add-ons). The blocks
 * below are copied verbatim from that migration so dev (`synchronize`) and
 * migrations-first prod converge on the identical schema; the migration
 * itself remains the source of truth for a fresh migrations-first database.
 *
 * The global billing mode is NOT created here: it lives in the existing
 * `system_settings` table (key = billing.mode) and defaults in code when absent.
 */
@Injectable()
export class PlatformBillingBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly dataSource: DataSource,
    private readonly guards: SchemaGuardRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.require(
      'free_access_overrides table',
      `
      CREATE TABLE IF NOT EXISTS free_access_overrides (
        id          uuid PRIMARY KEY,
        tenant_id   uuid NOT NULL,
        granted_by  uuid,
        reason      text,
        starts_at   timestamptz NOT NULL DEFAULT now(),
        ends_at     timestamptz,
        status      varchar(20) NOT NULL DEFAULT 'ACTIVE',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz
      )
    `,
    );

    // Fast lookup of a tenant's current override (the hot path on every gated
    // request runs `WHERE tenant_id = $ AND status = 'ACTIVE'`).
    await this.run(
      'free_access_overrides active index',
      `
      CREATE INDEX IF NOT EXISTS idx_free_override_tenant_status
      ON free_access_overrides (tenant_id, status)
    `,
    );

    // ── tenant_entitlement_ledger — verbatim from 1730043000000 ────────────
    await this.require(
      'tenant_entitlement_ledger table',
      `
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
    `,
    );
    await this.run(
      'tenant_entitlement_ledger tenant/metric/kind index',
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_entitlement_ledger_tenant_metric_kind" ON "tenant_entitlement_ledger" ("tenantId", "metric", "kind")`,
    );
    await this.require(
      'tenant_entitlement_ledger source-purchase unique (one grant per purchase)',
      `
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_entitlement_ledger_source_purchase"
      ON "tenant_entitlement_ledger" ("sourcePurchaseId")
      WHERE "sourcePurchaseId" IS NOT NULL AND "direction" = 'grant'
    `,
    );
    await this.require(
      'tenant_entitlement_ledger source-refund unique (one reversal per refund)',
      `
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_entitlement_ledger_source_refund"
      ON "tenant_entitlement_ledger" ("sourceRefundId")
      WHERE "sourceRefundId" IS NOT NULL
    `,
    );

    // ── tenant_metric_credits — verbatim from 1730043000000 ────────────────
    await this.require(
      'tenant_metric_credits table',
      `
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
    `,
    );
  }

  /**
   * A DB-enforced integrity guard. Failure is an ERROR and degrades readiness
   * (`SchemaGuardRegistry`) — never a `warn` that scrolls past.
   */
  private async require(label: string, sql: string): Promise<void> {
    await this.guards.ensure({
      owner: 'PlatformBillingBootstrap',
      label,
      criticality: 'required',
      run: () => this.dataSource.query(sql),
    });
  }

  /** A performance index. Losing one costs latency, not correctness. */
  private async run(label: string, sql: string): Promise<void> {
    await this.guards.ensure({
      owner: 'PlatformBillingBootstrap',
      label,
      criticality: 'optional',
      run: () => this.dataSource.query(sql),
    });
  }
}
