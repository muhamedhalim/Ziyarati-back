import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records CACHE-WRITE token spend on the AI cost ledger.
 *
 * `cached_input_tokens` has always meant the discounted READ of an already-cached
 * prompt. The GPT-5.6 family introduces the other half: writing tokens INTO the
 * cache is billed at 1.25x the uncached input rate. With no column for it, a
 * cache-heavy turn on such a model is under-billed by 25% of its cache-write
 * tokens — silently, with no failure to notice — and the shortfall is
 * unreconstructable after the fact because the token count is gone.
 *
 * `cache_write_price_microusd_per_million` stores the rate that was actually
 * applied, exactly as the four existing price columns do. That is what makes the
 * row self-describing: a later catalog revision cannot retroactively change what
 * a historical turn was billed.
 *
 * Additive and nullable, no backfill. Every model priced before this migration
 * bills cache writes at the plain input rate, so a historical row's true
 * cache-write cost is genuinely zero rather than unknown — but the token count
 * for those turns was never captured, and inventing one would assert something
 * this migration cannot verify. New rows always carry a value.
 */
export class AiCostEntryCacheWrite1730055000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0`,
    );
    await q.query(
      `ALTER TABLE ai_cost_entries ADD COLUMN IF NOT EXISTS cache_write_price_microusd_per_million varchar(32)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE ai_cost_entries DROP COLUMN IF EXISTS cache_write_price_microusd_per_million`,
    );
    await q.query(
      `ALTER TABLE ai_cost_entries DROP COLUMN IF EXISTS cache_write_tokens`,
    );
  }
}
