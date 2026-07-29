import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.5.
 *
 * `notification_logs` had no "when was this claimed" timestamp, so the
 * WhatsApp send claim (QUEUED -> SENDING, see `WhatsappExecutionService`) had
 * no way to tell "another worker is CURRENTLY sending this" apart from "a
 * previous attempt crashed mid-send and this row has been stuck in SENDING
 * ever since" — both looked identical (`status = 'SENDING'`), so a message
 * whose worker died mid-send could NEVER be retried: the row stayed SENDING
 * forever and every later claim attempt (including BullMQ's own legitimate
 * stalled-job redelivery) was rejected as "already claimed".
 *
 * `claimed_at` lets the claim distinguish the two: a SENDING row is only
 * reclaimable once `claimed_at` is older than a stale threshold. Fully
 * additive, nullable — existing rows (all pre-dating this claim mechanism)
 * get NULL, which the claim query treats as "no claim timestamp recorded",
 * i.e. safely reclaimable rather than blocking forever.
 */
export class NotificationLogClaim1730015000000 implements MigrationInterface {
  name = 'NotificationLogClaim1730015000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'notification_logs' AND column_name = 'claimed_at'
        ) THEN
          ALTER TABLE "notification_logs" ADD COLUMN "claimed_at" TIMESTAMPTZ NULL;
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "claimed_at"`);
  }
}
