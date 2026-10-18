/**
 * The "charge claim" on a subscription invoice: `charge_started_at` marks a
 * merchant-initiated (saved-card) charge in flight, `checkout_started_at` /
 * `checkout_charge_id` a hosted checkout. One obligation must never have two
 * live charges, so every path that would start one goes through these rules.
 *
 *  - A claim is FRESH for {@link CHARGE_CLAIM_STALE_MS}: nobody else may start.
 *  - A stale claim whose provider charge id is KNOWN (`checkout_charge_id` is set —
 *    both claim paths clear it first, so with a claim present it can only be the
 *    charge that claim created) is an UNRESOLVED charge: it may be captured at any
 *    moment, so it blocks until the reconciliation sweep learns its outcome.
 *  - A stale claim with NO charge id (the response was lost) may be retried: the
 *    provider honours the same `reference.idempotent` for 24h and returns the
 *    original charge. Past {@link CHARGE_CLAIM_AMBIGUOUS_MS} that guarantee is
 *    about to lapse, so the claim blocks again until the sweep looks the charge up
 *    by the invoice reference and either adopts it or confirms none exists.
 */
export const CHARGE_CLAIM_STALE_MS = 10 * 60_000;
export const CHARGE_CLAIM_AMBIGUOUS_MS = 20 * 60 * 60_000;

/** The claim columns of a `subscription_invoices` row. */
export interface ChargeClaimState {
  charge_started_at?: Date | null;
  checkout_charge_id?: string | null;
}

/** TRUE while a claim still stops any other charge for this invoice from starting. */
export function chargeClaimBlocks(
  invoice: ChargeClaimState,
  now = Date.now(),
): boolean {
  if (!invoice.charge_started_at) return false;
  const age = now - invoice.charge_started_at.getTime();
  return (
    age < CHARGE_CLAIM_STALE_MS ||
    !!invoice.checkout_charge_id ||
    age >= CHARGE_CLAIM_AMBIGUOUS_MS
  );
}

/**
 * The SQL twin of `!chargeClaimBlocks`, for the atomic claim `UPDATE … WHERE`.
 * Parameters are namespaced so it composes with the caller's own.
 */
export function chargeClaimFree(now = Date.now()): {
  sql: string;
  params: { claimStale: Date; claimAmbiguous: Date };
} {
  return {
    sql:
      '(charge_started_at IS NULL OR ' +
      '(charge_started_at < :claimStale AND checkout_charge_id IS NULL ' +
      'AND charge_started_at > :claimAmbiguous))',
    params: {
      claimStale: new Date(now - CHARGE_CLAIM_STALE_MS),
      claimAmbiguous: new Date(now - CHARGE_CLAIM_AMBIGUOUS_MS),
    },
  };
}
