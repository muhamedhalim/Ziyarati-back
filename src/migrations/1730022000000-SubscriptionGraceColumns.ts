import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-03 (FND-031) — adds the two grace-tracking columns and backfills the
 * three population classes per data-model.md's disposition table. Depends on
 * M-02 (`SubscriptionGraceExpiredEnum`) having already committed — enforced
 * structurally by running strictly later (this migration's timestamp is
 * newer) and proven explicitly by `test/migration-order.e2e-spec.ts` (T080).
 *
 * Disposition (data-model.md §M-03), verified live: 0 subscriptions today
 * (R-DB9 — this proves nothing about production; MUST be re-assessed there):
 *  - Currently valid (ACTIVE/TRIAL, ends_at > now): grace_started_at stays
 *    NULL — genuinely `active`. New nullable columns default to NULL, so
 *    this class needs no explicit UPDATE.
 *  - Terminal (CANCELLED/SUSPENDED): untouched — not part of the grace
 *    machine. Also already NULL by default.
 *  - Already-expired (ends_at <= now, non-terminal): backfilled to PAST_DUE
 *    with grace_started_at = THIS MIGRATION'S RUN TIME, deliberately NOT
 *    `ends_at` — every affected tenant gets a FULL fresh grace window
 *    measured from deployment, so nobody is retroactively cut off at
 *    rollout (FR-B007i). Affected row count is logged both before and after.
 */
export class SubscriptionGraceColumns1730022000000
  implements MigrationInterface
{
  name = 'SubscriptionGraceColumns1730022000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grace_started_at" timestamptz`,
    );
    await q.query(
      `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grace_expired_at" timestamptz`,
    );

    const [{ count: beforeCount }] = await q.query(
      `SELECT count(*)::text AS count FROM "subscriptions" WHERE "ends_at" <= now() AND "status" NOT IN ('CANCELLED','SUSPENDED')`,
    );
    console.log(
      `M-03: ${beforeCount} already-expired non-terminal subscription(s) found — backfilling to PAST_DUE with a fresh grace window from now().`,
    );

    const result = await q.query(
      `UPDATE "subscriptions"
       SET "status" = 'PAST_DUE', "grace_started_at" = now()
       WHERE "ends_at" <= now() AND "status" NOT IN ('CANCELLED','SUSPENDED')`,
    );
    console.log(`M-03: backfilled ${result[1] ?? beforeCount} row(s) to PAST_DUE.`);
  }

  /**
   * Columns are NOT dropped (R-DB6) — a cease-use rollback, not a schema
   * reversal. The application simply stops reading them; any subscription
   * this migration flipped to PAST_DUE stays PAST_DUE (that status value
   * predates this migration and is not itself reverted, matching the
   * "no destructive operations" rule — reverting it would silently move a
   * tenant back to ACTIVE with no re-verification of payment).
   */
  public async down(): Promise<void> {
    // Deliberately no-op beyond the column retention already stated above.
  }
}
