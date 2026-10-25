import type { EntityManager } from 'typeorm';

/**
 * The `tenant_settings` columns the booking reads.
 *
 * Both take the transaction's `manager` on purpose: the decision is taken on the
 * same snapshot as the rest of the booking, and routing them through a service
 * that opens its own connection would add pool pressure on the hottest write
 * path (see the P0 booking pool remediation). Both columns come back from one
 * statement: a second read on the booking path costs a round trip per request.
 */

/** The `tenant_settings` columns a booking reads, from ONE statement. */
export interface BookingTenantSettings {
  /**
   * Does the clinic collect online payment at all? A missing settings row is
   * "payment required", preserving the column's own default rather than silently
   * confirming bookings for a clinic whose settings never got created.
   */
  paymentRequired: boolean;
  /** The clinic's own currency; SAR for a clinic that has no settings row. */
  currency: string;
}

export async function readBookingSettings(
  manager: EntityManager,
  tenantId: string,
): Promise<BookingTenantSettings> {
  const rows: { payment_required: boolean; currency: string | null }[] =
    await manager.query(
      `SELECT payment_required, currency FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
  return {
    paymentRequired: rows[0]?.payment_required ?? true,
    currency: rows[0]?.currency?.trim() || 'SAR',
  };
}
