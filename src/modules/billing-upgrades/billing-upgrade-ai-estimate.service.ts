import { Injectable, Logger } from '@nestjs/common';

import { AiProviderFactory } from '../ai/providers/ai-provider.factory';
import { BillingUpgradeConfig } from './billing-upgrade.config';
import { BillingUpgradeType } from './billing-upgrade.constants';

export interface AiEstimateInput {
  requestType: BillingUpgradeType;
  /** Feature key (type=feature) or usage metric key (type=usage_limit). */
  targetKey: string;
  requestedQuantity: number | null;
  currentUsage: number | null;
  currentLimit: number | null;
  billingPeriod: string | null;
  /** Average per-period usage over recent history — aggregate number only. */
  historicalAverageUsage: number | null;
  currency: string;
}

export interface AiEstimateResult {
  estimatedProviderCostMinor: number;
  estimatedInfraCostMinor: number;
  recommendedPriceMinor: number;
  /** 0..1 */
  confidenceScore: number;
  assumptions: string[];
  pricingBreakdown: Record<string, number>;
  source: 'ai' | 'heuristic_fallback';
  error?: string;
}

/**
 * ADVISORY-ONLY AI cost estimation for the super-admin quote screen.
 *
 * This service NEVER executes payments and NEVER determines the final price —
 * `BillingUpgradeAdminService.quote()` always requires the super admin to set
 * `finalPriceMinor` explicitly; the AI output is stored purely as a suggestion
 * the admin may accept, adjust, or ignore.
 *
 * Data-safety: the prompt is built EXCLUSIVELY from the numeric/structural
 * fields on `AiEstimateInput` — requested quantity, plan limit/usage snapshot,
 * billing period, an aggregate historical-average number, and provider/infra
 * unit-cost configuration. No tenant name, tenant id, customer/patient record,
 * or any other raw tenant content is ever included.
 *
 * Reaches the model ONLY through `AiProviderFactory`/`AiCompletionProvider`
 * (never a direct SDK import), matching every other AI call in the codebase.
 * A provider failure, timeout, or malformed response NEVER throws — it falls
 * back to a deterministic heuristic so the super admin can always price the
 * request manually.
 */
@Injectable()
export class BillingUpgradeAiEstimateService {
  private readonly logger = new Logger('BillingUpgradeAiEstimateService');

  constructor(
    private readonly providers: AiProviderFactory,
    private readonly config: BillingUpgradeConfig,
  ) {}

  async estimate(input: AiEstimateInput): Promise<AiEstimateResult> {
    const heuristic = this.heuristicEstimate(input);

    try {
      const provider = this.providers.resolve();
      const result = await provider.complete({
        tenantId: 'platform',
        feature: 'billing_upgrade_estimate',
        route: 'platform.billing_upgrade.estimate',
        channel: 'internal',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are a SaaS pricing analyst. Given aggregated, non-identifying usage and cost figures, ' +
              'estimate provider cost, infrastructure cost, a recommended selling price, a confidence score, ' +
              'assumptions, and a pricing breakdown. Respond with STRICT JSON ONLY, no prose, matching exactly: ' +
              '{"estimatedProviderCostMinor": number, "estimatedInfraCostMinor": number, ' +
              '"recommendedPriceMinor": number, "confidenceScore": number between 0 and 1, ' +
              '"assumptions": string[], "pricingBreakdown": {[label: string]: number}}. ' +
              'All monetary values are integers in MINOR currency units (e.g. halalas/cents).',
          },
          {
            role: 'user',
            content: JSON.stringify(this.buildPromptContext(input, heuristic)),
          },
        ],
      });

      if (result.fallback) {
        // No real provider configured (NoopAiProvider) — go straight to the
        // deterministic heuristic rather than parsing a stub echo string.
        return heuristic;
      }

