import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AI_EXECUTION_MODE, AiExecutionMode } from '../execution/ai-execution.constants';

export const PRICING_STATUS = {
  PRICED: 'PRICED',
  UNPRICED: 'UNPRICED',
} as const;
export type PricingStatus = (typeof PRICING_STATUS)[keyof typeof PRICING_STATUS];

/**
 * All rates are integer micro-USD per 1,000,000 tokens.
 *
 * `batch*` rates are the discounted OpenAI Batch API prices (≈50% of the
 * synchronous list price). They are stored EXPLICITLY (not derived on the fly) so
 * batch spend is never accidentally billed at the standard rate — satisfying the
 * requirement "Do not calculate Batch Embeddings at the same rates as Standard
 * Embeddings."
 */
export interface AiPriceCatalogEntry {
  provider: string;
  model: string;
  aliases?: string[];
  catalogVersion: string;
  source: string;
  effectiveAt: string;
  inputMicrousdPerMillion?: string;
  cachedInputMicrousdPerMillion?: string;
  outputMicrousdPerMillion?: string;
  embeddingMicrousdPerMillion?: string;
  batchInputMicrousdPerMillion?: string;
  batchCachedInputMicrousdPerMillion?: string;
  batchOutputMicrousdPerMillion?: string;
  batchEmbeddingMicrousdPerMillion?: string;
  /**
   * Regional-processing (data residency) rates. Present ONLY for models that
   * are residency-eligible; absent ⇒ a residency-required request against this
   * model is UNPRICED, never silently billed at the global rate.
   *
   * These are stored explicitly rather than derived from a multiplier, for the
   * same reason the batch rates are: the published uplift is not uniform. OpenAI
   * applies a 10% uplift only to models released on or after 2026-03-05, so a
   * residency-eligible older model (gpt-4o, gpt-4.1, gpt-4.1-mini) carries rates
   * IDENTICAL to its standard ones. A blanket x1.10 would over-bill every one of
   * them. Where an uplift does apply it is computed once, in integer arithmetic,
   * when the entry is authored — never at quote time.
   */
  residencyInputMicrousdPerMillion?: string;
  residencyCachedInputMicrousdPerMillion?: string;
  residencyOutputMicrousdPerMillion?: string;
  residencyEmbeddingMicrousdPerMillion?: string;
  /** BATCH *and* residency: the two dimensions are independent and may combine. */
  batchResidencyInputMicrousdPerMillion?: string;
  batchResidencyCachedInputMicrousdPerMillion?: string;
  batchResidencyOutputMicrousdPerMillion?: string;
  batchResidencyEmbeddingMicrousdPerMillion?: string;
}

export interface AiPriceQuote {
  status: PricingStatus;
  provider: string;
  requestedModel: string;
  executionMode: AiExecutionMode;
  pricedModel?: string;
  catalogVersion?: string;
  source?: string;
  effectiveAt?: string;
  inputMicrousdPerMillion?: string;
  cachedInputMicrousdPerMillion?: string;
  outputMicrousdPerMillion?: string;
  embeddingMicrousdPerMillion?: string;
  costMicrousd: bigint | null;
}

/** The per-million rates selected for a given execution mode. */
interface EffectiveRates {
  input?: string;
  cachedInput?: string;
  output?: string;
  embedding?: string;
}

const OPENAI_SOURCE = 'https://openai.com/api/pricing/';

/**
 * Versioned, centralized price catalog. Rates are published list prices captured
 * on the effective date and represented as integer micro-USD, never JS floats.
 * AI_PRICE_CATALOG_JSON may replace/extend entries without a deployment.
 */
@Injectable()
export class AiPriceCatalogService {
  private readonly logger = new Logger(AiPriceCatalogService.name);
  private readonly entries: AiPriceCatalogEntry[];
  private readonly warned = new Set<string>();

  constructor(config: ConfigService) {
    this.entries = [...this.defaultEntries(), ...this.parseOverrides(config.get<string>('AI_PRICE_CATALOG_JSON'))];
  }

