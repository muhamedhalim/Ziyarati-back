import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Idempotently ensures the analytics performance + integrity schema objects:
 *
 *  - Composite indexes on the SOURCE tables the aggregation engine scans by
 *    (tenant, …, time). The frozen entities only index a subset
 *    (`appointments` already has `(tenant,branch,start_at)`), leaving the
 *    revenue / customer / AI / conversation / review scans unindexed — full
 *    table scans at millions of rows. (Audit H1.)
 *  - A UNIQUE index on `dashboard_metrics (tenantId, metric_key, period)` so the
 *    snapshot upsert is atomic and concurrent refreshes can't create duplicate
 *    rows. Existing duplicates are de-duped first so the index can be created.
 *    (Audit H2.)
 *  - Indexes on `analytics_events` for the tenant-scoped listing filter and the
 *    retention purge sweep. (Audit: retention.)
 *
 * Why a bootstrap: dev runs `synchronize=true` (the migration does NOT run
 * there). Every statement is `IF NOT EXISTS` / fail-soft, so it is safe on every
 * boot in every environment; `1730000400000-AnalyticsHardening.ts` mirrors these
 * for migrations-first prod. FK columns follow TypeORM's default camelCase
 * naming in this project (`"tenantId"`, `"branchId"`, `"appointmentId"`).
 */
@Injectable()
export class AnalyticsSchemaBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('AnalyticsSchemaBootstrap');

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    // ── H1: source-table aggregation indexes ────────────────────────────────
    await this.run('payments revenue index', `
      CREATE INDEX IF NOT EXISTS idx_payments_revenue
      ON payments ("tenantId", "branchId", status, paid_at)
    `);
    await this.run('customers created index', `
      CREATE INDEX IF NOT EXISTS idx_customers_tenant_created
      ON customers ("tenantId", created_at)
    `);
    await this.run('ai_messages created index', `
      CREATE INDEX IF NOT EXISTS idx_ai_messages_tenant_created
      ON ai_messages ("tenantId", created_at)
    `);
    await this.run('conversations active index', `
      CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lastmsg
      ON conversations ("tenantId", last_message_at)
    `);
    await this.run('customer_reviews index', `
      CREATE INDEX IF NOT EXISTS idx_customer_reviews_tenant_created
      ON customer_reviews ("tenantId", created_at)
    `);
    await this.run('appointment_services join index', `
      CREATE INDEX IF NOT EXISTS idx_appointment_services_appt
      ON appointment_services ("appointmentId", "serviceId")
    `);

    // ── H2: dashboard_metrics uniqueness (dedupe THEN unique index) ──────────
    await this.run('dashboard_metrics dedupe', `
      DELETE FROM dashboard_metrics a
      USING dashboard_metrics b
      WHERE a.ctid < b.ctid
        AND a."tenantId" = b."tenantId"
        AND a.metric_key = b.metric_key
        AND a.period IS NOT DISTINCT FROM b.period
    `);
    await this.run('dashboard_metrics unique', `
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_metric
      ON dashboard_metrics ("tenantId", metric_key, period)
    `);

    // ── Analytics events: listing filter + retention purge ───────────────────
    await this.run('analytics_events listing index', `
      CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_created
      ON analytics_events ("tenantId", created_at)
    `);
    await this.run('analytics_events retention index', `
      CREATE INDEX IF NOT EXISTS idx_analytics_events_created
      ON analytics_events (created_at)
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
