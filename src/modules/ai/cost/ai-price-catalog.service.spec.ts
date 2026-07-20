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
