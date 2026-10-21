import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Analytics accuracy audit (2026-10-21). New clinics got
 * `tenant_settings.currency = 'USD'` by default while everything they are
 * actually charged in defaults to SAR (appointments, patient payments, the
 * Tap merchant). The analytics page then had to guess which one was real.
 *
 * This changes the column DEFAULT only, so NEW clinics start in SAR like
 * their bookings. Existing rows are deliberately NOT rewritten: a clinic's
 * saved currency is its own setting, and analytics already reports in the
 * currency a clinic actually collects (`resolveReportingCurrency`).
 */
export class TenantSettingCurrencyDefaultSar1730123000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "tenant_settings" ALTER COLUMN "currency" SET DEFAULT 'SAR'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "tenant_settings" ALTER COLUMN "currency" SET DEFAULT 'USD'`,
    );
  }
}
