import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Raises WHATSAPP_MESSAGES' minimum purchasable quantity from 1 lot (1
 * message — see `1730046000000-ResourcePriceCatalogMinQuantityReset.ts`) to
 * 1,000 lots (1,000 messages), and sets its cap to 1,000,000 lots
 * (1,000,000 messages = "a million") in place of the unset `max_quantity`
 * that made the frontend fall back to its `min_quantity × 20` placeholder
 * (20 messages — an illogical ceiling below even the old 1-message floor).
 *
 * `min_quantity`/`max_quantity` are stored in LOTS, and `unit_size` is 1 for
 * WHATSAPP_MESSAGES, so lots and messages are numerically identical here.
 *
 * Scoped to `item_key = 'WHATSAPP_MESSAGES'` only — every other catalog row
 * (and WHATSAPP_MESSAGES' own unit_price_minor/currency/is_active/sort_order)
 * is untouched. Mirrors `1730047000000-AiTokensMinQuantity50k.ts` exactly.
 */
export class WhatsappMessagesMinQuantity1k1730048000000
  implements MigrationInterface
{
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "resource_price_catalog"
          SET "min_quantity" = 1000, "max_quantity" = 1000000
        WHERE "item_key" = 'WHATSAPP_MESSAGES'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible — the previous per-row values aren't recorded here.
    // `resource_price_change_events` (the append-only price-change audit
    // trail) still has the history if this specific row ever needs restoring.
  }
}
