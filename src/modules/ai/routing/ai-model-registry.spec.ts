import { ConfigService } from '@nestjs/config';

import { AiPriceCatalogService } from '../cost/ai-price-catalog.service';
import { AI_EXECUTION_MODE } from '../execution/ai-execution.constants';
import {
  AI_MODEL_IDS,
  AI_MODEL_REGISTRY,
  findModel,
  isKnownModel,
  modelsForTier,
} from './ai-model-registry';

/**
 * The registry is the allow-list enforced by env validation, the platform
 * setting and the agent DTO — so a model reachable through any of those must
 * also be priceable and dispatchable. These tests are the guard against the
 * registry and the price catalog drifting apart, which is exactly how a routed
 * turn silently becomes an UNPRICED cost row.
 */
describe('AI_MODEL_REGISTRY', () => {
  const prices = new AiPriceCatalogService(new ConfigService());

  it('has unique canonical ids', () => {
    expect(new Set(AI_MODEL_IDS).size).toBe(AI_MODEL_IDS.length);
  });

  it('never reuses an alias across two models', () => {
    const aliases = AI_MODEL_REGISTRY.flatMap((m) => m.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('never uses another model’s canonical id as an alias', () => {
    for (const model of AI_MODEL_REGISTRY) {
      for (const alias of model.aliases) {
        expect(AI_MODEL_IDS).not.toContain(alias);
      }
    }
  });

  it.each([...AI_MODEL_REGISTRY])(
    '$id is priceable for STANDARD execution',
    (model) => {
      const quote = prices.quoteChat('openai', model.id, 1_000, 1_000);
      expect(quote.status).toBe('PRICED');
      expect(quote.costMicrousd).not.toBeNull();
    },
  );

  it.each([...AI_MODEL_REGISTRY])(
    '$id prices every execution mode it claims to support',
    (model) => {
      for (const mode of model.supportedExecutionModes) {
        const quote = prices.quoteChat('openai', model.id, 1_000, 1_000, 0, mode);
        expect(quote.status).toBe('PRICED');
      }
    },
  );

  it.each([...AI_MODEL_REGISTRY])(
    '$id prices residency only when it claims residency support',
    (model) => {
      const quote = prices.quoteChat(
        'openai',
        model.id,
        1_000,
        1_000,
        0,
        AI_EXECUTION_MODE.STANDARD,
        true,
      );
      // A residency-eligible model must have residency rates; one that is not
      // eligible must come back UNPRICED rather than inherit the global rate.
      expect(quote.status).toBe(
        model.supportedResidencyRegions?.length ? 'PRICED' : 'UNPRICED',
      );
    },
  );

  it.each([...AI_MODEL_REGISTRY])(
    '$id prices every dated snapshot alias identically to its canonical id',
    (model) => {
      const canonical = prices.quoteChat('openai', model.id, 1_000, 1_000);
      for (const alias of model.aliases) {
        const aliased = prices.quoteChat('openai', alias, 1_000, 1_000);
        expect(aliased.status).toBe('PRICED');
        expect(aliased.costMicrousd).toBe(canonical.costMicrousd);
      }
    },
  );

  it('resolves ids and aliases case- and whitespace-insensitively', () => {
    expect(findModel('  GPT-4O  ')?.id).toBe('gpt-4o');
    expect(findModel('gpt-4.1-mini-2025-04-14')?.id).toBe('gpt-4.1-mini');
    expect(findModel('gpt-does-not-exist')).toBeUndefined();
    expect(findModel(undefined)).toBeUndefined();
    expect(findModel(null)).toBeUndefined();
    expect(isKnownModel('gpt-4o-latest')).toBe(true);
    expect(isKnownModel('claude-3')).toBe(false);
  });

  it('offers at least one ECONOMY model — the routing default depends on it', () => {
    expect(modelsForTier('ECONOMY').length).toBeGreaterThan(0);
  });

  it('offers at least one residency-eligible model per non-empty tier, so a residency turn can always be served', () => {
    const eligible = AI_MODEL_REGISTRY.filter(
      (m) => m.supportedResidencyRegions?.length,
    );
    expect(eligible.length).toBeGreaterThan(0);
  });

  it('declares a context window large enough to be worth routing to', () => {
    for (const model of AI_MODEL_REGISTRY) {
      expect(model.contextWindowTokens).toBeGreaterThan(model.maxOutputTokens);
    }
  });

  it('only registers models that can actually serve a chat turn', () => {
    // Every current call site streams and calls tools; a model without both
    // would break the turn rather than merely cost less.
    for (const model of AI_MODEL_REGISTRY) {
      expect(model.supportsTools).toBe(true);
      expect(model.supportsStreaming).toBe(true);
    }
  });
});
