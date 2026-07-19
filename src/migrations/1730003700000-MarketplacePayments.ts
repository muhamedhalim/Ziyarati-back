import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marketplace payments readiness.
 *
 * 1. `merchant_accounts` — one row per tenant: the clinic's FINANCIAL
 *    onboarding state (NOT_STARTED → … → APPROVED) + gateway recipient id.
 *    Live payment collection is gated on APPROVED. Masked bank details only —
 *    full documents stay in the private verification-documents storage.
 *
 * 2. UNIQUE(one PENDING payment per appointment) — DB-level double-charge
 *    protection for booking payments: a double click / concurrent retry can
 *    never open two live charges for the same booking. PARTIAL so history
 *    (failed/paid/refunded attempts) is unaffected. Fails LOUDLY on
 *    pre-existing duplicates — two live charges for one booking is an incident
 *    needing a human decision, not a silent pick-a-winner.
 *
 * 3. `subscription_invoices` charge-safety columns: `provider_reference`
 *    (opaque gateway reference for support/reconciliation), `failure_reason`
 *    (domain-safe decline text), `charge_started_at` (atomic charge claim —
 *    at most one in-flight charge per invoice).
 *
 * Backward compatible: additive only; existing rows read as
 * NOT_STARTED-by-absence / NULL. `down()` drops what `up()` added.
 */
export class MarketplacePayments1730003700000 implements MigrationInterface {
  name = 'MarketplacePayments1730003700000';

  public async up(q: QueryRunner): Promise<void> {
    // ── 1. merchant_accounts ────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS merchant_accounts (
        id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId"             uuid UNIQUE REFERENCES tenants(id),
        status                 varchar NOT NULL DEFAULT 'NOT_STARTED',
        provider               varchar NOT NULL DEFAULT 'moyasar',
        provider_recipient_id  varchar,
        bank_name              varchar,
        beneficiary_name       varchar,
        iban_masked            varchar,
        review_notes           text,
        status_history         jsonb,
        submitted_at           timestamptz,
        approved_at            timestamptz,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ── 2. one live (PENDING) charge per booking ───────────────────────────
    const duplicates = await q.query(`
      SELECT "appointmentId", COUNT(*)::int AS count
      FROM payments
      WHERE status = 'PENDING' AND "appointmentId" IS NOT NULL AND deleted_at IS NULL
      GROUP BY "appointmentId"
      HAVING COUNT(*) > 1
    `);
    if (duplicates.length > 0) {
      const list = duplicates
        .map((d: { appointmentId: string; count: number }) => `${d.appointmentId} (${d.count})`)
        .join(', ');
      throw new Error(
        `Cannot enforce one PENDING payment per appointment: these appointments have multiple live PENDING payments: ${list}. ` +
          `Resolve each (confirm/fail the stale attempts via the gateway truth) and re-run.`,
      );
    }
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_appointment_pending
      ON payments ("appointmentId")
      WHERE status = 'PENDING' AND "appointmentId" IS NOT NULL
    `);

    // ── 3. subscription_invoices charge-safety columns ─────────────────────
    await q.query(`ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS provider_reference varchar`);
    await q.query(`ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS failure_reason text`);
    await q.query(`ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS charge_started_at timestamptz`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE subscription_invoices DROP COLUMN IF EXISTS charge_started_at`);
    await q.query(`ALTER TABLE subscription_invoices DROP COLUMN IF EXISTS failure_reason`);
    await q.query(`ALTER TABLE subscription_invoices DROP COLUMN IF EXISTS provider_reference`);
    await q.query(`DROP INDEX IF EXISTS uq_payments_appointment_pending`);
    await q.query(`DROP TABLE IF EXISTS merchant_accounts`);
  }
}
