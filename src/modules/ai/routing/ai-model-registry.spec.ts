import { ConfigService } from '@nestjs/config';

import { AiPriceCatalogService } from '../cost/ai-price-catalog.service';
import { AI_EXECUTION_MODE } from '../execution/ai-execution.constants';
import {
  AI_MODEL_IDS,
  AI_MODEL_IDS_ALL,
  AI_MODEL_REGISTRY,
  AI_MODEL_REGISTRY_GA,
  AI_SELECTABLE_MODELS,
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
 * The supported model set, stated once, explicitly.
 *
 * Every other allow-list in the codebase is DERIVED from the registry, so this
 * is the only place the intended set is written down as a literal. If a model
 * is added or dropped, exactly one test should fail — and it should be this
 * one, deliberately, rather than something downstream failing obscurely.
 */
describe('AI_MODEL_REGISTRY — the supported model set', () => {
  const EXPECTED = [
    { id: 'gpt-4o', displayName: 'GPT-4o' },
    { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini' },
    { id: 'gpt-4.1', displayName: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini' },
    { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
    { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  ];

  it('registers exactly the six supported models', () => {
    expect([...AI_MODEL_IDS_ALL].sort()).toEqual(
      EXPECTED.map((m) => m.id).sort(),
    );
  });

  it('makes all six tenant-selectable', () => {
    // AI_MODEL_IDS backs the agent DTO, the ai.default_model platform setting
    // and GET /ai/agents/models. One list, three enforcement points.
    expect([...AI_MODEL_IDS].sort()).toEqual(EXPECTED.map((m) => m.id).sort());
  });

  it('labels each one for the picker', () => {
    for (const { id, displayName } of EXPECTED) {
      expect(findModel(id)?.displayName).toBe(displayName);
    }
  });

  it('exposes id + label to the dashboard and nothing else', () => {
    // Widening this is how a capability table leaks into a public API: reasoning
    // effort, cache-write multipliers and residency regions are cost mechanics,
    // not information a clinic picks an assistant with.
    for (const option of AI_SELECTABLE_MODELS) {
      expect(Object.keys(option).sort()).toEqual(['displayName', 'id']);
    }
    expect(AI_SELECTABLE_MODELS.map((m) => m.id)).toEqual([...AI_MODEL_IDS]);
  });

  it('gives every model a distinct, non-empty label', () => {
    const names = AI_MODEL_REGISTRY.map((m) => m.displayName);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.trim().length > 0)).toBe(true);
  });

  it('rejects the alias claims that were verified NOT to exist', () => {
    // All three were once written down here as real snapshots. They are not.
    // Re-adding any of them silently re-prices or mis-resolves a turn.
    for (const fake of [
      'gpt-4o-latest',
      'gpt-5.6-luna-2026-06-11',
      'gpt-5.6-terra-2026-06-11',
    ]) {
      expect(isKnownModel(fake)).toBe(false);
      expect(AI_MODEL_IDS).not.toContain(fake);
      expect(AI_MODEL_IDS_ALL).not.toContain(fake);
    }
  });

  it('publishes no dated snapshot for the GPT-5.6 family', () => {
    // Verified against GET /v1/models: the family has no dated snapshots at all.
    // An empty list is the claim; a populated one would be an invention.
    for (const model of AI_MODEL_REGISTRY.filter((m) =>
      m.id.startsWith('gpt-5.6'),
    )) {
      expect(model.aliases).toEqual([]);
    }
  });
});

/**
 * Release-stage gating.
 *
 * There are currently NO preview models — the GPT-5.6 family was promoted once
 * it had passed the live compatibility gate and the provider had learned to
 * read its capability flags. These tests therefore assert the LAWS of the
 * mechanism rather than the membership of the set, so they keep guarding the
 * next model to come through instead of quietly becoming vacuous.
 */
describe('AI_MODEL_REGISTRY — release-stage gating', () => {
  const prices = new AiPriceCatalogService(new ConfigService());

  it('derives the tenant-facing allow-list from GA membership alone', () => {
    expect([...AI_MODEL_IDS]).toEqual(
      AI_MODEL_REGISTRY.filter((m) => m.releaseStage === 'GA').map((m) => m.id),
    );
    for (const model of AI_MODEL_REGISTRY) {
      if (model.releaseStage === 'PREVIEW') {
        // The gate, stated as a law: whatever is PREVIEW is env-selectable by an
        // operator and never reachable from a tenant surface.
        expect(AI_MODEL_IDS).not.toContain(model.id);
        expect(AI_MODEL_IDS_ALL).toContain(model.id);
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

  it('resolves every registered model by id and alias regardless of stage', () => {
    for (const model of AI_MODEL_REGISTRY) {
      expect(findModel(model.id)?.id).toBe(model.id);
      expect(isKnownModel(model.id)).toBe(true);
      for (const alias of model.aliases) {
        expect(findModel(alias)?.id).toBe(model.id);
      }
    }
  });

  it('prices every model before it can ever be selected', () => {
    // Ordering matters: a model that became selectable before it was priced
    // would bill as UNPRICED for exactly as long as nobody noticed.
    for (const model of AI_MODEL_REGISTRY) {
      expect(prices.quoteChat('openai', model.id, 1_000, 1_000).status).toBe(
        'PRICED',
      );
    }
  });
});

/**
 * The GPT-5.6 family's capability contract.
 *
 * Asserted against the registry directly rather than through a release-stage
 * filter, so promoting or demoting the family cannot make this coverage vanish.
 * Every value here was established by the live compatibility run on 2026-08-19
 * (docs/AI_MODEL_LIVE_VERIFICATION.md), not inferred.
 */
describe('AI_MODEL_REGISTRY — GPT-5.6 capability contract', () => {
  const prices = new AiPriceCatalogService(new ConfigService());
  const gpt56 = AI_MODEL_REGISTRY.filter((m) => m.id.startsWith('gpt-5.6'));

  it('registers both GPT-5.6 models', () => {
    expect(gpt56.map((m) => m.id).sort()).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ]);
  });

  it.each(['gpt-5.6-luna', 'gpt-5.6-terra'])(
    '%s declares the three facts that make it different in kind',
    (id) => {
      const model = findModel(id)!;
      // 1. Any explicit temperature is a 400 — the provider must omit the field.
      expect(model.supportsTemperature).toBe(false);
      // 2. 'none' is mandatory, not a preference: /v1/chat/completions rejects
      //    function tools at every other effort INCLUDING when the field is
      //    omitted, because the model then applies a default of its own.
      expect(model.reasoningEffort).toBe('none');
      // 3. Cache writes bill above the uncached input rate.
      expect(model.cacheWriteMultiplier).toBe(1.25);
    },
  );

  it.each(['gpt-5.6-luna', 'gpt-5.6-terra'])(
    '%s carries a cache-write rate, so its cache writes cannot go unbilled',
    (id) => {
      const withCacheWrite = prices.quoteChat(
        'openai',
        id,
        10_000,
        1_000,
        0,
        AI_EXECUTION_MODE.STANDARD,
        false,
        5_000,
      );
      const without = prices.quoteChat('openai', id, 10_000, 1_000);
      expect(withCacheWrite.status).toBe('PRICED');
      expect(withCacheWrite.cacheWriteMicrousdPerMillion).toBeDefined();
      // The surcharge is real money, not a rounding artefact.
      expect(withCacheWrite.costMicrousd! > without.costMicrousd!).toBe(true);
    },
  );

  it('pins reasoning effort on EVERY model that omits temperature', () => {
    // The generalisation of the fact above: a model the provider will not send a
    // temperature for is a reasoning model, and a reasoning model with no effort
    // pinned fails every tool turn while looking perfectly configured.
    const reasoning = AI_MODEL_REGISTRY.filter((m) => !m.supportsTemperature);
    expect(reasoning.length).toBeGreaterThan(0);
    for (const model of reasoning) {
      expect(model.reasoningEffort).toBe('none');
    }
  });

  it('keeps GPT-5.6 out of the GPT-4.x behaviour it must not inherit', () => {
    for (const model of AI_MODEL_REGISTRY.filter(
      (m) => !m.id.startsWith('gpt-5.6'),
    )) {
      // Every GPT-4.x model still takes a temperature and sends no effort, so
      // promoting GPT-5.6 changed nothing about how they are dispatched.
      expect(model.supportsTemperature).toBe(true);
      expect(model.reasoningEffort).toBeUndefined();
      expect(model.cacheWriteMultiplier).toBeUndefined();
    }
  });
});
