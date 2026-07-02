import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the platform's count-based resources quota-aware by adding absolute-cap
 * columns to `subscription_plans` (nullable = unlimited). These caps are resolved
 * exclusively through `UsageService` so the Subscription Module remains the single
 * source of truth for every limit — no limit is ever hardcoded in a dashboard.
 *
 * Metered per-period metrics (AI tokens, WhatsApp, appointments, campaigns) keep
 * their existing `max_*` columns + `subscription_usage` accumulators; this only
 * adds the count-based resource caps.
 */
export class SubscriptionPlanResourceLimits1730002000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_plans"
        ADD COLUMN IF NOT EXISTS "max_ai_requests" integer,
        ADD COLUMN IF NOT EXISTS "max_customers" integer,
        ADD COLUMN IF NOT EXISTS "max_crm_contacts" integer,
        ADD COLUMN IF NOT EXISTS "max_conversations" integer,
        ADD COLUMN IF NOT EXISTS "max_storage_bytes" bigint,
        ADD COLUMN IF NOT EXISTS "max_uploaded_files" integer,
        ADD COLUMN IF NOT EXISTS "max_api_calls" bigint,
        ADD COLUMN IF NOT EXISTS "max_emails" integer,
        ADD COLUMN IF NOT EXISTS "max_invoices" integer,
        ADD COLUMN IF NOT EXISTS "max_payments" integer,
        ADD COLUMN IF NOT EXISTS "max_transactions" integer,
        ADD COLUMN IF NOT EXISTS "max_knowledge_base_files" integer,
        ADD COLUMN IF NOT EXISTS "max_training_files" integer
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_plans"
        DROP COLUMN IF EXISTS "max_training_files",
        DROP COLUMN IF EXISTS "max_knowledge_base_files",
        DROP COLUMN IF EXISTS "max_transactions",
        DROP COLUMN IF EXISTS "max_payments",
        DROP COLUMN IF EXISTS "max_invoices",
        DROP COLUMN IF EXISTS "max_emails",
        DROP COLUMN IF EXISTS "max_api_calls",
        DROP COLUMN IF EXISTS "max_uploaded_files",
        DROP COLUMN IF EXISTS "max_storage_bytes",
        DROP COLUMN IF EXISTS "max_conversations",
        DROP COLUMN IF EXISTS "max_crm_contacts",
        DROP COLUMN IF EXISTS "max_customers",
        DROP COLUMN IF EXISTS "max_ai_requests"
    `);
  }
}
