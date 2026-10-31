import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payment audit Phase 3 (PAY-007, PAY-008, PAY-014). Reversible; never edits or deletes
 * financial rows.
 *
 *  - PAY-007  `created_at`/`updated_at` on payments, refunds, transactions, settlements and
 *             payment_links were `timestamp WITHOUT time zone`: an instant meant nothing without
 *             knowing the writer's zone. Converted to `timestamptz`, reading the stored values as
 *             UTC (every writer ran in UTC: Node on Fargate, `now()` on a UTC database).
 *  - PAY-008  `CHK_payments_paid_has_paid_at`: a captured payment always has a `paid_at`. Added
 *             only when no existing row violates it (otherwise a legacy row could never be
 *             refunded); when skipped, a warning names the count.
 *             Deliberately NOT added: a unique "one captured payment per appointment" index. A
 *             second real capture is customer money; a constraint would make recording it fail,
 *             leaving a charged patient with a PENDING row. It is detected and alerted instead
 *             (`checkDuplicateBookingCapture`).
 *  - PAY-014  `merchant_accounts.provider` defaulted to the retired 'moyasar'; now 'tap'.
 */
export class PaymentSchemaPhase31730141000000 implements MigrationInterface {
  name = 'PaymentSchemaPhase31730141000000';

  private static readonly COLUMNS: Array<[string, string]> = [
    ['payments', 'created_at'],
    ['payments', 'updated_at'],
    ['refunds', 'created_at'],
    ['transactions', 'created_at'],
    ['settlements', 'created_at'],
    ['settlements', 'updated_at'],
    ['payment_links', 'created_at'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    for (const [table, column] of PaymentSchemaPhase31730141000000.COLUMNS) {
      await this.setType(q, table, column, 'timestamp with time zone', `USING "${column}" AT TIME ZONE 'UTC'`);
    }

    const [{ count }] = await q.query(
      `SELECT count(*)::text AS count FROM "payments"
        WHERE "status" IN ('PAID','PARTIALLY_REFUNDED') AND "paid_at" IS NULL`,
    );
    if (Number(count) === 0) {
      await q.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_paid_has_paid_at"`);
      await q.query(
        `ALTER TABLE "payments" ADD CONSTRAINT "CHK_payments_paid_has_paid_at"
           CHECK ("status" NOT IN ('PAID','PARTIALLY_REFUNDED') OR "paid_at" IS NOT NULL)`,
      );
    } else {
      console.warn(
        `[PaymentSchemaPhase3] CHK_payments_paid_has_paid_at NOT created: ${count} PAID/PARTIALLY_REFUNDED payment(s) have no paid_at. Fix them, then re-run.`,
      );
    }

    await q.query(`ALTER TABLE "merchant_accounts" ALTER COLUMN "provider" SET DEFAULT 'tap'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "merchant_accounts" ALTER COLUMN "provider" SET DEFAULT 'moyasar'`);
    await q.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "CHK_payments_paid_has_paid_at"`);
    for (const [table, column] of PaymentSchemaPhase31730141000000.COLUMNS) {
      await this.setType(q, table, column, 'timestamp without time zone', `USING "${column}" AT TIME ZONE 'UTC'`);
    }
  }

  /** Idempotent: skips a missing table/column or one already of the target type. */
  private async setType(
    q: QueryRunner,
    table: string,
    column: string,
    type: string,
    using: string,
  ): Promise<void> {
    const rows: Array<{ data_type: string }> = await q.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    if (rows.length === 0 || rows[0].data_type === type) return;
    await q.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${type} ${using}`);
  }
}
