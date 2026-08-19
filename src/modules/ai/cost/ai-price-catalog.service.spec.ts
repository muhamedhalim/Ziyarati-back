import { ConfigService } from '@nestjs/config';
import { AiPriceCatalogService, PRICING_STATUS } from './ai-price-catalog.service';
import { AI_EXECUTION_MODE } from '../execution/ai-execution.constants';

describe('AiPriceCatalogService', () => {
  it('calculates input, cached input, and output with integer micro-USD', () => {
    const catalog = new AiPriceCatalogService(new ConfigService());
    const quote = catalog.quoteChat('openai', 'gpt-4o', 1_000, 500, 400);
    expect(quote.status).toBe(PRICING_STATUS.PRICED);
    expect(quote.costMicrousd).toBe(7_000n);
  });

  it('calculates embedding tokens independently', () => {
    const quote = new AiPriceCatalogService(new ConfigService())
      .quoteEmbedding('openai', 'text-embedding-3-small', 1_000);
    expect(quote.costMicrousd).toBe(20n);
    expect(quote.embeddingMicrousdPerMillion).toBe('20000');
  });

  it('prices BATCH embeddings at a different (lower) rate than STANDARD', () => {
    const catalog = new AiPriceCatalogService(new ConfigService());
    const standard = catalog.quoteEmbedding('openai', 'text-embedding-3-small', 1_000);
    const batch = catalog.quoteEmbedding('openai', 'text-embedding-3-small', 1_000, AI_EXECUTION_MODE.BATCH);
    expect(standard.costMicrousd).toBe(20n);
    expect(batch.costMicrousd).toBe(10n); // half of standard — never the same rate
    expect(batch.executionMode).toBe(AI_EXECUTION_MODE.BATCH);
    expect(batch.embeddingMicrousdPerMillion).toBe('10000');
    expect(batch.costMicrousd).not.toBe(standard.costMicrousd);
  });

  it('prices BATCH chat at half the standard rate and stamps the mode', () => {
    const catalog = new AiPriceCatalogService(new ConfigService());
    const standard = catalog.quoteChat('openai', 'gpt-4o', 1_000, 500, 400);
    const batch = catalog.quoteChat('openai', 'gpt-4o', 1_000, 500, 400, AI_EXECUTION_MODE.BATCH);
    expect(standard.costMicrousd).toBe(7_000n);
    expect(batch.costMicrousd).toBe(3_500n);
    expect(batch.executionMode).toBe(AI_EXECUTION_MODE.BATCH);
  });

  it('never treats an unknown model as free', () => {
    const quote = new AiPriceCatalogService(new ConfigService())
      .quoteChat('openai', 'gpt-unknown', 1_000, 1_000);
    expect(quote.status).toBe(PRICING_STATUS.UNPRICED);
    expect(quote.costMicrousd).toBeNull();
  });

  it('keeps an historical quote immutable when a new catalog is configured', () => {
    const oldQuote = new AiPriceCatalogService(new ConfigService())
      .quoteChat('openai', 'gpt-4o', 1_000_000, 0);
    const override = JSON.stringify([{
      provider: 'openai', model: 'gpt-4o', catalogVersion: 'future-v2',
      source: 'operator-approved', effectiveAt: '2027-01-01',
      inputMicrousdPerMillion: '9999999', outputMicrousdPerMillion: '9999999',
    }]);
    const newQuote = new AiPriceCatalogService(new ConfigService({ AI_PRICE_CATALOG_JSON: override }))
      .quoteChat('openai', 'gpt-4o', 1_000_000, 0);
    expect(oldQuote.catalogVersion).toBe('openai-public-2026-07-19');
    expect(oldQuote.costMicrousd).toBe(2_500_000n);
    expect(newQuote.catalogVersion).toBe('future-v2');
    expect(newQuote.costMicrousd).toBe(9_999_999n);
  });
});

/**
 * Pricing is a function of (model x execution mode x residency x token class).
 * The two processing dimensions are independent, so there are FOUR rate sets,
 * and a missing one must never be substituted with another.
 */