      const parsed = this.parseAndValidate(result.content);
      if (!parsed) {
        return {
          ...heuristic,
          error: 'AI response was not in the expected format — used a manual-pricing fallback estimate.',
        };
      }
      return { ...parsed, source: 'ai' };
    } catch (err) {
      this.logger.warn(
        `AI cost estimate failed for ${input.requestType}/${input.targetKey}: ${(err as Error).message}`,
      );
      return {
        ...heuristic,
        error: 'The AI estimate provider failed — used a manual-pricing fallback estimate.',
      };
    }
  }

  /** Only numeric/structural fields — never tenant identity or raw content. */
  private buildPromptContext(input: AiEstimateInput, heuristic: AiEstimateResult) {
    return {
      requestType: input.requestType,
      targetKey: input.targetKey,
      requestedQuantity: input.requestedQuantity,
      currentUsage: input.currentUsage,
      currentLimit: input.currentLimit,
      billingPeriod: input.billingPeriod,
      historicalAverageUsagePerPeriod: input.historicalAverageUsage,
      currency: input.currency,
      providerPricingConfig: {
        unitProviderCostMinor: this.config.unitProviderCostMinor(input.targetKey),
        unitInfraCostMinor: this.config.unitInfraCostMinor(input.targetKey),
      },
      // Given as a floor/reference point — the model may reason above or below it.
      heuristicReference: {
        estimatedProviderCostMinor: heuristic.estimatedProviderCostMinor,
        estimatedInfraCostMinor: heuristic.estimatedInfraCostMinor,
        recommendedPriceMinor: heuristic.recommendedPriceMinor,
      },
    };
  }

  private parseAndValidate(content: string): AiEstimateResult | null {
    let json: unknown;
    try {
      // Models occasionally wrap JSON in a code fence despite instructions —
      // strip one if present before parsing.
      const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      json = JSON.parse(cleaned);
    } catch {
      return null;
    }
    if (typeof json !== 'object' || json === null) return null;
    const o = json as Record<string, unknown>;

    const providerCost = this.toFiniteNonNegativeInt(o.estimatedProviderCostMinor);
    const infraCost = this.toFiniteNonNegativeInt(o.estimatedInfraCostMinor);
    const recommendedPrice = this.toFiniteNonNegativeInt(o.recommendedPriceMinor);
    const confidence = typeof o.confidenceScore === 'number' ? o.confidenceScore : null;
    if (providerCost === null || infraCost === null || recommendedPrice === null || confidence === null) {
      return null;
    }

    const assumptions = Array.isArray(o.assumptions)
      ? o.assumptions.filter((a): a is string => typeof a === 'string').slice(0, 20)
      : [];
    const pricingBreakdown =
      typeof o.pricingBreakdown === 'object' && o.pricingBreakdown !== null
        ? Object.fromEntries(
            Object.entries(o.pricingBreakdown as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
              .slice(0, 20),
          )
        : {};

    return {
      estimatedProviderCostMinor: providerCost,
      estimatedInfraCostMinor: infraCost,
      recommendedPriceMinor: recommendedPrice,
      confidenceScore: Math.min(1, Math.max(0, confidence)),
      assumptions,
      pricingBreakdown: pricingBreakdown as Record<string, number>,
      source: 'ai',
    };
  }

  private toFiniteNonNegativeInt(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    return Math.round(v);
  }

  /** Deterministic, always-available estimate — the floor when the AI is unavailable or unconfigured. */
  private heuristicEstimate(input: AiEstimateInput): AiEstimateResult {
    const qty = input.requestedQuantity ?? 1;
    const providerCost = Math.round(qty * this.config.unitProviderCostMinor(input.targetKey));
    const infraCost = Math.round(qty * this.config.unitInfraCostMinor(input.targetKey));
    const recommendedPrice = Math.round(
      (providerCost + infraCost) * this.config.fallbackMarginMultiplier,
    );
    return {
      estimatedProviderCostMinor: providerCost,
      estimatedInfraCostMinor: infraCost,
      recommendedPriceMinor: recommendedPrice,
      confidenceScore: 0,
      assumptions: [
        'No AI-derived estimate available — computed from configured per-unit provider/infra cost assumptions.',
        `Requested quantity: ${qty}.`,
      ],
      pricingBreakdown: {
        unitProviderCostMinor: this.config.unitProviderCostMinor(input.targetKey),
        unitInfraCostMinor: this.config.unitInfraCostMinor(input.targetKey),
        quantity: qty,
      },
      source: 'heuristic_fallback',
    };
  }
}
