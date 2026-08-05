import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FND-020 — adds the durable marker `campaign_recipients.dlq_recorded_at`,
 * without which a recovery sweep has no way to tell "confirmed written to the
 * campaigns DLQ" apart from "dead-lettered in Postgres but the DLQ enqueue
 * itself silently failed" (Redis hiccup at that exact moment) — today that
 * distinction doesn't exist anywhere, so a failed DLQ write is permanently
 * invisible with no retry.
 *
 * Backfill: existing dead-lettered rows (`failure_class = 'TRANSIENT'`) are
 * stamped with their own `created_at` as a best-effort "already confirmed"
 * marker — the overwhelmingly common case is that the original enqueue DID
 * succeed, so this avoids the very first post-deploy sweep re-attempting a
 * DLQ write for the tenant's entire dead-letter history. Going forward the
 * sweep only concerns itself with genuinely new gaps.
 */
export class CampaignRecipientDlqRecordedAt1730023000000
  implements MigrationInterface
{
  name = 'CampaignRecipientDlqRecordedAt1730023000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "campaign_recipients" ADD COLUMN IF NOT EXISTS "dlq_recorded_at" timestamptz`,
    );

    const result = await q.query(
      `UPDATE "campaign_recipients"
       SET "dlq_recorded_at" = "created_at"
       WHERE "failure_class" = 'TRANSIENT' AND "dlq_recorded_at" IS NULL`,
    );
    console.log(
      `FND-020: backfilled dlq_recorded_at for ${result[1] ?? 0} existing dead-lettered recipient(s).`,
    );
  }

  /** Column is NOT dropped (R-DB6) — the application simply stops reading it. */
  public async down(): Promise<void> {
    // Deliberately no-op.
  }
}
