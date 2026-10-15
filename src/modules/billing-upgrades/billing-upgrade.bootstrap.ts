import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * Idempotently ensures the two partial UNIQUE indexes this domain relies on
 * exist, even in dev (where `synchronize=true` creates tables/columns from
 * entities but partial `WHERE` indexes aren't expressible as column
 * decorators). Mirrors `PaymentsSchemaBootstrap` — `IF NOT EXISTS`, fails soft
 * per statement, and the canonical migration creates the same indexes for
 * migrations-first prod.
 */
@Injectable()
export class BillingUpgradeBootstrap implements OnApplicationBootstrap {
  constructor(
    private readonly dataSource: DataSource,
    private readonly guards: SchemaGuardRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.require(
      'one active billing-upgrade request per tenant+target',
      `
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_upgrade_requests_active_target"
      ON "billing_upgrade_requests" ("tenantId", COALESCE("feature_key", "usage_metric"))
      WHERE "status" IN ('pending_review', 'awaiting_owner_approval', 'payment_processing', 'payment_failed')
    `,
    );

    await this.require(
      'one active usage-limit override per tenant+metric',
      `
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_usage_limit_overrides_active"
      ON "tenant_usage_limit_overrides" ("tenantId", "metric")
      WHERE "is_active" = true
    `,
    );
  }

  /**
   * A DB-enforced integrity guard. Failure is an ERROR and degrades readiness
   * (`SchemaGuardRegistry`) — never a `warn` that scrolls past.
   */
  private async require(label: string, sql: string): Promise<void> {
    await this.guards.ensure({
      owner: 'BillingUpgradeBootstrap',
      label,
      criticality: 'required',
      run: () => this.dataSource.query(sql),
    });
  }
}
