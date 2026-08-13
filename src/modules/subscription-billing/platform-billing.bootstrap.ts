import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Idempotently ensures the free-access-override ledger exists.
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
 * The global billing mode is NOT created here: it lives in the existing
 * `system_settings` table (key = billing.mode) and defaults in code when absent.
 */
@Injectable()
export class PlatformBillingBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('PlatformBillingBootstrap');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run(
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
  }

  private async run(label: string, sql: string): Promise<void> {
    try {
      await this.dataSource.query(sql);
    } catch (err) {
      this.logger.warn(`Skipped "${label}": ${(err as Error).message}`);
    }
  }
}
