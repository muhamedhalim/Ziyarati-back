import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11.
 *
 * `usage_report_schedules.target` was a single recipient (email address or
 * webhook URL). For EMAIL delivery this is extended to accept a
 * COMMA-SEPARATED list (fully backward compatible — an existing single
 * address parses to a one-element list, identical behavior); `target` itself
 * is unchanged (still a plain string column).
 *
 * `last_run_recipient_status` is the new state this enables: a per-recipient
 * `{ [email]: 'SENT' }` map, written to the DATABASE after EACH recipient
 * send succeeds (not just once at the end of the run) — see
 * `UsageReportService.deliver`. That incremental write is what survives a
 * hard process crash mid-loop (an OS kill, not a catchable JS exception),
 * which a purely in-memory "retry the ones that failed" scheme cannot: no
 * code after a hard kill ever runs, including any final catch block. Without
 * this, a crash after recipient #1 of #3 succeeded, followed by a retry,
 * would resend to recipient #1 a second time.
 *
 * Cleared back to `{}` once a run fully completes (every recipient sent) —
 * it tracks progress WITHIN the current due-cycle, not history across cycles.
 * Nullable/additive: existing rows get NULL, treated as "nothing sent yet".
 */
export class UsageReportRecipientStatus1730017000000 implements MigrationInterface {
  name = 'UsageReportRecipientStatus1730017000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'usage_report_schedules' AND column_name = 'last_run_recipient_status'
        ) THEN
          ALTER TABLE "usage_report_schedules" ADD COLUMN "last_run_recipient_status" JSONB NULL;
        END IF;
      END $$;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "usage_report_schedules" DROP COLUMN IF EXISTS "last_run_recipient_status"`);
  }
}
