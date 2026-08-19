import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { AppError, ErrorCode } from '../../../common/errors';
import {
  AI_COMPLIANCE_ROUTE_UNAVAILABLE,
  AiExecutionMode,
} from '../execution/ai-execution.constants';
import {
  AI_MODEL_REGISTRY,
  AiModelDefinition,
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
   * Resolved INDEPENDENTLY of this router (see AiProcessingPolicyService) and
   * passed in so the model decision can be validated against it. Omitted ⇒ no
   * capability constraint is applied.
   */
  processing?: ModelProcessingConstraints;
}

export interface ModelRouteDecision {
  model: string | undefined;
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
 * the rollout percentage) this returns exactly what it returned before any of
 * the registry work existed — same three fields, same values, no registry
 * lookup, no capability check, no throw. Disabling the flag is a complete
 * revert with no deploy.
 */
@Injectable()
export class AiModelRouterService {
  private readonly logger = new Logger(AiModelRouterService.name);
  /** One warning per unrecognized stored model, not one per turn. */
  private readonly warnedModels = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  resolve(input: ModelRouteInput): ModelRouteDecision {
    if (!this.enabled() || !this.inRollout(input)) {
      return { model: input.legacyModel, routed: false, reason: 'legacy_flag' };
    }

    const powerful =
      input.complexity === 'HIGH' ||
      this.csv('AI_POWERFUL_FEATURES').has(input.feature) ||
      this.csv('AI_POWERFUL_ROUTES').has(input.route);
    const tier: AiModelDefinition['tier'] = powerful ? 'POWERFUL' : 'ECONOMY';
    const configured = this.config.get<string>(
      powerful ? 'AI_POWERFUL_MODEL' : 'AI_ECONOMY_MODEL',
    );

    const preferred =
      findModel(configured) ?? this.legacyDefinition(input) ?? undefined;
    const baseReason = powerful ? 'powerful_route' : 'economy_route';

    if (!preferred) {
      // Nothing resolvable: neither the configured tier model nor the stored
      // one is registered. Preserve the pre-registry fallback (hand back the
      // legacy value and let the provider apply its own default) rather than
      // failing a turn over a configuration gap.
      return {
        model: configured || input.legacyModel,
        routed: (configured || input.legacyModel) !== input.legacyModel,
        reason: `${baseReason}_unregistered`,
      };
    }

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
   * The model stored on the agent row, resolved through the registry.
   *
   * Under `AI_MODEL_ROUTING_STRICT` (default) an unregistered value is IGNORED
   * — it is a string a clinic admin could once type freely, and passing it to
   * the provider produced either a hard error or an UNPRICED cost row. Logged
   * once per distinct value so the gap is visible without flooding the log on a
   * hot conversation.
   */
  private legacyDefinition(input: ModelRouteInput): AiModelDefinition | undefined {
    if (!input.legacyModel) return undefined;
    const found = findModel(input.legacyModel);
    if (found) return found;
    if (!this.strict()) return undefined;
    if (!this.warnedModels.has(input.legacyModel)) {
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

    const candidate =
      modelsForTier(tier).find((m) => this.supportsProcessing(m, constraints)) ??
      AI_MODEL_REGISTRY.find((m) => this.supportsProcessing(m, constraints));

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
