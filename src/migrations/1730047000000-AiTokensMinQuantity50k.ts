import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Raises AI_TOKENS' minimum purchasable quantity from 1 lot (1,000 tokens —
 * see `1730046000000-ResourcePriceCatalogMinQuantityReset.ts`) to 50 lots
 * (50,000 tokens), and its cap from 300 lots (300,000 tokens) to 1,000 lots
 * (1,000,000 tokens = "a million").
 *
 * `min_quantity`/`max_quantity` are stored in LOTS, not raw tokens —
 * `min_quantity × unit_size` (1,000 for AI_TOKENS) is the real-world token
 * count: 50 × 1,000 = 50,000; 1,000 × 1,000 = 1,000,000.
 *
 * Scoped to `item_key = 'AI_TOKENS'` only — every other catalog row (and
 * AI_TOKENS' own unit_price_minor/currency/is_active/sort_order) is
 * untouched.
 */
export class AiTokensMinQuantity50k1730047000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "resource_price_catalog"
          SET "min_quantity" = 50, "max_quantity" = 1000
        WHERE "item_key" = 'AI_TOKENS'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible — the previous per-row values aren't recorded here.
    // `resource_price_change_events` (the append-only price-change audit
    // trail) still has the history if this specific row ever needs restoring.
  }
}
