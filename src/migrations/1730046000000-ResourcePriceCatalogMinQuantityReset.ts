import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Pricing Catalog admin form was simplified to "unit price + quantity
 * preview slider" only — `min_quantity` is no longer an admin-editable
 * field, and every item's minimum purchasable quantity is now always
 * exactly one price unit (`unit_size`), matching the "unit price = N item(s)
 * = X currency" framing the simplified form shows. Existing rows may still
 * carry a larger min_quantity set through the old form (e.g. AI_TOKENS was
 * configured at 200 lots = 200,000 tokens) — reset those back to the new,
 * uniform floor of 1.
 *
 * `max_quantity` is untouched: it still bounds real purchases and there is
 * no equivalent request to reset it.
 */
export class ResourcePriceCatalogMinQuantityReset1730046000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "resource_price_catalog" SET "min_quantity" = 1 WHERE "min_quantity" <> 1`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible — the previous per-row values aren't recorded here.
    // `resource_price_change_events` (the append-only price-change audit
    // trail) still has the history if a specific row ever needs restoring.
  }
}
