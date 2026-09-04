import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { AppError, ErrorCode } from '../../../common/errors';
import {
  AI_COMPLIANCE_ROUTE_UNAVAILABLE,
  AI_MODEL_NOT_PERMITTED,
  AiExecutionMode,
} from '../execution/ai-execution.constants';
import {
  AI_MODEL_REGISTRY_GA,
  AiModelDefinition,
  allowedModelId,
  defaultModelForTier,
  findModel,
  modelsForTier,
} from './ai-model-registry';

/** The processing constraints a chosen model must ALSO be able to satisfy. */
export interface ModelProcessingConstraints {
  executionMode: AiExecutionMode;
  residencyRequired: boolean;
  region: string | null;
}

export interface ModelRouteInput {
  tenantId: string;
  conversationId: string;
  legacyModel?: string;
  feature: string;
  route: string;
  complexity?: 'STANDARD' | 'HIGH';
  /**
   * The PLATFORM default — `ai.default_model`, read by the caller through
   * `SystemSettingService`'s 30 s cache (see
   * `AiExecutionService.resolveDefaultModel()`), so no AI message adds a query.
   *
   * Passed IN rather than read here so `resolve()` stays synchronous and pure;
   * this is the same shape `temperature` already travels in. It is what makes
   * `/platform/system-settings` the CENTRAL model configuration rather than a
   * seed applied once at agent-creation time: with routing off (the shipped
   * state) it is the model every agent without a pinned one now runs on.
   *
   * An unallowed value here is ignored like any other — the setting is
   * enum-validated on write, so that can only be a row predating the policy.
   */
  platformDefaultModel?: string;
  /**
   * Resolved INDEPENDENTLY of this router (see AiProcessingPolicyService) and
   * passed in so the model decision can be validated against it. Omitted ⇒ no
   * capability constraint is applied.
   */
  processing?: ModelProcessingConstraints;
}

export interface ModelRouteDecision {
  /**
   * ALWAYS an allowed, canonical model id — never `undefined`, and never a
   * string outside `AI_MODEL_REGISTRY`, on ANY branch including the flag-off
   * one. `assertAllowed()` at the bottom of this class is what makes that
   * unfalsifiable rather than merely intended.
   */
  model: string;
  routed: boolean;
  reason: string;
  /**
   * The chosen model's capabilities. Present only when routing is ACTIVE — the
   * flag-off path returns the legacy shape unchanged so disabling the flag is a
   * true no-op. Callers that want capabilities on the legacy path resolve them
   * from the registry themselves via `findModel(decision.model)`.
   */
  definition?: AiModelDefinition;
}

/**
 * Feature/route based model routing. It never inspects patient prompt content,
 * and it never decides HOW a request is processed — execution mode and data
 * residency are resolved separately by `AiProcessingPolicyService`, then handed
 * here as constraints. Keeping the two decisions apart is what lets the model
 * change without touching a workload's processing policy, and vice versa.
 *
 * Rollback contract: with `AI_MODEL_ROUTING_ENABLED=false` (or a tenant outside
 * the rollout percentage) this returns the stored model unchanged — same three
 * fields, same values, no capability check, no throw. Disabling the flag is
 * still a complete revert with no deploy.
 *
 * MODEL POLICY OUTRANKS THE ROLLBACK CONTRACT. The one thing the flag-off path
 * no longer does is hand back a model that is not in `AI_MODEL_REGISTRY`. That
 * used to be the widest hole in the platform's model policy and it was open in
 * exactly the shipped configuration: with routing off, a `gpt-4o` string sitting
 * on an agent row went straight to the provider, so restricting the registry
 * alone would have changed nothing for any existing clinic. Every value that is
 * still legal comes back byte-identical; an illegal one is replaced by the
 * platform default instead of being forwarded. A feature flag is a rollout
 * control, not an authorization bypass.
 */
