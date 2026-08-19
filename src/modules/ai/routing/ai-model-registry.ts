import { AI_EXECUTION_MODE, AiExecutionMode } from '../execution/ai-execution.constants';

/**
 * Capability registry — the single source of truth for what a model can DO.
 *
 * Before this existed, four subsystems each guessed model facts independently:
 *  - `OpenAiChatProvider.supports()` assumed any `gpt-*` id works and that every
 *    model accepts a custom `temperature` (false for the GPT-5.x family, which
 *    rejects any non-default value and would 400 on every request).
 *  - `AiPromptBudgetService` assumed ONE global context window
 *    (`AI_MODEL_CONTEXT_WINDOW_TOKENS`, 16384) for every model.
 *  - `AiPriceCatalogService` holds rates but no capabilities.
 *  - `CreateAiAgentDto.model` accepted any string up to 100 chars.
 *
 * Registering a model here is what makes it selectable: `AI_MODEL_IDS` is the
 * allow-list enforced by Joi (env), the platform-setting enum, and the agent DTO,
 * so an unknown id can no longer reach the provider from any direction.
 *
 * `supportedExecutionModes` / `supportedResidencyRegions` exist so the PROCESSING
 * decision (see AiProcessingPolicyService) can be validated against the MODEL
 * decision before a request is dispatched — never selecting a model first and
 * discovering afterwards that it cannot satisfy the required processing mode.
 * These two dimensions stay orthogonal: a model may support BATCH, residency,
 * both, or neither.
 */
export interface AiModelDefinition {
  /** Canonical id sent to the provider. */
  id: string;
  provider: 'openai';
  /** Routing tier consumed by AiModelRouterService. */
  tier: 'ECONOMY' | 'STANDARD' | 'POWERFUL';
  /**
   * Dated snapshots the API may echo back in `res.model`. Kept in sync with the
   * price catalog's own `aliases` so a turn is never priced UNPRICED merely
   * because OpenAI resolved an alias.
   */
  aliases: readonly string[];

  contextWindowTokens: number;
  maxOutputTokens: number;

  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutputs: boolean;
  /**
   * False for reasoning-family models that accept ONLY the default temperature.
   * `OpenAiChatProvider` must omit the field entirely for these (Phase 7).
   */
  supportsTemperature: boolean;

  /** Reuses the EXISTING AI_EXECUTION_MODE union — deliberately not a parallel enum. */
  supportedExecutionModes: readonly AiExecutionMode[];
  /**
   * Regions this model may be processed in when Data Residency is enforced.
   * `undefined` ⇒ NOT residency-eligible; a residency-required request must
   * select a different model or fail closed. Never silently downgraded.
   */
  supportedResidencyRegions?: readonly string[];

  /** Sent as `reasoning_effort` when the model is a reasoning model (Phase 7). */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /**
   * Providers that bill CACHE WRITES above the uncached input rate (GPT-5.6 =
   * 1.25x). Absent ⇒ cache writes are not separately billed for this model.
   */
  cacheWriteMultiplier?: number;
}

const BOTH_MODES: readonly AiExecutionMode[] = [
  AI_EXECUTION_MODE.STANDARD,
  AI_EXECUTION_MODE.BATCH,
];

/**
 * Regional-processing regions, per OpenAI's published data-residency model list.
 * Descriptive labels only — registering a region here asserts that the MODEL is
 * eligible for regional processing, never that any legal guarantee applies (see
 * TenantAiDeployment's own docblock).
 */
const US_EU: readonly string[] = ['us', 'eu'];

/**
 * Stage 1 model set: non-reasoning, `temperature`-accepting, Chat Completions
 * models that are drop-in for the current provider request shape. The GPT-5.x
 * family is deliberately absent until the provider learns to omit `temperature`
 * and send `reasoning_effort` (plan Phase 7).
 */
export const AI_MODEL_REGISTRY: readonly AiModelDefinition[] = [
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    tier: 'ECONOMY',
    aliases: ['gpt-4.1-mini-2025-04-14'],
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: true,
    supportedExecutionModes: BOTH_MODES,
    supportedResidencyRegions: US_EU,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    tier: 'ECONOMY',
    aliases: ['gpt-4o-mini-2024-07-18'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: true,
    supportedExecutionModes: BOTH_MODES,
    // Not on the published regional-processing model list — deliberately omitted
    // so a residency-required turn can never select it.
  },
  {
    id: 'gpt-4.1',
    provider: 'openai',
    tier: 'STANDARD',
    aliases: ['gpt-4.1-2025-04-14'],
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: true,
    supportedExecutionModes: BOTH_MODES,
    supportedResidencyRegions: US_EU,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    tier: 'POWERFUL',
    aliases: ['gpt-4o-latest', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: true,
    supportedExecutionModes: BOTH_MODES,
    supportedResidencyRegions: US_EU,
  },
];

/** Canonical ids only — the allow-list enforced by env/DTO/platform-setting validation. */
export const AI_MODEL_IDS: readonly string[] = AI_MODEL_REGISTRY.map((m) => m.id);

/** Lower-cased id/alias → definition. Built once; the registry is a module constant. */
const BY_KEY = new Map<string, AiModelDefinition>(
  AI_MODEL_REGISTRY.flatMap((m) =>
    [m.id, ...m.aliases].map((key) => [key.trim().toLowerCase(), m] as const),
  ),
);

/**
 * Resolve a model id OR a dated snapshot alias to its definition, matching
 * `AiPriceCatalogService.find()`'s case/whitespace-insensitive behaviour so a
 * value that prices correctly also resolves its capabilities correctly.
 */
export function findModel(id?: string | null): AiModelDefinition | undefined {
  if (!id) return undefined;
  return BY_KEY.get(id.trim().toLowerCase());
}

/** True when `id` is a registered canonical id or alias. */
export function isKnownModel(id?: string | null): boolean {
  return findModel(id) !== undefined;
}

/** The registered models of a tier, cheapest-first is the registry's own order. */
export function modelsForTier(tier: AiModelDefinition['tier']): AiModelDefinition[] {
  return AI_MODEL_REGISTRY.filter((m) => m.tier === tier);
}
