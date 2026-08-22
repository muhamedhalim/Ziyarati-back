import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AUTH-002 / AUTH-003 remediation — adds rotation LINEAGE to `refresh_tokens`.
 *
 * Before this migration the table carried no relationship between a token and
 * the token it was rotated from, so reuse detection could only express "the
 * family" as "every session this user owns anywhere" — a single replay signed
 * the user out of every device (proved in the audit: C7 killed an unrelated
 * bystander session; C9 replayed one revoked token three times and destroyed
 * the victim's freshly-created session each time). See
 * docs/AUTH_CONCURRENCY_GC_AUDIT.md §4.
 *
 * Columns added:
 *  - `family_id`      — the rotation chain. One login = one family; every child
 *                       inherits its parent's value. Reuse detection revokes
 *                       exactly this set.
 *  - `parent_id`      — the row this token was rotated from (forensics).
 *  - `replaced_by_id` — the row this token was rotated into. Written by the
 *                       SAME atomic conditional UPDATE that revokes the row
 *                       (AUTH-001), so it is never observably out of step.
 *  - `rotated_at`     — when the rotation happened; bounds the retry window.
 *  - `retry_count`    — how many times the retry window was used; bounds it
 *                       again, so a grace window can never become unlimited
 *                       replay.
 *
 * BACKFILL SAFETY. Existing rows get `family_id = id`, i.e. every pre-existing
 * token becomes its own single-member family. That is the conservative
 * reading: no existing session is invalidated, and a replay of a pre-existing
 * token revokes only itself rather than the user's whole account — strictly
 * safer than the behaviour being replaced. `rotated_at`/`replaced_by_id` stay
 * NULL for those rows, which correctly makes them retry-INELIGIBLE (there is
 * no recorded successor to resume from), so they fall through to ordinary
 * reuse detection.
 *
 * Indexes are deliberately NOT created here — they need `CONCURRENTLY`, which
 * cannot run inside a transaction block, so they live in the sibling
 * migration `AuthTokenIndexes` which disables the transaction wrapper.
 */
export class RefreshTokenFamily1730057000000 implements MigrationInterface {
  name = 'RefreshTokenFamily1730057000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "family_id" uuid`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "parent_id" uuid`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "replaced_by_id" uuid`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" TIMESTAMP WITH TIME ZONE`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0`,
    );

    // Every existing row becomes its own family — see BACKFILL SAFETY above.
    await q.query(
      `UPDATE "refresh_tokens" SET "family_id" = "id" WHERE "family_id" IS NULL`,
    );

    // Only now can the column be NOT NULL: the backfill above guarantees no
    // NULL remains, and `issueTokens` always supplies a value going forward.
    await q.query(
      `ALTER TABLE "refresh_tokens" ALTER COLUMN "family_id" SET NOT NULL`,
    );
  }

  /**
   * Reversible without data loss: dropping the lineage columns restores the
   * pre-fix shape exactly. The application code that reads them must be rolled
   * back first (migration → backend is the forward order, so backend →
   * migration is the reverse).
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "retry_count"`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "rotated_at"`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "replaced_by_id"`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "parent_id"`,
    );
    await q.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "family_id"`,
    );
  }
}
