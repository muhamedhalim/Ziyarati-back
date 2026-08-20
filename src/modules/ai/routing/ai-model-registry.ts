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
  /**
   * Human-readable label for the tenant-facing model picker.
   *
   * Lives here rather than in the dashboard's dictionaries because the id and
   * its label must not be able to drift: a select whose labels are maintained
   * client-side eventually offers "GPT-4.1 Mini" for an id the server no longer
   * registers. It is a proper noun (a vendor product name), so it is NOT
   * translated — the Arabic dashboard shows the same string, which is also what
   * every OpenAI-facing document a clinic might compare against shows.
   */
  displayName: string;
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

  /**
   * `GA`      — proven against THIS codebase's exact request shape by the live
   *             compatibility spec. Selectable from every surface.
   * `PREVIEW` — registered, priced and capability-described, but its live
   *             compatibility has not been demonstrated here yet.
   *
   * A PREVIEW model is deliberately kept out of `AI_MODEL_IDS`, so it never
   * appears in the clinic model picker, never passes the agent DTO, and is never
   * chosen as an automatic capability substitute. It can only be selected by an
   * operator naming it in `AI_ECONOMY_MODEL`/`AI_POWERFUL_MODEL` — a deliberate,
   * single-variable, instantly reversible act.
   *
   * Every entry below is GA. The GPT-5.6 family was promoted once it had passed
   * both live gates (compatibility 38/38 and the AR/EN benchmark; see
   * docs/AI_MODEL_LIVE_VERIFICATION.md) AND the provider had learned to read
   * `supportsTemperature` / `reasoningEffort` from this table — promotion before
   * that second condition would have made every request 400.
   *
   * The stage stays in the type with no current members on purpose: it is the
   * gate the NEXT model goes through. Adding an entry as PREVIEW keeps it
   * priced, capability-described and operator-selectable by env while it is
   * being proven, without it appearing in any clinic's dropdown.
   *
   * Being GA makes a model SELECTABLE. It does not make it a routing target —
   * that is `AI_ECONOMY_MODEL` / `AI_POWERFUL_MODEL`, and it is not implied by
   * anything here.
   */
  releaseStage: 'GA' | 'PREVIEW';

  /** Sent as `reasoning_effort` when the model is a reasoning model. */
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
/** The GPT-5.6 family's regional-processing list also covers the UAE. */
const US_EU_AE: readonly string[] = ['us', 'eu', 'ae'];

/**
 * Stage 1 model set: non-reasoning, `temperature`-accepting, Chat Completions
 * models that are drop-in for the current provider request shape. The GPT-5.x
 * family is deliberately absent until the provider learns to omit `temperature`
 * and send `reasoning_effort` (plan Phase 7).
 */
