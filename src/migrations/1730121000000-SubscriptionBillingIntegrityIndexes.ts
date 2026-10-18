import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two invariants the subscription billing code assumed but the database never
 * enforced (Tap plan, Step 5):
 *
 *  1. `UQ_sub_invoice_provider_reference` — one provider charge settles AT MOST ONE
 *     invoice. `payments.gateway_payment_id` is already unique; the subscription
 *     invoices had no such guard, so a wrong correlation (a replayed webhook for
 *     another invoice, a mis-keyed lookup) could book one real charge twice.
 *     VOID invoices are excluded: a voided invoice never carries revenue.
 *
 *  2. `UQ_subscriptions_live_per_tenant` — a tenant has at most one live
 *     subscription. `SubscriptionService.create` checks and then inserts with no
 *     lock, so two concurrent `POST /subscriptions` could create two. "Live" is
 *     exactly the rule `create` already applies: not soft-deleted, not CANCELLED.
 *
 * Both are partial unique indexes built CONCURRENTLY (no ACCESS EXCLUSIVE lock on
 * a hot table; hence `transaction = false`, same pattern as
 * `SubscriptionInvoiceOpenUniqueness`).
 *
 * PRE-CHECK: if existing rows already violate an invariant the index build would
 * fail partway and leave an INVALID index. This migration therefore COUNTS the
 * offenders first and stops with their number — it never deletes or edits data.
 * An operator resolves the duplicates (which subscription / invoice is the real
 * one is a business decision) and re-runs. Identifying the rows:
 *
 *   SELECT provider_reference, count(*) FROM subscription_invoices
 *    WHERE provider_reference IS NOT NULL AND status <> 'VOID'
 *    GROUP BY 1 HAVING count(*) > 1;
 *
 *   SELECT "tenantId", count(*) FROM subscriptions
 *    WHERE deleted_at IS NULL AND status <> 'CANCELLED'
 *    GROUP BY 1 HAVING count(*) > 1;
 *
 * Fully reversible: dropping an index removes only the constraint, no data.
 */
export class SubscriptionBillingIntegrityIndexes1730121000000 implements MigrationInterface {
  name = 'SubscriptionBillingIntegrityIndexes1730121000000';
  public transaction = false;

  private static readonly INVOICE_REF_PREDICATE = `"provider_reference" IS NOT NULL AND "status" <> 'VOID'`;
  private static readonly LIVE_SUBSCRIPTION_PREDICATE = `"deleted_at" IS NULL AND "status" <> 'CANCELLED'`;

  public async up(q: QueryRunner): Promise<void> {
    const dupRefs = await this.count(
      q,
      `SELECT count(*)::text AS count FROM (
         SELECT 1 FROM "subscription_invoices"
          WHERE ${SubscriptionBillingIntegrityIndexes1730121000000.INVOICE_REF_PREDICATE}
          GROUP BY "provider_reference" HAVING count(*) > 1
       ) d`,
    );
    const dupSubs = await this.count(
      q,
      `SELECT count(*)::text AS count FROM (
         SELECT 1 FROM "subscriptions"
          WHERE ${SubscriptionBillingIntegrityIndexes1730121000000.LIVE_SUBSCRIPTION_PREDICATE}
          GROUP BY "tenantId" HAVING count(*) > 1
       ) d`,
    );
    if (dupRefs > 0 || dupSubs > 0) {
      throw new Error(
        `Subscription integrity indexes NOT created — existing data violates them: ` +
          `${dupRefs} provider reference(s) shared by more than one non-VOID invoice, ` +
          `${dupSubs} tenant(s) with more than one live subscription. ` +
          'Nothing was changed. Resolve the duplicates (a business decision — see the queries in this ' +
          'migration header) and re-run.',
      );
    }

    await this.createValid(
      q,
      'UQ_sub_invoice_provider_reference',
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_sub_invoice_provider_reference" ON "subscription_invoices" ("provider_reference") WHERE ${SubscriptionBillingIntegrityIndexes1730121000000.INVOICE_REF_PREDICATE}`,
    );
    await this.createValid(
      q,
      'UQ_subscriptions_live_per_tenant',
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_subscriptions_live_per_tenant" ON "subscriptions" ("tenantId") WHERE ${SubscriptionBillingIntegrityIndexes1730121000000.LIVE_SUBSCRIPTION_PREDICATE}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "UQ_subscriptions_live_per_tenant"`,
    );
    await q.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "UQ_sub_invoice_provider_reference"`,
    );
  }

  private async count(q: QueryRunner, sql: string): Promise<number> {
    const rows: Array<{ count: string }> = await q.query(sql);
    return Number(rows[0]?.count ?? 0);
  }

  /** A CONCURRENTLY build that fails partway leaves an INVALID index: never accepted silently. */
  private async createValid(
    q: QueryRunner,
    name: string,
    createSql: string,
  ): Promise<void> {
    await q.query(createSql);
    const rows: Array<{ indisvalid: boolean }> = await q.query(
      `SELECT indisvalid FROM pg_index WHERE indexrelid = '"${name}"'::regclass`,
    );
    if (!rows[0]?.indisvalid) {
      throw new Error(
        `"${name}" was created but is NOT valid — a CONCURRENTLY build failed partway. ` +
          'Drop the invalid index, resolve the underlying data, and re-run this migration.',
      );
    }
  }
}
