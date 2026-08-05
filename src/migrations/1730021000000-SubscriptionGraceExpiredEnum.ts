import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M-02 (FND-031) — adds the `GRACE_EXPIRED` value to `subscriptions_status_enum`
 * (verified live: 5 values today — TRIAL/ACTIVE/PAST_DUE/CANCELLED/SUSPENDED —
 * matching `SubscriptionStatus` exactly; T007's baseline note about "11 values"
 * was a stale/mixed-up reference to a DIFFERENT enum, `subscription_invoices_status_enum`).
 *
 * HARD CONSTRAINT (data-model.md D-3): this migration MUST NOT also USE the new
 * value — no data is written here. `ALTER TYPE ... ADD VALUE` is safe inside a
 * transaction on Postgres 12+ as long as the value isn't used in that SAME
 * transaction (exact precedent: `OutboxHardening1730014000000`, which adds
 * `'PUBLISHING'` to `outbox_jobs_status_enum` the same way, no override needed).
 * The backfill that actually USES `PAST_DUE` (an EXISTING value, not this one)
 * lives in the separate, LATER migration `SubscriptionGraceColumns` — TypeORM's
 * `migrationsTransactionMode: 'each'` guarantees these can never be merged into
 * one transaction by the runner.
 */
export class SubscriptionGraceExpiredEnum1730021000000
  implements MigrationInterface
{
  name = 'SubscriptionGraceExpiredEnum1730021000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "subscriptions_status_enum" ADD VALUE IF NOT EXISTS 'GRACE_EXPIRED'`,
    );
  }

  /**
   * PostgreSQL cannot drop an enum value. Rollback leaves it in place, unused
   * — harmless, and consistent with R-DB6 (cease use, never destroy). Stated
   * honestly rather than papered over: this migration is NOT reversible.
   */
  public async down(): Promise<void> {
    // Deliberately no-op — see docstring.
  }
}
