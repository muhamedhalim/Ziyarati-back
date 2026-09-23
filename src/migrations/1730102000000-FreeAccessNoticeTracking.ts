import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds notice-tracking columns to `free_access_overrides` so the start and
 * expiry-warning notifications (see `FreeAccessNoticeService`, worker jobs
 * `platform.freeAccessNotice` / `platform.freeAccessExpirySweep`) have a
 * durable, database-backed idempotency anchor instead of relying on Redis or
 * process memory.
 *
 * - `start_notice_at` — when the "free access started" notice was committed
 *   to the outbox. NULL means none was ever queued (a system/guest grant with
 *   `notifyClinic:false`, or a legacy row that predates this feature).
 * - `expiry_warning_at` — when the latest "expiring soon" warning was
 *   claimed by the sweep.
 * - `expiry_warning_ends_at` — the `ends_at` value that warning was issued
 *   for. Eligibility is `expiry_warning_ends_at IS DISTINCT FROM ends_at`, so
 *   extending the override (a new `ends_at`) automatically re-arms exactly
 *   one further warning without any extra bookkeeping.
 *
 * All three columns are nullable with no default — this is a metadata-only
 * change on Postgres 11+ (no table rewrite, no lock beyond the brief
 * ACCESS EXCLUSIVE needed to add the columns).
 *
 * The due-lookup index's predicate (`status='ACTIVE' AND ends_at IS NOT
 * NULL`) is immutable (no `now()`), so it is safely indexable — unlike the
 * "active override" predicate discussed in `free-access-override.service.ts`,
 * which involves `now()` and is why THAT check uses an advisory lock instead
 * of a unique index.
 *
 * `IF NOT EXISTS` / `IF EXISTS` throughout: idempotent alongside the boot-time
 * mirror in `PlatformBillingBootstrap` (dev `synchronize` boxes never run
 * migrations, so both paths must converge on the same schema — see the
 * class docblock on `FreeAccessOverridesTable1730039000000` for why this
 * table is bootstrapped rather than `synchronize`-managed).
 */
export class FreeAccessNoticeTracking1730102000000
  implements MigrationInterface
{
  name = 'FreeAccessNoticeTracking1730102000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "free_access_overrides"
      ADD COLUMN IF NOT EXISTS "start_notice_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "expiry_warning_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "expiry_warning_ends_at" timestamptz
    `);

    // Hourly sweep's hot path: "ACTIVE, time-boxed overrides ending within
    // the next 48h that haven't been warned for their CURRENT ends_at yet".
    // The predicate below covers everything except the ever-changing
    // "within 48h of now" bound and the per-row `IS DISTINCT FROM` check,
    // both of which the sweep applies at query time — this index still
    // narrows the scan to just the ACTIVE, time-boxed rows.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_free_override_expiry_due"
      ON "free_access_overrides" ("ends_at")
      WHERE "status" = 'ACTIVE' AND "ends_at" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX IF EXISTS "idx_free_override_expiry_due"`,
    );
    await q.query(`
      ALTER TABLE "free_access_overrides"
      DROP COLUMN IF EXISTS "expiry_warning_ends_at",
      DROP COLUMN IF EXISTS "expiry_warning_at",
      DROP COLUMN IF EXISTS "start_notice_at"
    `);
  }
}
