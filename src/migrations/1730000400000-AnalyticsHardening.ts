import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Analytics hardening schema (mirrors AnalyticsSchemaBootstrap):
 *  - H1: source-table aggregation indexes (payments/customers/ai_messages/
 *        conversations/customer_reviews/appointment_services)
 *  - H2: UNIQUE dashboard_metrics (tenantId, metric_key, period) for atomic upsert
 *  - analytics_events listing + retention indexes
 * Idempotent (IF NOT EXISTS); rollback drops only what it added.
 */
export class AnalyticsHardening1730000400000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS idx_payments_revenue ON payments ("tenantId", "branchId", status, paid_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_customers_tenant_created ON customers ("tenantId", created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_ai_messages_tenant_created ON ai_messages ("tenantId", created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lastmsg ON conversations ("tenantId", last_message_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_customer_reviews_tenant_created ON customer_reviews ("tenantId", created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_appointment_services_appt ON appointment_services ("appointmentId", "serviceId")`);

    await q.query(`
      DELETE FROM dashboard_metrics a USING dashboard_metrics b
      WHERE a.ctid < b.ctid
        AND a."tenantId" = b."tenantId"
        AND a.metric_key = b.metric_key
        AND a.period IS NOT DISTINCT FROM b.period
    `);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_metric ON dashboard_metrics ("tenantId", metric_key, period)`);

    await q.query(`CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_created ON analytics_events ("tenantId", created_at)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events (created_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_analytics_events_created`);
    await q.query(`DROP INDEX IF EXISTS idx_analytics_events_tenant_created`);
    await q.query(`DROP INDEX IF EXISTS uq_dashboard_metric`);
    await q.query(`DROP INDEX IF EXISTS idx_appointment_services_appt`);
    await q.query(`DROP INDEX IF EXISTS idx_customer_reviews_tenant_created`);
    await q.query(`DROP INDEX IF EXISTS idx_conversations_tenant_lastmsg`);
    await q.query(`DROP INDEX IF EXISTS idx_ai_messages_tenant_created`);
    await q.query(`DROP INDEX IF EXISTS idx_customers_tenant_created`);
    await q.query(`DROP INDEX IF EXISTS idx_payments_revenue`);
  }
}