  quoteChat(
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens = 0,
    executionMode: AiExecutionMode = AI_EXECUTION_MODE.STANDARD,
    residencyRequired = false,
  ): AiPriceQuote {
    const entry = this.find(provider, model);
    const rates = entry
      ? this.ratesFor(entry, executionMode, residencyRequired)
      : undefined;
    if (!rates?.input || !rates.output) {
      return this.unpriced(provider, model, executionMode);
    }
    const cached = Math.max(0, Math.min(this.safeTokens(cachedTokens), this.safeTokens(inputTokens)));
    const uncached = this.safeTokens(inputTokens) - cached;
    const cachedRate = rates.cachedInput ?? rates.input;
    const cost = this.tokenCost(uncached, rates.input)
      + this.tokenCost(cached, cachedRate)
      + this.tokenCost(this.safeTokens(outputTokens), rates.output);
    return this.priced(entry!, model, executionMode, rates, cost);
  }

  quoteEmbedding(
    provider: string,
    model: string,
    tokens: number,
    executionMode: AiExecutionMode = AI_EXECUTION_MODE.STANDARD,
    residencyRequired = false,
  ): AiPriceQuote {
    const entry = this.find(provider, model);
    const rates = entry
      ? this.ratesFor(entry, executionMode, residencyRequired)
      : undefined;
    if (!rates?.embedding) return this.unpriced(provider, model, executionMode);
    return this.priced(entry!, model, executionMode, rates, this.tokenCost(this.safeTokens(tokens), rates.embedding));
  }

  /**
   * Select one of FOUR rate sets from the two independent processing dimensions:
   * execution mode (standard | batch) x data residency (global | regional).
   *
   * A missing set is NEVER substituted with another one — an absent residency
   * rate yields UNPRICED, exactly as an absent batch rate always has. That is
   * the guarantee that stops regional or batch work being quietly billed at the
   * standard rate (and vice versa).
   */
  private ratesFor(
    entry: AiPriceCatalogEntry,
    mode: AiExecutionMode,
    residencyRequired = false,
  ): EffectiveRates {
    const batch = mode === AI_EXECUTION_MODE.BATCH;
    if (batch && residencyRequired) {
      return {
        input: entry.batchResidencyInputMicrousdPerMillion,
        cachedInput: entry.batchResidencyCachedInputMicrousdPerMillion,
        output: entry.batchResidencyOutputMicrousdPerMillion,
        embedding: entry.batchResidencyEmbeddingMicrousdPerMillion,
      };
    }
    if (batch) {
      return {
        input: entry.batchInputMicrousdPerMillion,
        cachedInput: entry.batchCachedInputMicrousdPerMillion,
        output: entry.batchOutputMicrousdPerMillion,
        embedding: entry.batchEmbeddingMicrousdPerMillion,
      };
    }
    if (residencyRequired) {
      return {
        input: entry.residencyInputMicrousdPerMillion,
        cachedInput: entry.residencyCachedInputMicrousdPerMillion,
        output: entry.residencyOutputMicrousdPerMillion,
        embedding: entry.residencyEmbeddingMicrousdPerMillion,
      };
    }
    return {
      input: entry.inputMicrousdPerMillion,
      cachedInput: entry.cachedInputMicrousdPerMillion,
      output: entry.outputMicrousdPerMillion,
      embedding: entry.embeddingMicrousdPerMillion,
    };
  }

  private tokenCost(tokens: number, rate: string): bigint {
    // Round half-up to the smallest stored unit (one micro-USD).
    const numerator = BigInt(tokens) * BigInt(rate);
    return (numerator + 500_000n) / 1_000_000n;
  }

