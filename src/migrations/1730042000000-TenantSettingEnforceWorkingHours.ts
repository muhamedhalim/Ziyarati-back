import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-clinic opt-in for strict staff working-hours enforcement at booking time.
 *
 * The availability engine composes seven sources, but the POSITIVE one
 * (staff schedule ∩ branch working hours, ∪ calendar slots) could only ever be
 * gated by a module-level constant that was `false` for everyone. The effect was
 * that a staff member with no schedule configured for a weekday had no
 * working-hours constraint at all — bookable at 03:00 — while every clinic that
 * DOES maintain schedules had no way to say so.
 *
 * Flipping that constant globally would have made every unconfigured clinic
 * unable to book anyone, so the decision moves onto the tenant, beside the
 * sibling business rules already on this table (`payment_required`,
 * `bot_enabled`, `booking_confirmation`, `public_booking_enabled`).
 *
 * Read in exactly one place — `AvailabilityService.enforceWorkingHours` — so
 * every booking source (reception, admin, WhatsApp bot, public AI assistant,
 * integration platform) obeys it identically.
 *
 * Additive with a NOT NULL DEFAULT false: no existing row can violate it and no
 * clinic's behavior changes until an owner turns it on.
 */
export class TenantSettingEnforceWorkingHours1730042000000
  implements MigrationInterface
{
  name = 'TenantSettingEnforceWorkingHours1730042000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tenant_settings'
            AND column_name = 'enforce_staff_working_hours'
        ) THEN
          ALTER TABLE "tenant_settings"
            ADD COLUMN "enforce_staff_working_hours" boolean NOT NULL DEFAULT false;
        END IF;
      END $$;
    `);
  }

  /**
   * R-DB6: additive columns are never dropped on rollback — only their use
   * ceases. Dropping would discard every clinic's enforcement decision, and the
   * column is inert the moment nothing reads it.
   */
  public async down(): Promise<void> {
    // Deliberately does not drop enforce_staff_working_hours — see docstring.
  }
}
