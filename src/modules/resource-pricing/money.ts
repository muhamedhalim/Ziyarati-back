/**
 * Integer minor-unit money helpers for the Pricing Catalog (Phase 2.1, plan
 * §21) — BigInt arithmetic throughout, never a float, mirroring
 * `ai-price-catalog.service.ts`'s established precedent (integer minor
 * units, explicit safe-integer guard before any value crosses into a plain
 * JS `number`).
 */

/** The largest minor-unit value a JS `number` can represent exactly. */
export const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Throws when `value` is negative or would lose precision as a JS `number`
 * (`Number.MAX_SAFE_INTEGER` = 2^53−1). Called at the two points a
 * BigInt minor-unit value is about to be persisted or compared:
 * `resource_price_catalog` admin writes (`max_quantity × unit_price_minor`,
 * plan §21) and `resource_purchases` snapshot computation (Phase 2.2).
 */
export function assertSafeMinor(value: bigint, context: string): void {
  if (value < 0n) {
    throw new Error(`${context}: minor-unit value must not be negative (got ${value})`);
  }
  if (value > MAX_SAFE_MINOR) {
    throw new Error(
      `${context}: minor-unit value exceeds Number.MAX_SAFE_INTEGER (got ${value})`,
    );
  }
}

/** `unit_price_minor × quantity`, exact BigInt multiplication, safe-integer guarded. */
export function computeTotalMinor(unitPriceMinor: bigint, quantity: bigint): bigint {
  const total = unitPriceMinor * quantity;
  assertSafeMinor(total, 'total_minor');
  return total;
}

/** `unit_size × quantity` — the raw units a purchase grants, safe-integer guarded. */
export function computeDeltaUnits(unitSize: bigint, quantity: bigint): bigint {
  const delta = unitSize * quantity;
  assertSafeMinor(delta, 'delta_units');
  return delta;
}

/** Parses a pg-returned bigint STRING column into a BigInt. Throws on a non-integer string. */
export function toBigInt(raw: string | number | bigint): bigint {
  if (typeof raw === 'bigint') return raw;
  return BigInt(raw);
}
