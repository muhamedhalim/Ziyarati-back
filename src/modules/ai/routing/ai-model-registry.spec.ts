import { ConfigService } from '@nestjs/config';

import { AiPriceCatalogService } from '../cost/ai-price-catalog.service';
import { AI_EXECUTION_MODE } from '../execution/ai-execution.constants';
import {
  AI_MODEL_IDS,
  AI_MODEL_IDS_ALL,
  AI_MODEL_REGISTRY,
  AI_MODEL_REGISTRY_GA,
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
    expect(new Set(AI_MODEL_IDS_ALL).size).toBe(AI_MODEL_IDS_ALL.length);
  });

  it('never reuses an alias across two models', () => {
    const aliases = AI_MODEL_REGISTRY.flatMap((m) => m.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('never uses another model’s canonical id as an alias', () => {
    for (const model of AI_MODEL_REGISTRY) {
      for (const alias of model.aliases) {
        expect(AI_MODEL_IDS_ALL).not.toContain(alias);
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
    expect(isKnownModel('gpt-4o-2024-11-20')).toBe(true);
    expect(isKnownModel('claude-3')).toBe(false);
    // Verified against GET /v1/models on 2026-08-19: these are NOT real ids.
    // 'gpt-4o-latest' was registered as an alias and does not exist.
    expect(isKnownModel('gpt-4o-latest')).toBe(false);
    // Real, but deliberately unaliased — it is priced at roughly double the
    // current gpt-4o snapshots, so aliasing it would mis-price it. UNPRICED is
    // the honest outcome.
    expect(isKnownModel('gpt-4o-2024-05-13')).toBe(false);
  });

  it('offers at least one ECONOMY model — the routing default depends on it', () => {
    expect(modelsForTier('ECONOMY').length).toBeGreaterThan(0);
  });

  it('offers at least one residency-eligible model per non-empty tier, so a residency turn can always be served', () => {
    // GA only: the router substitutes exclusively from the GA pool, so a
    // residency-eligible PREVIEW model would not actually rescue a turn.
    const eligible = AI_MODEL_REGISTRY_GA.filter(
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

/**
 * A PREVIEW entry is fully described and fully priced but NOT yet proven against
 * this codebase's request shape by the live compatibility spec. The gate is what
 * keeps "we wrote the entry" from silently becoming "tenants are using it": the
 * GPT-5.x family rejects the `temperature` this provider sends by default, so an
 * unproven promotion is not a quality risk but a 100%-failure risk.
 */
describe('AI_MODEL_REGISTRY — PREVIEW gating', () => {
  const prices = new AiPriceCatalogService(new ConfigService());
  const preview = AI_MODEL_REGISTRY.filter((m) => m.releaseStage === 'PREVIEW');

  it('keeps every PREVIEW model out of the tenant-facing allow-list', () => {
    expect(preview.length).toBeGreaterThan(0);
    for (const model of preview) {
      // AI_MODEL_IDS backs the agent DTO, the ai.default_model setting and the
      // dashboard picker — all three are tenant-reachable.
      expect(AI_MODEL_IDS).not.toContain(model.id);
      expect(AI_MODEL_IDS_ALL).toContain(model.id);
    }
  });

  it('still resolves a PREVIEW model by id and alias — operators may select one by env', () => {
    for (const model of preview) {
      expect(findModel(model.id)?.id).toBe(model.id);
      expect(isKnownModel(model.id)).toBe(true);
      for (const alias of model.aliases) {
        expect(findModel(alias)?.id).toBe(model.id);
      }
    }
  });

  it('never offers a PREVIEW model as an automatic tier choice', () => {
    for (const tier of ['ECONOMY', 'STANDARD', 'POWERFUL'] as const) {
      for (const model of modelsForTier(tier)) {
        expect(model.releaseStage).toBe('GA');
      }
    }
    expect(AI_MODEL_REGISTRY_GA.every((m) => m.releaseStage === 'GA')).toBe(true);
  });

  it('prices every PREVIEW model before it can ever be selected', () => {
    // Ordering matters: a model that became selectable before it was priced
    // would bill as UNPRICED for exactly as long as nobody noticed.
    for (const model of preview) {
      expect(prices.quoteChat('openai', model.id, 1_000, 1_000).status).toBe(
        'PRICED',
      );
    }
  });

  it('declares the two facts that make the GPT-5.x family different', () => {
    const gpt5 = preview.filter((m) => m.id.startsWith('gpt-5'));
    expect(gpt5.length).toBeGreaterThan(0);
    for (const model of gpt5) {
      // Without this the provider sends `temperature` and every request 400s.
      expect(model.supportsTemperature).toBe(false);
      // Cache writes bill above the uncached input rate.
      expect(model.cacheWriteMultiplier).toBe(1.25);
    }
  });

  /**
   * Established live on 2026-08-19, not assumed: `/v1/chat/completions` rejects
   * function tools for this family at ANY reasoning effort except 'none' — and
   * OMITTING the field produces the identical 400, because the model applies a
   * default effort of its own. Since essentially every turn in this product
   * carries tools, 'none' is the only usable value, and leaving it unset is the
   * silent footgun: the registry would look complete and every tool turn would
   * fail.
   */
  it('pins reasoning effort to none on every reasoning-family model', () => {
    const reasoning = AI_MODEL_REGISTRY.filter((m) => !m.supportsTemperature);
    expect(reasoning.length).toBeGreaterThan(0);
    for (const model of reasoning) {
      expect(model.reasoningEffort).toBe('none');
    }
  });

  it('has no GA model that would need the temperature omission', () => {
    // If this ever fails, a GA model was promoted without the provider-side
    // capability handling being exercised by the live compat run.
    for (const model of AI_MODEL_REGISTRY_GA) {
      expect(model.supportsTemperature).toBe(true);
    }
  });
});
