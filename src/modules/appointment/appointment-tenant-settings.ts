import type { EntityManager } from 'typeorm';

/**
 * The two `tenant_settings` columns the booking transaction reads.
 *
 * Both take the transaction's `manager` on purpose: the decision is taken on the
 * same snapshot as the rest of the booking, and routing them through a service
 * that opens its own connection would add pool pressure on the hottest write
 * path (see the P0 booking pool remediation). One query each, exactly as before.
 */

/**
 * Does the clinic collect online payment at all? A missing settings row is
 * "payment required", preserving the column's own default rather than silently
 * confirming bookings for a clinic whose settings never got created.
 */
export async function readPaymentRequired(
  manager: EntityManager,
  tenantId: string,
): Promise<boolean> {
  const rows: { payment_required: boolean }[] = await manager.query(
    `SELECT payment_required FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  return rows[0]?.payment_required ?? true;
}

/** The clinic's own currency; SAR for a clinic that has no settings row. */
export async function readClinicCurrency(
  manager: EntityManager,
  tenantId: string,
): Promise<string> {
  const rows: { currency: string | null }[] = await manager.query(
    `SELECT currency FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  return rows[0]?.currency?.trim() || 'SAR';
}
