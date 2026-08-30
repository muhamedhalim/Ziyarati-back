import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T079 (US5, FR-B002a, FR-B004).
 *
 * `subscription_invoices` has no notion of a billing PERIOD today (see
 * `SubscriptionInvoiceOpenUniqueness1730020000000`'s own docblock — the
 * table's existing uniqueness is deliberately "at most one OPEN invoice per
 * subscription", NOT "one per period", because there was no period column
 * to scope to). That makes "one invoice per period" — the actual guarantee
 * `RenewalService` needs — unenforceable at the database level. This
 * migration adds that column and a second, period-scoped unique index
 * alongside the existing one (both invariants are meaningful and neither
 * subsumes the other: the old index catches two simultaneously-OPEN
 * invoices regardless of period; the new one catches two invoices for the
 * SAME period regardless of status, e.g. a retried renewal accidentally
 * inserting instead of upserting).
 *
 * `currency` is backfilled from the PLATFORM's billing default
 * (`system_settings` row for `SettingKey.DEFAULT_CURRENCY` /
 * `'billing.default_currency'`, falling back to the registry default
 * `'SAR'` if unset) — never `tenant_settings.currency`. What the platform
 * charges a clinic must not be decided by a value the clinic controls
 * (FR-B002a); this is also the first fix for `BillingService.payInvoice`'s
 * pre-existing hardcoded `'USD'` default, which never read the platform
 * setting at all.
 *
 * `period_start`/`period_end` are backfilled from each invoice's OWN
 * subscription's CURRENT window (`subscriptions.starts_at`/`ends_at`) — the
 * best available approximation for historical rows, since no period was
 * ever recorded. `subscription_invoices.subscription_id` carries no foreign
 * key (verified live, same finding the 1730020000000 migration already
 * recorded), so an invoice whose subscription no longer exists is reported
 * and this migration ABORTS rather than guessing a period for it — silently
 * inventing a period for an orphaned invoice would be worse than a failed
 * migration run demanding a human look at the data first.
 *
 * The backfill runs in bounded batches (500 rows at a time) so a large
 * table never holds one long-running UPDATE's row locks — same reasoning as
 * the paged worker sweeps elsewhere in this codebase, applied here to a
 * migration for the same reason.
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` for the new index, for the identical
 * reason 1730020000000 already documents (no `ACCESS EXCLUSIVE` lock on a
 * potentially large table) — hence `transaction = false` here too.
 */
export class SubscriptionInvoicePeriodAndCurrency1730067000000 implements MigrationInterface {
  name = 'SubscriptionInvoicePeriodAndCurrency1730067000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "subscription_invoices"
        ADD COLUMN IF NOT EXISTS "period_start" timestamptz,
        ADD COLUMN IF NOT EXISTS "period_end" timestamptz,
        ADD COLUMN IF NOT EXISTS "currency" varchar(3),
        ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "next_retry_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "failure_class" varchar(64)
    `);

    // Abort BEFORE touching any row if an invoice's subscription no longer
    // exists — there is no window/currency to backfill it from, and no FK
    // ever enforced referential integrity here (pre-existing, verified live).
    const orphans: { id: string }[] = await q.query(`
      SELECT si.id FROM subscription_invoices si
       WHERE si.period_start IS NULL
         AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = si.subscription_id::uuid)
       LIMIT 20
    `);
    if (orphans.length > 0) {
      throw new Error(
        'SubscriptionInvoicePeriodAndCurrency: ' +
          `${orphans.length}+ subscription_invoices row(s) reference a subscription_id ` +
          `that no longer exists (e.g. ${orphans.map((r) => r.id).join(', ')}) — ` +
          'cannot backfill period_start/period_end for them. Investigate and resolve ' +
          'the orphaned rows before re-running this migration.',
      );
    }

    const [defaultCurrencyRow] = await q.query(`
      SELECT value #>> '{}' AS currency FROM system_settings WHERE key = 'billing.default_currency'
    `);
    const platformCurrency: string = defaultCurrencyRow?.currency ?? 'SAR';

    // Bounded batches — never one long-running UPDATE over a large table.
    // `queryRunner.query()` returns a `[rows, affectedCount]` TUPLE (not a
    // plain rows array) for a statement with RETURNING — verified directly
    // against Postgres: an empty result comes back as `[[], 0]`, whose own
    // `.length` is 2, not 0. Checking the ROWS array's length, not the
    // tuple's, is what actually terminates the loop.
    const MAX_BATCH_ITERATIONS = 10_000; // 5,000,000 rows at 500/batch — a hard backstop, never expected to bind.
    for (let i = 0; i < MAX_BATCH_ITERATIONS; i += 1) {
      const [rows]: [{ id: string }[], number] = await q.query(
        `
        WITH batch AS (
          SELECT si.id
            FROM subscription_invoices si
           WHERE si.period_start IS NULL
           LIMIT 500
        )
        UPDATE subscription_invoices si
           SET period_start = s.starts_at,
               period_end = s.ends_at,
               currency = $1
          FROM subscriptions s, batch
         WHERE si.id = batch.id
           AND si.subscription_id::uuid = s.id
        RETURNING si.id
        `,
        [platformCurrency],
      );
      if (rows.length === 0) break;
      if (i === MAX_BATCH_ITERATIONS - 1) {
        throw new Error(
          `SubscriptionInvoicePeriodAndCurrency: backfill loop did not drain after ${MAX_BATCH_ITERATIONS} ` +
            'batches — aborting rather than looping indefinitely. Investigate before re-running.',
        );
      }
    }

    const [remaining] = await q.query(`
      SELECT COUNT(*)::int AS c FROM subscription_invoices WHERE period_start IS NULL
    `);
    if (Number(remaining?.c) > 0) {
      throw new Error(
        `SubscriptionInvoicePeriodAndCurrency: ${remaining.c} row(s) still have a NULL ` +
          'period_start after the backfill loop — investigate before setting NOT NULL.',
      );
    }

    await q.query(`
      ALTER TABLE "subscription_invoices"
        ALTER COLUMN "period_start" SET NOT NULL,
        ALTER COLUMN "period_end" SET NOT NULL,
        ALTER COLUMN "currency" SET NOT NULL
    `);

    await q.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_sub_invoice_period" ON "subscription_invoices" ("subscription_id", "period_start") WHERE "status" <> 'VOID'`,
    );
    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"UQ_sub_invoice_period"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        'SubscriptionInvoicePeriodAndCurrency: "UQ_sub_invoice_period" was created but is NOT ' +
          'valid — a CONCURRENTLY build failed partway (likely a pre-existing subscription with ' +
          'two non-VOID invoices sharing a period_start). Investigate, drop the invalid index, ' +
          'resolve the underlying data, and re-run this migration.',
      );
    }
  }

  /** Fully reversible: dropping the index and columns removes only what
   *  this migration added — no data outside those columns is touched. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_sub_invoice_period"`);
    await q.query(`
      ALTER TABLE "subscription_invoices"
        DROP COLUMN IF EXISTS "period_start",
        DROP COLUMN IF EXISTS "period_end",
        DROP COLUMN IF EXISTS "currency",
        DROP COLUMN IF EXISTS "retry_count",
        DROP COLUMN IF EXISTS "next_retry_at",
        DROP COLUMN IF EXISTS "failure_class"
    `);
  }
}
