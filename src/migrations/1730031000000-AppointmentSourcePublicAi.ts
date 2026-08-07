import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `PUBLIC_AI` to `appointments_source_enum` — bookings created by the
 * public AI assistant for an anonymous visitor on the website.
 *
 * Until now every AI-created booking was stamped `WHATSAPP_BOT` regardless of
 * the channel it actually arrived on (hardcoded in
 * `AiToolDispatchService.bookAppointment`), so a clinic could not tell a web
 * booking from a WhatsApp one. WhatsApp keeps `WHATSAPP_BOT`; only the new
 * public web flow uses this value.
 *
 * Same precedent as `AppointmentInsurancePaymentStatus1730029000000`: this
 * migration MUST NOT also USE the new value in the same transaction —
 * `ALTER TYPE ... ADD VALUE` is safe on Postgres 12+ only when the value isn't
 * referenced in that same transaction. No data is written here.
 */
export class AppointmentSourcePublicAi1730031000000 implements MigrationInterface {
  name = 'AppointmentSourcePublicAi1730031000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "appointments_source_enum" ADD VALUE IF NOT EXISTS 'PUBLIC_AI'`,
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
