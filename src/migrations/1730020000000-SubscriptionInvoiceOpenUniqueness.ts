import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-04 (FND-032) — prevents a subscription from ever having more than one
 * OPEN invoice at a time (concurrent `changePlan`/`create` calls previously
 * had no DB backing at all — see `SubscriptionService`).
 *
 * Verified live (data-model.md §D-4) before writing this migration:
 * `subscription_invoices` has NO period column, no `tenant_id` index, and no
 * foreign keys (`tenant_id`/`subscription_id` are plain `character varying`).
 * The spec's originally-proposed "unique on tenant + period" is therefore
 * NOT buildable — there is no period concept in this schema. The selected
 * fix instead expresses the invariant the finding actually names: one
 * subscription cannot end up with two LIVE (OPEN) invoices. It deliberately
 * does not invent a billing-period column (data-model.md M-04, Option B —
 * rejected as product modeling beyond this finding).
 *
 * A CLOSED/PAID invoice is explicitly NOT blocked by this index (scoped to
 * `status = 'OPEN'`) — a subscription accumulates many invoices over its
 * life; only ever one of them may be open at once.
 *
 * PRODUCTION LOCK RISK: `CREATE UNIQUE INDEX CONCURRENTLY` avoids an
 * `ACCESS EXCLUSIVE` lock on a potentially large table. `CONCURRENTLY`
 * cannot run inside a transaction block, hence `transaction = false` (same
 * pattern as M-01, `CustomerTenantScopedEmail`).
 *
 * PRE-REQUISITE (quickstart.md §3.2): if any subscription already has more
 * than one OPEN invoice, this index build fails partway and is left INVALID
 * — never silently half-applied. Local count is 0 (Wave 3 T054); this MUST
 * be re-assessed against production-like data before deploying there (R-DB9).
 */
export class SubscriptionInvoiceOpenUniqueness1730020000000
  implements MigrationInterface
{
  name = 'SubscriptionInvoiceOpenUniqueness1730020000000';
  public transaction = false;

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_sub_invoice_open_per_subscription" ON "subscription_invoices" ("subscription_id") WHERE "status" = 'OPEN'`,
    );

    const [row] = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"UQ_sub_invoice_open_per_subscription"'::regclass`,
    );
    if (!row?.indisvalid) {
      throw new Error(
        'M-04: "UQ_sub_invoice_open_per_subscription" was created but is NOT valid — a CONCURRENTLY ' +
          'build failed partway (likely a pre-existing subscription with >1 OPEN invoice). Investigate, ' +
          'drop the invalid index, resolve the underlying data, and re-run this migration.',
      );
    }
  }

  /** Fully reversible — dropping the index removes only the constraint, no data. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_sub_invoice_open_per_subscription"`);
  }
}