describe('AiPriceCatalogService — processing-mode pricing', () => {
  const catalog = () => new AiPriceCatalogService(new ConfigService());
  const MILLION = 1_000_000;

  it('prices STANDARD + global at the list rate', () => {
    const quote = catalog().quoteChat('openai', 'gpt-4.1-mini', MILLION, 0);
    expect(quote.costMicrousd).toBe(400_000n);
  });

  it('prices BATCH at the published batch rate, not a derived percentage', () => {
    const quote = catalog().quoteChat(
      'openai', 'gpt-4.1-mini', MILLION, 0, 0, AI_EXECUTION_MODE.BATCH,
    );
    // The stored batch rate happens to be half here, but it is READ, not computed.
    expect(quote.costMicrousd).toBe(200_000n);
    expect(quote.inputMicrousdPerMillion).toBe('200000');
  });

  it('prices residency from its own rate set — no uplift for a pre-2026-03-05 model', () => {
    const standard = catalog().quoteChat('openai', 'gpt-4.1-mini', MILLION, 0);
    const residency = catalog().quoteChat(
      'openai', 'gpt-4.1-mini', MILLION, 0, 0, AI_EXECUTION_MODE.STANDARD, true,
    );
    expect(residency.status).toBe(PRICING_STATUS.PRICED);
    // gpt-4.1-mini is residency-eligible but predates the 10% uplift cutoff, so
    // a blanket x1.10 would have over-billed it.
    expect(residency.costMicrousd).toBe(standard.costMicrousd);
  });

  it('prices BATCH + residency together — the dimensions are not mutually exclusive', () => {
    const quote = catalog().quoteChat(
      'openai', 'gpt-4.1-mini', MILLION, 0, 0, AI_EXECUTION_MODE.BATCH, true,
    );
    expect(quote.status).toBe(PRICING_STATUS.PRICED);
    expect(quote.costMicrousd).toBe(200_000n);
  });

  it('returns UNPRICED for a residency request against a model with no residency rates', () => {
    // gpt-4o-mini is not on the published regional-processing list.
    const quote = catalog().quoteChat(
      'openai', 'gpt-4o-mini', MILLION, 0, 0, AI_EXECUTION_MODE.STANDARD, true,
    );
    expect(quote.status).toBe(PRICING_STATUS.UNPRICED);
    expect(quote.costMicrousd).toBeNull();
  });

  it('never silently falls back to the global rate for an unpriced residency request', () => {
    const global = catalog().quoteChat('openai', 'gpt-4o-mini', MILLION, 0);
    const residency = catalog().quoteChat(
      'openai', 'gpt-4o-mini', MILLION, 0, 0, AI_EXECUTION_MODE.STANDARD, true,
    );
    expect(global.costMicrousd).toBe(150_000n);
    expect(residency.costMicrousd).not.toBe(global.costMicrousd);
  });

  it('prices the newly registered models', () => {
    expect(catalog().quoteChat('openai', 'gpt-4o-mini', MILLION, 0).costMicrousd).toBe(150_000n);
    expect(catalog().quoteChat('openai', 'gpt-4.1', MILLION, 0).costMicrousd).toBe(2_000_000n);
    // Catalog-only (not in the routing registry): still priced, so a stored or
    // provider-echoed id lands as PRICED rather than UNPRICED.
    expect(catalog().quoteChat('openai', 'gpt-4.1-nano', MILLION, 0).costMicrousd).toBe(100_000n);
  });

  it('keeps every cost in exact integer micro-USD (bigint), never a float', () => {
    const modes = [AI_EXECUTION_MODE.STANDARD, AI_EXECUTION_MODE.BATCH];
    for (const mode of modes) {
      for (const residency of [false, true]) {
        const quote = catalog().quoteChat(
          'openai', 'gpt-4.1-mini', 333_333, 77_777, 11_111, mode, residency,
        );
        expect(typeof quote.costMicrousd).toBe('bigint');
        // A float-derived value would not survive an exact bigint comparison
        // against itself recomputed — this asserts the type contract holds on
        // deliberately non-round token counts.
        expect(quote.costMicrousd).toBe(
          catalog().quoteChat(
            'openai', 'gpt-4.1-mini', 333_333, 77_777, 11_111, mode, residency,
          ).costMicrousd,
        );
      }
    }
  });

  it('defaults to STANDARD + global when the new parameters are omitted (back-compat)', () => {
    const explicit = catalog().quoteChat(
      'openai', 'gpt-4o', 1_000, 500, 400, AI_EXECUTION_MODE.STANDARD, false,
    );
    const implicit = catalog().quoteChat('openai', 'gpt-4o', 1_000, 500, 400);
    expect(implicit.costMicrousd).toBe(explicit.costMicrousd);
  });
});

/**
 * Two things arrive together with the GPT-5.6 family and nothing before it: a
 * residency uplift that is actually non-zero, and a cache-WRITE rate above the
 * uncached input rate. Both under-bill silently if unhandled — there is no error
 * to notice, only a number that is quietly too small.
 */
