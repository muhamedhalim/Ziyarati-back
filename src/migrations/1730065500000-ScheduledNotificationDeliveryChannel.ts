import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T015 (FR-G012, FR-M015). Makes the
 * channel used, and any skip reason, visible to the clinic. Own migration —
 * NOT folded into `1730065000000-NotificationRuleAnchor` (a different
 * table's concern) — see that migration's docblock for why a migration
 * named for one table must never carry another's columns.
 *
 * Non-round timestamp follows the existing `1730057100000-AuthTokenIndexes`
 * precedent, and keeps this ordered after the anchor migration.
 */
export class ScheduledNotificationDeliveryChannel1730065500000
  implements MigrationInterface
{
  name = 'ScheduledNotificationDeliveryChannel1730065500000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "scheduled_notifications"
        ADD COLUMN IF NOT EXISTS "channel" varchar(16),
        ADD COLUMN IF NOT EXISTS "skip_reason" varchar(40)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "scheduled_notifications"
        DROP COLUMN IF EXISTS "skip_reason",
        DROP COLUMN IF EXISTS "channel"
    `);
  }
}