  private safeTokens(value: number): number {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  private priced(
    entry: AiPriceCatalogEntry,
    requestedModel: string,
    executionMode: AiExecutionMode,
    rates: EffectiveRates,
    costMicrousd: bigint,
  ): AiPriceQuote {
    return {
      status: PRICING_STATUS.PRICED,
      provider: entry.provider,
      requestedModel,
      executionMode,
      pricedModel: entry.model,
      catalogVersion: entry.catalogVersion,
      source: entry.source,
      effectiveAt: entry.effectiveAt,
      inputMicrousdPerMillion: rates.input,
      cachedInputMicrousdPerMillion: rates.cachedInput,
      outputMicrousdPerMillion: rates.output,
      embeddingMicrousdPerMillion: rates.embedding,
      costMicrousd,
    };
  }

  private unpriced(provider: string, model: string, executionMode: AiExecutionMode): AiPriceQuote {
    const key = `${provider}:${model}:${executionMode}`;
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(`AI pricing is UNPRICED for provider=${provider} model=${model} mode=${executionMode}`);
    }
    return { status: PRICING_STATUS.UNPRICED, provider, requestedModel: model, executionMode, costMicrousd: null };
  }

  private find(provider: string, model: string): AiPriceCatalogEntry | undefined {
    const p = provider.trim().toLowerCase();
    const m = model.trim().toLowerCase();
    // Later config overrides win over built-ins.
    return [...this.entries].reverse().find((entry) =>
      entry.provider.toLowerCase() === p
      && (entry.model.toLowerCase() === m || entry.aliases?.some((alias) => alias.toLowerCase() === m)),
    );
  }

  private parseOverrides(raw?: string): AiPriceCatalogEntry[] {
    if (!raw?.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('expected an array');
      return parsed.map((item, index): AiPriceCatalogEntry => {
        const v = item as Partial<AiPriceCatalogEntry>;
        const rates = [
          v.inputMicrousdPerMillion, v.cachedInputMicrousdPerMillion,
          v.outputMicrousdPerMillion, v.embeddingMicrousdPerMillion,
          v.batchInputMicrousdPerMillion, v.batchCachedInputMicrousdPerMillion,
          v.batchOutputMicrousdPerMillion, v.batchEmbeddingMicrousdPerMillion,
          v.residencyInputMicrousdPerMillion, v.residencyCachedInputMicrousdPerMillion,
          v.residencyOutputMicrousdPerMillion, v.residencyEmbeddingMicrousdPerMillion,
          v.batchResidencyInputMicrousdPerMillion, v.batchResidencyCachedInputMicrousdPerMillion,
          v.batchResidencyOutputMicrousdPerMillion, v.batchResidencyEmbeddingMicrousdPerMillion,
        ].filter((rate): rate is string => rate !== undefined);
        if (!v.provider || !v.model || !v.catalogVersion || !v.source || !v.effectiveAt
          || rates.length === 0 || rates.some((rate) => !/^\d+$/.test(rate))) {
          throw new Error(`entry ${index} is missing required metadata or integer micro-USD rates`);
        }
        return v as AiPriceCatalogEntry;
      });
    } catch (err) {
      throw new Error(`AI_PRICE_CATALOG_JSON is invalid: ${(err as Error).message}`);
    }
  }

