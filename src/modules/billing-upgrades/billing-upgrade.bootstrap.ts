import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
  private readonly logger = new Logger('BillingUpgradeBootstrap');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run('one active billing-upgrade request per tenant+target', `
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_upgrade_requests_active_target"
      ON "billing_upgrade_requests" ("tenantId", COALESCE("feature_key", "usage_metric"))
      WHERE "status" IN ('pending_review', 'awaiting_owner_approval', 'payment_processing', 'payment_failed')
    `);

    await this.run('one active usage-limit override per tenant+metric', `
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenant_usage_limit_overrides_active"
      ON "tenant_usage_limit_overrides" ("tenantId", "metric")
      WHERE "is_active" = true
    `);
  }

  private async run(label: string, sql: string): Promise<void> {
    try {
      await this.dataSource.query(sql);
    } catch (err) {
      this.logger.warn(`Skipped "${label}": ${(err as Error).message}`);
    }
  }
}
