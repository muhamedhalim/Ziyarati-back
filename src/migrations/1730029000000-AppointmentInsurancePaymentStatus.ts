import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `INSURANCE` value to `appointments_payment_status_enum` — a
 * payment axis outcome meaning "handled through insurance or directly at the
 * clinic, never collected online" (see `AppointmentPaymentStatus.INSURANCE`).
 *
 * Same precedent as `SubscriptionGraceExpiredEnum1730021000000`: this
 * migration MUST NOT also USE the new value in the same transaction —
 * `ALTER TYPE ... ADD VALUE` is safe on Postgres 12+ only when the value
 * isn't referenced in that same transaction. No data is written here.
 */
export class AppointmentInsurancePaymentStatus1730029000000
  implements MigrationInterface
{
  name = 'AppointmentInsurancePaymentStatus1730029000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "appointments_payment_status_enum" ADD VALUE IF NOT EXISTS 'INSURANCE'`,
    );
  }

  /**
   * PostgreSQL cannot drop an enum value. Rollback leaves it in place, unused
   * — harmless, and consistent with R-DB6 (cease use, never destroy).
   */
  public async down(): Promise<void> {
    // Deliberately no-op — see docstring.
  }
}
