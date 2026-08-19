import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Raises the minimum purchasable quantity of the three byte-denominated
 * catalog items (`storageBytes`, `uploadedFiles`, `trainingFiles`) from 1
 * lot to 1,024 lots.
 *
 * These three items' `unit_size` becomes 1,048,576 bytes (1 MB) — see
 * `sellable-resource.registry.ts` — so "1 lot" = 1 MB. Setting
 * `min_quantity = 1024` makes the minimum purchase exactly 1,024 MB = 1 GiB,
 * which means the admin's single "price for the minimum purchase" input
 * (unchanged pricing formula — see `ResourceCatalogAdminService.updatePrice`)
 * *is* the price per GB, with no change to how that price is computed.
 *
 * `max_quantity` is deliberately left untouched (NULL) — the existing
 * frontend fallback (`DEFAULT_MAX_QUANTITY_FALLBACK` = 1,000,000 lots ≈
 * 976 GiB) already covers it, same as several other catalog rows.
 *
 * Scoped to these 3 rows only. Mirrors
 * `1730047000000-AiTokensMinQuantity50k.ts`'s pattern.
 */
export class StorageItemsMbLotMinimum1730050000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "resource_price_catalog"
          SET "min_quantity" = 1024
        WHERE "item_key" IN ('storageBytes', 'uploadedFiles', 'trainingFiles')`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible — the previous per-row values aren't recorded here.
    // `resource_price_change_events` (the append-only price-change audit
    // trail) still has the history if a specific row ever needs restoring.
  }
}
