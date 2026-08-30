import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spec 014 (Clinic Platform Completion) — T092 (US12, FR-I005, research.md R7 / open item O-2).
 *
 * `invoices` has no notion of currency today — every invoice is implicitly
 * whatever the clinic's CURRENT `tenant_settings.currency` happens to be at
 * READ time, which is exactly the bug FR-I005 exists to close (a later
 * currency change must not silently rewrite an already-issued invoice's
 * amounts). This adds a `currency` column, backfilled from each invoice's
 * OWNING tenant's `tenant_settings.currency` — deliberately NOT
 * `Tenant.default_currency` (see `TenantService`'s own docblock: the clinic's
 * revenue currency is the field the application code itself already treats
 * as authoritative for invoicing, e.g. `PaymentLinkService`).
 *
 * Per research.md R7 / open item O-2, this migration surfaces a per-tenant
 * mismatch report BEFORE tightening the column: for every tenant that has
 * invoices linked to an appointment, whether `tenant_settings.currency`
 * disagrees with that appointment's OWN snapshotted `currency` (set at
 * booking time — see `Appointment.currency`). A disagreement does not block
 * the migration (there is no interactive gate inside a migration run), but
 * it is logged loudly, per tenant, so an operator reviewing `migration:run`
 * output sees exactly which tenants may need a manual look — the backfill
 * still proceeds using `tenant_settings.currency` (T093 fixes the "current
 * setting decides invoicing" behavior going forward; this migration's job is
 * only to give every EXISTING invoice a definite value and surface disagreement,
 * never to silently apply a value nobody reviewed).
 */
export class InvoiceCurrency1730074000000 implements MigrationInterface {
  name = 'InvoiceCurrency1730074000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "currency" varchar(3)
    `);

    // ── Mismatch report — emitted BEFORE the backfill runs. ──────────────
    const mismatchRows: {
      tenant_id: string;
      tenant_name: string;
      invoice_count: string;
      tenant_currency: string;
      mismatched_count: string;
    }[] = await q.query(`
      SELECT
        t.id AS tenant_id,
        t.name AS tenant_name,
        ts.currency AS tenant_currency,
        COUNT(i.id) AS invoice_count,
        COUNT(i.id) FILTER (
          WHERE a.currency IS NOT NULL AND a.currency <> ts.currency
        ) AS mismatched_count
      FROM invoices i
      JOIN "tenants" t ON t.id = i."tenantId"
      LEFT JOIN "tenant_settings" ts ON ts.tenant_id = t.id
      LEFT JOIN "appointments" a ON a.id = i."appointmentId"
      WHERE i.currency IS NULL
      GROUP BY t.id, t.name, ts.currency
      ORDER BY mismatched_count DESC, invoice_count DESC
    `);

    console.log(
      `InvoiceCurrency: per-tenant backfill report (${mismatchRows.length} tenant(s) affected):`,
    );
    for (const row of mismatchRows) {
      const flag = Number(row.mismatched_count) > 0 ? ' *** MISMATCH ***' : '';
      console.log(
        `  tenant=${row.tenant_id} (${row.tenant_name}): ${row.invoice_count} invoice(s) ` +
          `→ currency=${row.tenant_currency ?? '(no tenant_settings row — will fail)'}, ` +
          `${row.mismatched_count} disagree with their appointment's own currency${flag}`,
      );
    }

    const [missingSettings] = await q.query(`
      SELECT COUNT(DISTINCT i.id)::int AS c
        FROM invoices i
        JOIN "tenants" t ON t.id = i."tenantId"
        LEFT JOIN "tenant_settings" ts ON ts.tenant_id = t.id
       WHERE i.currency IS NULL AND ts.currency IS NULL
    `);
    if (Number(missingSettings?.c) > 0) {
      throw new Error(
        `InvoiceCurrency: ${missingSettings.c} invoice(s) belong to a tenant with no ` +
          '"tenant_settings" row — cannot backfill currency for them. Investigate before re-running.',
      );
    }

    // Bounded batches — never one long-running UPDATE over a large table.
    const MAX_BATCH_ITERATIONS = 10_000;
    for (let i = 0; i < MAX_BATCH_ITERATIONS; i += 1) {
      const [rows]: [{ id: string }[], number] = await q.query(`
        WITH batch AS (
          SELECT i.id
            FROM invoices i
           WHERE i.currency IS NULL
           LIMIT 500
        )
        UPDATE invoices i
           SET currency = ts.currency
          FROM "tenant_settings" ts, batch
         WHERE i.id = batch.id
           AND ts.tenant_id = i."tenantId"
        RETURNING i.id
      `);
      if (rows.length === 0) break;
      if (i === MAX_BATCH_ITERATIONS - 1) {
        throw new Error(
          `InvoiceCurrency: backfill loop did not drain after ${MAX_BATCH_ITERATIONS} batches — ` +
            'aborting rather than looping indefinitely. Investigate before re-running.',
        );
      }
    }

    const [remaining] = await q.query(`
      SELECT COUNT(*)::int AS c FROM invoices WHERE currency IS NULL
    `);
    if (Number(remaining?.c) > 0) {
      throw new Error(
        `InvoiceCurrency: ${remaining.c} invoice(s) still have a NULL currency after the ` +
          'backfill loop — investigate before setting NOT NULL.',
      );
    }

    await q.query(`
      ALTER TABLE "invoices" ALTER COLUMN "currency" SET NOT NULL
    `);
  }

  /** Fully reversible: drops only the column this migration added. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "invoices" DROP COLUMN IF EXISTS "currency"`);
  }
}
