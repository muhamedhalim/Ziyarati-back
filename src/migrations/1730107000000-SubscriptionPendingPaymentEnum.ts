import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tap migration (Phase 3, plan §17 M2) — adds the `PENDING_PAYMENT` value to
 * `subscriptions_status_enum`.
 *
 * A paid subscription now exists in this state from the moment the clinic picks
 * a plan until its first payment is captured (decision D2: "activate only after
 * payment").
 *
 * HARD CONSTRAINT (same as `SubscriptionGraceExpiredEnum1730021000000`): this
 * migration MUST NOT also USE the new value — no data is written here. `ALTER
 * TYPE … ADD VALUE` is safe inside a transaction on Postgres 12+ as long as the
 * value is not used in that SAME transaction. The columns that make use of the
 * state live in the separate, later `SubscriptionTapBilling1730108000000`
 * (TypeORM's `migrationsTransactionMode: 'each'` keeps them in different
 * transactions).
 */
export class SubscriptionPendingPaymentEnum1730107000000 implements MigrationInterface {
  name = 'SubscriptionPendingPaymentEnum1730107000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "subscriptions_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT'`,
    );
  }

  /**
   * PostgreSQL cannot drop an enum value. Rollback leaves it in place, unused —
   * harmless, and consistent with "cease use, never destroy". NOT reversible,
   * stated plainly rather than papered over.
   */
  public async down(): Promise<void> {
    // Deliberately no-op — see docstring.
  }
}
