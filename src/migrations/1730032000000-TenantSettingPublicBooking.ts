import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-clinic opt-in for the public AI booking flow.
 *
 * Public discovery makes a clinic visible to anonymous visitors and public
 * booking lets them create real appointments in it — a business decision the
 * clinic must take deliberately, so this defaults to `false` and every existing
 * clinic stays exactly as it is until an owner turns it on. It sits beside the
 * sibling business rules already on this table (`payment_required`,
 * `bot_enabled`, `booking_confirmation`).
 *
 * Read by `PublicBookingContextService.resolveTenantFromBranch` (the single
 * seam that derives a booking tenant) and by every public discovery query, so
 * an opted-out clinic is neither listed nor bookable.
 *
 * Additive with a NOT NULL DEFAULT false: no existing row can violate it.
 * Rollback ceases use rather than dropping the column (R-DB6) — see `down()`.
 */
export class TenantSettingPublicBooking1730032000000 implements MigrationInterface {
  name = 'TenantSettingPublicBooking1730032000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tenant_settings' AND column_name = 'public_booking_enabled'
        ) THEN
          ALTER TABLE "tenant_settings"
            ADD COLUMN "public_booking_enabled" boolean NOT NULL DEFAULT false;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would discard every clinic's opt-in decision.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop public_booking_enabled — see docstring.
  }
}