describe('AiPriceCatalogService — cache writes and the residency uplift', () => {
  const catalog = () => new AiPriceCatalogService(new ConfigService());
  const MILLION = 1_000_000;

  it('charges nothing extra for cache writes on a model that does not bill them', () => {
    // Every GPT-4.x model: cache-write tokens are already inside inputTokens at
    // the uncached rate. Billing them again would double-charge.
    const without = catalog().quoteChat('openai', 'gpt-4o', MILLION, 0);
    const with_ = catalog().quoteChat(
      'openai', 'gpt-4o', MILLION, 0, 0, AI_EXECUTION_MODE.STANDARD, false, MILLION,
    );
    expect(with_.costMicrousd).toBe(without.costMicrousd);
    expect(with_.cacheWriteMicrousdPerMillion).toBeUndefined();
  });

  it('charges only the DIFFERENCE above the input rate, never the full rate again', () => {
    // gpt-5.6-luna: input 200,000 µ$/M, cache write 250,000 µ$/M.
    // 1M input of which 1M is a cache write ⇒ 200,000 + (250,000 − 200,000).
    const quote = catalog().quoteChat(
      'openai', 'gpt-5.6-luna', MILLION, 0, 0, AI_EXECUTION_MODE.STANDARD, false, MILLION,
    );
    expect(quote.costMicrousd).toBe(250_000n);
    // Not 200,000 + 250,000 = 450,000: those tokens are counted once already.
    expect(quote.costMicrousd).not.toBe(450_000n);
    expect(quote.cacheWriteMicrousdPerMillion).toBe('250000');
  });

  it('never bills more cache-write tokens than there were uncached tokens', () => {
    const quote = catalog().quoteChat(
      'openai', 'gpt-5.6-luna', MILLION, 0, MILLION, AI_EXECUTION_MODE.STANDARD, false, MILLION,
    );
    // Everything was a cache READ, so there is nothing left that could have been
    // a cache WRITE. Charging one anyway would invent spend.
    expect(quote.costMicrousd).toBe(20_000n);
  });

  it('applies the cache-write rate of the SELECTED mode, not the standard one', () => {
    const batch = catalog().quoteChat(
      'openai', 'gpt-5.6-luna', MILLION, 0, 0, AI_EXECUTION_MODE.BATCH, false, MILLION,
    );
    // Batch: input 100,000, cache write 125,000 ⇒ 100,000 + 25,000.
    expect(batch.costMicrousd).toBe(125_000n);
    expect(batch.cacheWriteMicrousdPerMillion).toBe('125000');
  });

  it('is the first family where the residency uplift is genuinely +10%', () => {
    const global = catalog().quoteChat('openai', 'gpt-5.6-luna', MILLION, MILLION);
    const regional = catalog().quoteChat(
      'openai', 'gpt-5.6-luna', MILLION, MILLION, 0, AI_EXECUTION_MODE.STANDARD, true,
    );
    // 200,000 + 1,200,000 = 1,400,000 ⇒ +10% = 1,540,000, in exact integers.
    expect(global.costMicrousd).toBe(1_400_000n);
    expect(regional.costMicrousd).toBe(1_540_000n);
    expect((regional.costMicrousd as bigint) * 10n).toBe(
      (global.costMicrousd as bigint) * 11n,
    );
  });

  it('still applies NO uplift to the pre-2026-03-05 models, as published', () => {
    for (const model of ['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1']) {
      const global = catalog().quoteChat('openai', model, MILLION, MILLION);
      const regional = catalog().quoteChat(
        'openai', model, MILLION, MILLION, 0, AI_EXECUTION_MODE.STANDARD, true,
      );
      expect(regional.costMicrousd).toBe(global.costMicrousd);
    }
  });

  it('combines batch, residency and cache writes without a single float', () => {
    const quote = catalog().quoteChat(
      'openai', 'gpt-5.6-terra', MILLION, MILLION, 0, AI_EXECUTION_MODE.BATCH, true, MILLION,
    );
    // batch+residency: input 1,100,000, output 6,600,000, cache write 1,375,000
    // ⇒ 1,100,000 + 6,600,000 + (1,375,000 − 1,100,000).
    expect(quote.costMicrousd).toBe(7_975_000n);
    expect(typeof quote.costMicrousd).toBe('bigint');
  });

  it('records which cache-write rate was applied, so a row stays self-describing', () => {
    const regional = catalog().quoteChat(
      'openai', 'gpt-5.6-luna', 1_000, 1_000, 0, AI_EXECUTION_MODE.STANDARD, true, 500,
    );
    expect(regional.cacheWriteMicrousdPerMillion).toBe('275000');
    expect(regional.inputMicrousdPerMillion).toBe('220000');
  });
});
