import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Money invariants the application assumed but the database never enforced
 * (financial audit, FIN-X5):
 *
 *  - `CHK_payments_amount_positive`        a payment is for more than nothing.
 *  - `CHK_payments_refunded_within_amount` refunded money is never negative and
 *                                          never exceeds what was paid.
 *  - `CHK_refunds_amount_positive`         a refund moves a positive amount.
 *  - `UQ_settlement_items_payment`         a payment belongs to AT MOST ONE settlement
 *                                          (the composite primary key only stopped
 *                                          the same pair twice, so one payment could
 *                                          be paid out in two settlements).
 *
 * PRE-CHECK: existing rows that already violate an invariant would make the
 * constraint fail partway. The migration therefore COUNTS offenders first and stops
 * with their number; it never deletes or edits financial data. Identify them with:
 *
 *   SELECT id, amount FROM payments WHERE amount <= 0;
 *   SELECT id, amount, refunded_amount FROM payments
 *    WHERE refunded_amount < 0 OR refunded_amount > amount;
 *   SELECT id, amount FROM refunds WHERE amount <= 0;
 *   SELECT payment_id, count(*) FROM settlement_items GROUP BY 1 HAVING count(*) > 1;
 *
 * Resolving them (which figure is right) is an accounting decision, not a migration's.
 * Fully reversible: dropping a constraint or index removes only the guard.
 */
export class FinancialIntegrityChecks1730127000000 implements MigrationInterface {
  name = 'FinancialIntegrityChecks1730127000000';

  public async up(q: QueryRunner): Promise<void> {
    const badAmount = await this.count(
      q,
      `SELECT count(*)::text AS count FROM "payments" WHERE "amount" <= 0`,
    );
    const badRefunded = await this.count(
      q,
      `SELECT count(*)::text AS count FROM "payments"
        WHERE COALESCE("refunded_amount", 0) < 0 OR COALESCE("refunded_amount", 0) > "amount"`,
    );
    const badRefund = await this.count(
      q,
      `SELECT count(*)::text AS count FROM "refunds" WHERE "amount" <= 0`,
    );
    const dupItems = await this.count(
      q,
      `SELECT count(*)::text AS count FROM (
         SELECT 1 FROM "settlement_items" GROUP BY "payment_id" HAVING count(*) > 1
       ) d`,
    );
    if (badAmount + badRefunded + badRefund + dupItems > 0) {
      throw new Error(
        `Financial integrity constraints NOT created - existing data violates them: ` +
          `${badAmount} payment(s) with amount <= 0, ` +
          `${badRefunded} payment(s) with refunded_amount outside 0..amount, ` +
          `${badRefund} refund(s) with amount <= 0, ` +
          `${dupItems} payment(s) in more than one settlement. ` +
          'Nothing was changed. Resolve them (an accounting decision; see the queries in this ' +
          'migration header) and re-run.',
      );
    }

    await this.addCheck(
      q,
      'payments',
      'CHK_payments_amount_positive',
      `"amount" > 0`,
    );
    await this.addCheck(
      q,
      'payments',
      'CHK_payments_refunded_within_amount',
      `"refunded_amount" >= 0 AND "refunded_amount" <= "amount"`,
    );
    await this.addCheck(
      q,
      'refunds',
      'CHK_refunds_amount_positive',
      `"amount" > 0`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_settlement_items_payment" ON "settlement_items" ("payment_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_settlement_items_payment"`);
    await q.query(
      `ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "CHK_refunds_amount_positive"`,
    );
    await q.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_refunded_within_amount"`,
    );
    await q.query(
      `ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_amount_positive"`,
    );
  }

  private async addCheck(
    q: QueryRunner,
    table: string,
    name: string,
    expr: string,
  ): Promise<void> {
    // Idempotent. The pre-check above already proved the expression holds for every row.
    await q.query(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`,
    );
    await q.query(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr})`,
    );
  }

  private async count(q: QueryRunner, sql: string): Promise<number> {
    const rows: Array<{ count: string }> = await q.query(sql);
    return Number(rows[0]?.count ?? 0);
  }
}
