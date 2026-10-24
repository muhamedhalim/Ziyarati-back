import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ready-made notification rules (confirmation, 24h reminder, post-visit,
 * follow-up due, scheduled promotion, re-engagement) on the EXISTING rules engine.
 *
 * `notification_rules`
 *  - `rule_key`   which library rule a row is (NULL for every hand-made rule).
 *    Partial UNIQUE (tenant, rule_key): a clinic holds one row per library rule,
 *    which makes "seed the defaults" idempotent under a double call or two
 *    instances racing.
 *  - `name`, `conditions` (typed settings, never an expression: delay window,
 *    send window, inactivity days…), `updated_at`.
 *  - `last_run_at` / `last_error`: when the rule last scheduled something and the
 *    last scrubbed failure, for the rule card. No message content is stored.
 *
 * `scheduled_notifications.notification_rule_id`
 *  - which rule produced a row, so a rule's counts and execution list are exact
 *    (that table holds one row per message; `notification_logs` holds one per
 *    attempt and cannot be counted per message). ON DELETE SET NULL: deleting a
 *    rule never deletes message history.
 *
 * Everything is nullable/additive, so existing rules and rows are untouched and
 * keep behaving exactly as before. Idempotent.
 */
export class NotificationRuleLibrary1730128000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "notification_rules"
        ADD COLUMN IF NOT EXISTS "rule_key" character varying(64),
        ADD COLUMN IF NOT EXISTS "name" character varying(120),
        ADD COLUMN IF NOT EXISTS "conditions" jsonb,
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "last_run_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "last_error" character varying(200)
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_rules_tenant_rule_key"
        ON "notification_rules" ("tenantId", "rule_key")
        WHERE "rule_key" IS NOT NULL
    `);
    await q.query(`
      ALTER TABLE "scheduled_notifications"
        ADD COLUMN IF NOT EXISTS "notification_rule_id" uuid
    `);
    await q.query(`
      DO $$ BEGIN
        ALTER TABLE "scheduled_notifications"
          ADD CONSTRAINT "FK_scheduled_notifications_rule"
          FOREIGN KEY ("notification_rule_id") REFERENCES "notification_rules"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_notifications_rule"
        ON "scheduled_notifications" ("notification_rule_id", "created_at" DESC)
        WHERE "notification_rule_id" IS NOT NULL
    `);
  }

  /** R-DB6: additive columns are never dropped on rollback; only the indexes go. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_scheduled_notifications_rule"`);
    await q.query(
      `DROP INDEX IF EXISTS "UQ_notification_rules_tenant_rule_key"`,
    );
  }
}
