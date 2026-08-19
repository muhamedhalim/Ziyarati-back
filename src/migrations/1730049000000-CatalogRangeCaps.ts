import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sets a sensible `max_quantity` ceiling for three catalog items that were
 * left uncapped after `1730046000000-ResourcePriceCatalogMinQuantityReset`
 * (which reset every `min_quantity` to 1, but never touched `max_quantity`):
 *
 *   - `branches`      → 1–20 branches per purchase
 *   - `APPOINTMENTS`  → 1–1,000 appointments per purchase
 *   - `CAMPAIGNS`     → 1–1,000 campaigns per purchase
 *
 * `unit_size` is 1 for all three, so `max_quantity` is directly the
 * real-world unit count. `min_quantity` is already 1 for all three — only
 * the ceiling is being set here.
 *
 * Scoped to these 3 rows only — every other catalog row (and these three's
 * own unit_price_minor/currency/is_active/sort_order/min_quantity) is
 * untouched. Mirrors `1730047000000-AiTokensMinQuantity50k.ts`'s pattern.
 */
export class CatalogRangeCaps1730049000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "resource_price_catalog" SET "max_quantity" = 20 WHERE "item_key" = 'branches'`,
    );
    await q.query(
      `UPDATE "resource_price_catalog" SET "max_quantity" = 1000 WHERE "item_key" = 'APPOINTMENTS'`,
    );
    await q.query(
      `UPDATE "resource_price_catalog" SET "max_quantity" = 1000 WHERE "item_key" = 'CAMPAIGNS'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible — the previous per-row values (NULL) aren't recorded
    // here. `resource_price_change_events` (the append-only price-change
    // audit trail) still has the history if a specific row ever needs
    // restoring.
  }
}