  private defaultEntries(): AiPriceCatalogEntry[] {
    const common = { provider: 'openai', catalogVersion: 'openai-public-2026-07-19', source: OPENAI_SOURCE, effectiveAt: '2026-07-19' };
    // Entries added when model routing gained a registry. Rates read from the
    // same published source on the date below; existing entries keep their own
    // snapshot, and every already-written ledger row keeps the snapshot it was
    // priced with.
    const added = { provider: 'openai', catalogVersion: 'openai-public-2026-08-19', source: OPENAI_SOURCE, effectiveAt: '2026-08-19' };
    // Batch rates are the published OpenAI Batch API discount (50% of list).
    //
    // Residency rates: OpenAI applies its 10% regional-processing uplift only to
    // models released on or after 2026-03-05. Every model below predates that,
    // so each residency-eligible one carries rates EQUAL to its standard rates.
    // They are still written out explicitly rather than defaulted, so that a
    // model with no residency set (gpt-4o-mini, which is not on the published
    // regional-processing list) is UNPRICED for residency instead of silently
    // inheriting the global rate.
    return [
      {
        ...common, model: 'gpt-4o', aliases: ['gpt-4o-latest', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
        inputMicrousdPerMillion: '2500000', cachedInputMicrousdPerMillion: '1250000', outputMicrousdPerMillion: '10000000',
        batchInputMicrousdPerMillion: '1250000', batchCachedInputMicrousdPerMillion: '625000', batchOutputMicrousdPerMillion: '5000000',
        residencyInputMicrousdPerMillion: '2500000', residencyCachedInputMicrousdPerMillion: '1250000', residencyOutputMicrousdPerMillion: '10000000',
        batchResidencyInputMicrousdPerMillion: '1250000', batchResidencyCachedInputMicrousdPerMillion: '625000', batchResidencyOutputMicrousdPerMillion: '5000000',
      },
      {
        ...common, model: 'gpt-4.1-mini', aliases: ['gpt-4.1-mini-2025-04-14'],
        inputMicrousdPerMillion: '400000', cachedInputMicrousdPerMillion: '100000', outputMicrousdPerMillion: '1600000',
        batchInputMicrousdPerMillion: '200000', batchCachedInputMicrousdPerMillion: '50000', batchOutputMicrousdPerMillion: '800000',
        residencyInputMicrousdPerMillion: '400000', residencyCachedInputMicrousdPerMillion: '100000', residencyOutputMicrousdPerMillion: '1600000',
        batchResidencyInputMicrousdPerMillion: '200000', batchResidencyCachedInputMicrousdPerMillion: '50000', batchResidencyOutputMicrousdPerMillion: '800000',
      },
      {
        ...added, model: 'gpt-4.1', aliases: ['gpt-4.1-2025-04-14'],
        inputMicrousdPerMillion: '2000000', cachedInputMicrousdPerMillion: '500000', outputMicrousdPerMillion: '8000000',
        batchInputMicrousdPerMillion: '1000000', batchCachedInputMicrousdPerMillion: '250000', batchOutputMicrousdPerMillion: '4000000',
        residencyInputMicrousdPerMillion: '2000000', residencyCachedInputMicrousdPerMillion: '500000', residencyOutputMicrousdPerMillion: '8000000',
        batchResidencyInputMicrousdPerMillion: '1000000', batchResidencyCachedInputMicrousdPerMillion: '250000', batchResidencyOutputMicrousdPerMillion: '4000000',
      },
      {
        // Deliberately NO residency rates — not on the published regional-
        // processing model list, so the router will not select it for a
        // residency-required turn and a quote for one is UNPRICED.
        ...added, model: 'gpt-4o-mini', aliases: ['gpt-4o-mini-2024-07-18'],
        inputMicrousdPerMillion: '150000', cachedInputMicrousdPerMillion: '75000', outputMicrousdPerMillion: '600000',
        batchInputMicrousdPerMillion: '75000', batchCachedInputMicrousdPerMillion: '37500', batchOutputMicrousdPerMillion: '300000',
      },
      {
        ...common, model: 'gpt-5-mini', aliases: ['gpt-5-mini-2025-08-07'],
        inputMicrousdPerMillion: '250000', cachedInputMicrousdPerMillion: '25000', outputMicrousdPerMillion: '2000000',
        batchInputMicrousdPerMillion: '125000', batchCachedInputMicrousdPerMillion: '12500', batchOutputMicrousdPerMillion: '1000000',
      },
      {
        ...common, model: 'text-embedding-3-small',
        embeddingMicrousdPerMillion: '20000', batchEmbeddingMicrousdPerMillion: '10000',
        residencyEmbeddingMicrousdPerMillion: '20000', batchResidencyEmbeddingMicrousdPerMillion: '10000',
      },
      {
        ...common, model: 'text-embedding-3-large',
        embeddingMicrousdPerMillion: '130000', batchEmbeddingMicrousdPerMillion: '65000',
        residencyEmbeddingMicrousdPerMillion: '130000', batchResidencyEmbeddingMicrousdPerMillion: '65000',
      },
    ];
  }
}