export const AI_MODEL_REGISTRY: readonly AiModelDefinition[] = [
  {
    id: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 Mini',
    provider: 'openai',
    releaseStage: 'GA',
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
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    releaseStage: 'GA',
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
    displayName: 'GPT-4.1',
    provider: 'openai',
    releaseStage: 'GA',
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
    displayName: 'GPT-4o',
    provider: 'openai',
    releaseStage: 'GA',
    tier: 'POWERFUL',
    // Verified against GET /v1/models on 2026-08-19. 'gpt-4o-latest' was listed
    // here and does NOT exist; a snapshot the API can never return is a claim of
    // coverage this table does not actually have. 'gpt-4o-2024-05-13' is real but
    // deliberately EXCLUDED — it is priced at $5/$10 per M, double the current
    // snapshots, so aliasing it here would mis-price it. Absent, it is UNPRICED,
    // which is the honest outcome.
    aliases: ['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: true,
    supportedExecutionModes: BOTH_MODES,
    supportedResidencyRegions: US_EU,
  },

  // ── GPT-5.6 family ─────────────────────────────────────────────────────────
  // Reasoning models. Three facts make them different in kind from everything
  // above, and all are encoded here rather than discovered at runtime:
  //
  //  1. `supportsTemperature: false` — the family rejects ANY non-default
  //     temperature. `OpenAiChatProvider` always sent `temperature: 0.2`, so
  //     before the provider learned to read this flag, routing here would have
  //     400'd on every single request. Note the agent row still carries a
  //     `temperature` column; selecting one of these models makes that stored
  //     value inert rather than fatal, because the provider drops it here.
  //  2. `cacheWriteMultiplier: 1.25` — cache writes bill above the uncached
  //     input rate, and reasoning tokens bill as output. Both are priced in the
  //     catalog; a turn here is not cheaper than its `completion_tokens` say.
  //
  // `reasoningEffort: 'none'` is NOT a tuning choice — it is mandatory, and it
  // was established by running the live compat suite (2026-08-19), not assumed:
  //
  //     reasoning_effort: 'low'  + tools -> 400 "Function tools with
  //         reasoning_effort are not supported ... in /v1/chat/completions"
  //     reasoning_effort OMITTED + tools -> 400, the SAME error (the model
  //         applies a default effort, so omitting the field does not opt out)
  //     reasoning_effort: 'none' + tools -> tool call returned, reasoning_tokens 0
  //
  // Virtually every turn in this product carries tools, so any other value makes
  // the model unusable here. The upside is that it also removes the reasoning-
  // token cost risk entirely: effort 'none' bills zero reasoning tokens.
  //
  // The plan's fallback — a Responses-API adapter registered as a second entry
  // in the existing AI_COMPLETION_PROVIDERS multi-token — is therefore NOT
  // needed for tool calling. It would only be needed to use a non-zero
  // reasoning effort, which is a separate, future decision.
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    provider: 'openai',
    releaseStage: 'GA',
    tier: 'ECONOMY',
    aliases: [], // verified 2026-08-19: no dated snapshot is published
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: false,
    supportedExecutionModes: BOTH_MODES,
    supportedResidencyRegions: US_EU_AE,
    reasoningEffort: 'none',
    cacheWriteMultiplier: 1.25,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    provider: 'openai',
    releaseStage: 'GA',
    tier: 'POWERFUL',
    aliases: [], // verified 2026-08-19: no dated snapshot is published
    contextWindowTokens: 1_047_576,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsTemperature: false,
    supportedExecutionModes: BOTH_MODES,
    supportedResidencyRegions: US_EU_AE,
    reasoningEffort: 'none',
    cacheWriteMultiplier: 1.25,
  },
];

/** Every registered id, PREVIEW included — the env-variable allow-list. */
export const AI_MODEL_IDS_ALL: readonly string[] = AI_MODEL_REGISTRY.map((m) => m.id);

/**
 * GA ids only — the TENANT-facing allow-list: the agent DTO, the platform
 * `ai.default_model` setting, and the model picker the dashboard renders.
 *
 * An operator can still route to a PREVIEW model through `AI_ECONOMY_MODEL` /
 * `AI_POWERFUL_MODEL` (validated against `AI_MODEL_IDS_ALL`). A clinic admin
 * cannot pin an agent to one, because a model whose live compatibility has not
 * been demonstrated must not become a tenant's persisted default.
 */
export const AI_MODEL_IDS: readonly string[] = AI_MODEL_REGISTRY.filter(
  (m) => m.releaseStage === 'GA',
).map((m) => m.id);

/** One option in the tenant-facing model picker. */
export interface AiSelectableModel {
  id: string;
  displayName: string;
}

/**
 * The model picker's payload: the SAME GA set as `AI_MODEL_IDS`, carrying the
 * label to render beside each id.
 *
 * Deliberately only `id` + `displayName`. Everything else in a definition —
 * reasoning effort, cache-write multiplier, residency regions, execution modes,
 * context window — is either an internal implementation detail or a cost
 * mechanic, and a clinic choosing an assistant model has no decision to make
 * with it. Widening this shape is how a capability table becomes a public API.
 */
export const AI_SELECTABLE_MODELS: readonly AiSelectableModel[] =
  AI_MODEL_REGISTRY.filter((m) => m.releaseStage === 'GA').map((m) => ({
    id: m.id,
    displayName: m.displayName,
  }));

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

/**
 * GA models only — the pool the router is allowed to pick from AUTOMATICALLY.
 *
 * Automatic selection (tier defaults, capability substitution) must never land
 * on a PREVIEW model: substitution happens precisely when something has already
 * gone sideways, and answering that by silently promoting an unproven model is
 * the opposite of the fail-closed behaviour residency exists to guarantee.
 */
export const AI_MODEL_REGISTRY_GA: readonly AiModelDefinition[] =
  AI_MODEL_REGISTRY.filter((m) => m.releaseStage === 'GA');

/** The GA models of a tier, cheapest-first is the registry's own order. */
export function modelsForTier(tier: AiModelDefinition['tier']): AiModelDefinition[] {
  return AI_MODEL_REGISTRY_GA.filter((m) => m.tier === tier);
}