@Injectable()
export class AiModelRouterService {
  private readonly logger = new Logger(AiModelRouterService.name);
  /** One warning per unrecognized stored model, not one per turn. */
  private readonly warnedModels = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  /**
   * The public entry point. Delegates to `route()` and then re-checks the
   * answer against the registry.
   *
   * The re-check is deliberate belt-and-braces: `route()` has several branches
   * and a future one could forget the policy, so the invariant is asserted at
   * the single exit rather than trusted at each return. It throws instead of
   * silently correcting, because reaching it means the routing code itself is
   * wrong and a quiet substitution would hide that.
   */
  resolve(input: ModelRouteInput): ModelRouteDecision {
    const decision = this.route(input);
    const allowed = allowedModelId(decision.model);
    if (!allowed) {
      this.logger.error(
        `Model router produced "${decision.model}" (reason=${decision.reason}), ` +
          `which is not a permitted platform model. Refusing the turn.`,
      );
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, {
        message:
          'The AI model configured for this request is not permitted by platform policy. ' +
          'The request was refused rather than sent to the provider.',
        publicContext: { reason: AI_MODEL_NOT_PERMITTED },
        internalContext: {
          tenantId: input.tenantId,
          producedModel: decision.model,
          reason: decision.reason,
        },
      });
    }
    return { ...decision, model: allowed };
  }

  private route(input: ModelRouteInput): ModelRouteDecision {
    if (!this.enabled() || !this.inRollout(input)) {
      const stored = allowedModelId(input.legacyModel);
      if (stored) {
        // The pre-existing contract, byte for byte, for every legal value.
        return { model: stored, routed: false, reason: 'legacy_flag' };
      }
      // No stored model, or one the platform no longer permits. Either way the
      // turn runs on the platform default rather than on whatever string the
      // row happened to hold.
      const fallback = this.policyDefault('ECONOMY', input);
      if (input.legacyModel) this.warnDisallowed(input, fallback);
      return {
        model: fallback,
        routed: fallback !== input.legacyModel,
        reason: input.legacyModel
          ? 'legacy_flag_policy_default'
          : 'legacy_flag',
      };
    }

    const powerful =
      input.complexity === 'HIGH' ||
      this.csv('AI_POWERFUL_FEATURES').has(input.feature) ||
      this.csv('AI_POWERFUL_ROUTES').has(input.route);
    const tier: AiModelDefinition['tier'] = powerful ? 'POWERFUL' : 'ECONOMY';
    const configured = this.config.get<string>(
      powerful ? 'AI_POWERFUL_MODEL' : 'AI_ECONOMY_MODEL',
    );

    const baseReason = powerful ? 'powerful_route' : 'economy_route';
    // Order: the operator's tier variable, then the model stored on the agent
    // row, then the platform setting, then the tier's own registry default.
    // `findModel` on each step is what makes every one of them allow-listed —
    // the previous `_unregistered` branch forwarded `configured || legacyModel`
    // verbatim, which is precisely how an unallowed env value reached the
    // provider. There is no longer a branch that can return an unregistered id.
    const preferred =
      findModel(configured) ??
      this.legacyDefinition(input) ??
      findModel(input.platformDefaultModel) ??
      findModel(this.policyDefault(tier, input))!;

    const chosen = this.satisfyingProcessing(preferred, tier, input);
    return {
      model: chosen.definition.id,
      routed: chosen.definition.id !== input.legacyModel,
      reason: chosen.substituted
        ? `${baseReason}_capability_substituted`
        : baseReason,
      definition: chosen.definition,
    };
  }

  /**
   * The allowed model to land on when nothing configured resolves: the platform
   * setting if it is (still) allowed, else the tier's registry default.
   *
   * Guaranteed to return an allowed id, so it is the floor under every branch
   * of `resolve()`.
   */
  private policyDefault(
    tier: AiModelDefinition['tier'],
    input: ModelRouteInput,
  ): string {
    return (
      allowedModelId(input.platformDefaultModel) ?? defaultModelForTier(tier)
    );
  }

  /** One warning per distinct disallowed value, not one per turn. */
  private warnDisallowed(input: ModelRouteInput, replacement: string): void {
    const stored = input.legacyModel!;
    if (this.warnedModels.has(stored)) return;
    this.warnedModels.add(stored);
    this.logger.warn(
      `Model "${stored}" stored on an agent row is not permitted by platform ` +
        `policy (tenant ${input.tenantId}); running "${replacement}" instead. ` +
        `Migration AiModelPolicyLunaTerra rewrites these rows — a value still ` +
        `appearing here was written after it ran.`,
    );
  }

  /**
   * The model stored on the agent row, resolved through the registry.
   *
   * A value outside `AI_MODEL_REGISTRY` is always IGNORED here — it is a string
   * a clinic admin could once type freely, and passing it to the provider
   * produced either a hard error or an UNPRICED cost row. Logged once per
   * distinct value so the gap is visible without flooding the log on a hot
   * conversation.
   *
   * `AI_MODEL_ROUTING_STRICT=false` used to make this pass the stored string
   * through unchanged. It no longer can: an operator variable must not be able
   * to re-open the platform's model policy. What the flag still controls is
   * whether the substitution is announced in the log.
   */
  private legacyDefinition(input: ModelRouteInput): AiModelDefinition | undefined {
    if (!input.legacyModel) return undefined;
    const found = findModel(input.legacyModel);
    if (found) return found;
    if (this.strict() && !this.warnedModels.has(input.legacyModel)) {
      this.warnedModels.add(input.legacyModel);
      this.logger.warn(
        `Ignoring unregistered model "${input.legacyModel}" stored on an agent ` +
          `(tenant ${input.tenantId}); falling back to the configured tier model.`,
      );
    }
    return undefined;
  }

  /**
   * Model capabilities ∩ processing requirements.
   *
   * A model that cannot satisfy the required processing mode is REPLACED, never
   * accommodated by weakening the processing decision: downgrading residency to
   * "global" so a cheaper model fits is precisely the silent fallback that
   * residency exists to prevent. Substitution order prefers the requested tier
   * (closest quality match), then the wider registry, and only then refuses.
   */
  private satisfyingProcessing(
    preferred: AiModelDefinition,
    tier: AiModelDefinition['tier'],
    input: ModelRouteInput,
  ): { definition: AiModelDefinition; substituted: boolean } {
    const constraints = input.processing;
    if (!constraints || this.supportsProcessing(preferred, constraints)) {
      return { definition: preferred, substituted: false };
    }

    // GA pool only — an automatic substitution must not be the thing that first
    // puts an unproven PREVIEW model in front of live traffic.
    const candidate =
      modelsForTier(tier).find((m) => this.supportsProcessing(m, constraints)) ??
      AI_MODEL_REGISTRY_GA.find((m) => this.supportsProcessing(m, constraints));

    if (!candidate) {
      this.logger.error(
        `No registered model satisfies processing constraints ` +
          `(mode=${constraints.executionMode}, residency=${constraints.residencyRequired}, ` +
          `region=${constraints.region ?? 'none'}) for tenant ${input.tenantId}`,
      );
      throw new AppError(ErrorCode.FORBIDDEN, {
        message:
          'AI data residency is required for this request but no available model supports it. ' +
          'The request was refused rather than processed in the global region.',
        publicContext: { reason: AI_COMPLIANCE_ROUTE_UNAVAILABLE },
        internalContext: {
          tenantId: input.tenantId,
          requestedModel: preferred.id,
          executionMode: constraints.executionMode,
          residencyRequired: constraints.residencyRequired,
          region: constraints.region,
        },
      });
    }

    this.logger.warn(
      `Model "${preferred.id}" cannot satisfy the required processing mode ` +
        `(mode=${constraints.executionMode}, region=${constraints.region ?? 'none'}); ` +
        `substituting "${candidate.id}".`,
    );
    return { definition: candidate, substituted: true };
  }

  private supportsProcessing(
    model: AiModelDefinition,
    constraints: ModelProcessingConstraints,
  ): boolean {
    if (!model.supportedExecutionModes.includes(constraints.executionMode)) {
      return false;
    }
    if (!constraints.residencyRequired) return true;
    // A required region with no region name is unsatisfiable by construction —
    // refuse rather than guess which region was meant.
    if (!constraints.region) return false;
    return (
      model.supportedResidencyRegions?.includes(constraints.region) ?? false
    );
  }

  private enabled(): boolean {
    return String(this.config.get('AI_MODEL_ROUTING_ENABLED', 'false')) === 'true';
  }

  private strict(): boolean {
    return String(this.config.get('AI_MODEL_ROUTING_STRICT', 'true')) === 'true';
  }

  private inRollout(input: ModelRouteInput): boolean {
    const pct = Math.max(0, Math.min(100, Number(this.config.get('AI_MODEL_ROUTING_ROLLOUT_PERCENT', 0))));
    if (pct >= 100) return true;
    if (pct <= 0) return false;
    const bucket = parseInt(createHash('sha256').update(`${input.tenantId}:${input.conversationId}`).digest('hex').slice(0, 8), 16) % 100;
    return bucket < pct;
  }

  private csv(key: string): Set<string> {
    return new Set(String(this.config.get(key, '')).split(',').map((v) => v.trim()).filter(Boolean));
  }
}
