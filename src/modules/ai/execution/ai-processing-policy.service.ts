import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../../../common/errors';
import { AccessControlService } from '../../subscription-billing/access-control.service';
import { FeatureKey } from '../../subscription-billing/feature-registry';

import { AiDataResidencyService } from './ai-data-residency.service';
import { AiExecutionPolicyService } from './ai-execution-policy.service';
import {
  AI_COMPLIANCE_ROUTE_UNAVAILABLE,
  AI_EXECUTION_MODE,
  AiExecutionMode,
  AiFeature,
} from './ai-execution.constants';

/**
 * How the caller's workload relates to a waiting human. Set by the CALL SITE
 * from what the code is doing, never from a request body — a client must not be
 * able to declare its own turn "deferrable" and land it on the batch route.
 */
export type AiLatencyRequirement = 'IMMEDIATE' | 'DEFERRABLE';

/**
 * Whether the workload carries data the tenant treats as sensitive (patient
 * conversation content, clinical notes, identifiers). Advisory: it is RECORDED
 * and may be consulted by platform policy, but on its own it never forces
 * regional processing — see the class docblock.
 */
export type AiDataSensitivity = 'STANDARD' | 'SENSITIVE';

/**
 * The resolved processing decision for one AI request.
 *
 * TWO ORTHOGONAL DIMENSIONS, deliberately not one mutually-exclusive enum: a
 * request may be STANDARD or BATCH, and independently may or may not require
 * regional processing. A single three-value enum could not express
 * `BATCH + DATA_RESIDENCY`, which OpenAI supports (the Batch endpoint is
 * available in the regional-processing regions).
 */
export interface ProcessingDescriptor {
  executionMode: AiExecutionMode;
  residencyRequired: boolean;
  /** Null whenever `residencyRequired` is false — non-residency requests have no region. */
  region: string | null;
  /** Composed telemetry label: STANDARD | BATCH | STANDARD+RESIDENCY | BATCH+RESIDENCY. */
  label: string;
  /** Why this combination was chosen. Configuration facts only — never prompt content. */
  reason: string;
}

/**
 * The descriptor a turn carries before the policy has been consulted, and the
 * one a failure path reports when it never got that far. Deliberately the
 * safe combination — synchronous, global region — so a partially-initialized
 * turn can never be RECORDED as having been processed regionally.
 */
export const DEFAULT_PROCESSING_DESCRIPTOR: ProcessingDescriptor = {
  executionMode: AI_EXECUTION_MODE.STANDARD,
  residencyRequired: false,
  region: null,
  label: AI_EXECUTION_MODE.STANDARD,
  reason: 'unresolved',
};

export interface ProcessingPolicyInput {
  tenantId: string;
  feature: AiFeature;
  route: string;
  latencyRequirement: AiLatencyRequirement;
  dataSensitivity?: AiDataSensitivity;
}

/**
 * Composes the two EXISTING processing resolvers into one decision per request.
 *
 * This is a coordinator, not a policy engine. It deliberately owns none of the
 * rules it applies:
 *  - feature → execution mode lives in `FEATURE_EXECUTION_MODE`, resolved by
 *    {@link AiExecutionPolicyService};
 *  - whether a tenant requires a regional deployment (and with what connection
 *    options) lives in {@link AiDataResidencyService};
 *  - region/base-URL validation lives in `deployment-validation.ts`;
 *  - entitlement lives in {@link AccessControlService}.
 *
 * It exists because nothing composed them: `AiExecutionService` called neither,
 * so an interactive turn's processing mode was implicit ("whatever the provider
 * did") and residency was applied invisibly deep inside
 * `OpenAiChatProvider.resolveClient()` — the orchestration layer never learned
 * it had happened, which is why no chat cost row ever recorded a region.
 *
 * Two invariants this adds on top of the existing resolvers:
 *
 *  1. **`IMMEDIATE` always wins.** A turn a human is waiting on resolves to
 *     STANDARD regardless of what the feature map says. `FEATURE_EXECUTION_MODE`
 *     already maps every chat feature to STANDARD; this is the second,
 *     independent guard so a future edit to that map cannot silently park a
 *     live conversation behind a 24-hour batch window.
 *  2. **Residency is never downgraded to save a request.** If a tenant requires
 *     regional processing but is not entitled to it, the request is REFUSED. The
 *     one thing that must never happen is quietly processing that tenant's data
 *     in the global region because a billing flag was missing.
 *
 * On data sensitivity: this product serves clinics, so nearly every turn carries
 * health-adjacent data. That is deliberately NOT treated as an automatic
 * residency trigger — doing so would make residency unavoidable and meaningless.
 * A residency requirement comes from an explicit tenant deployment (which the
 * tenant or an operator enabled) or from platform policy
 * (`AI_RESIDENCY_REQUIRED_FEATURES`). `dataSensitivity` is recorded in the
 * reason so an operator can see what the classification was.
 */
@Injectable()
export class AiProcessingPolicyService {
  private readonly logger = new Logger(AiProcessingPolicyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly execution: AiExecutionPolicyService,
    private readonly residency: AiDataResidencyService,
    private readonly access: AccessControlService,
  ) {}

  async resolve(input: ProcessingPolicyInput): Promise<ProcessingDescriptor> {
    const reasons: string[] = [];
    const executionMode = await this.resolveExecutionMode(input, reasons);
    const residency = await this.resolveResidency(input, reasons);

    if (input.dataSensitivity) {
      reasons.push(`sensitivity_${input.dataSensitivity.toLowerCase()}`);
    }

    return {
      executionMode,
      residencyRequired: residency.required,
      region: residency.region,
      label: this.label(executionMode, residency.required),
      reason: reasons.join('+'),
    };
  }

  /**
   * STANDARD or BATCH. `IMMEDIATE` short-circuits before the feature map is
   * consulted, and a BATCH decision additionally requires the tenant to be
   * entitled — an un-entitled tenant degrades to STANDARD (always correct, just
   * not discounted) rather than being refused.
   */
  private async resolveExecutionMode(
    input: ProcessingPolicyInput,
    reasons: string[],
  ): Promise<AiExecutionMode> {
    if (input.latencyRequirement === 'IMMEDIATE') {
      reasons.push('immediate_standard');
      return AI_EXECUTION_MODE.STANDARD;
    }

    const decision = this.execution.resolveMode(input.feature);
    if (decision.mode !== AI_EXECUTION_MODE.BATCH) {
      reasons.push(decision.reason);
      return decision.mode;
    }

    if (!(await this.entitled(input.tenantId, FeatureKey.AI_BATCH_PROCESSING))) {
      reasons.push('batch_not_entitled_standard');
      return AI_EXECUTION_MODE.STANDARD;
    }
    reasons.push(decision.reason);
    return AI_EXECUTION_MODE.BATCH;
  }

  /**
   * Whether this request must be processed regionally, and where.
   *
   * `AiDataResidencyService.resolve()` short-circuits to "not enforced" while
   * the platform flag is off, so the default path performs no database read and
   * costs nothing. Its fail-closed throw (deployment enabled but unusable)
   * propagates untouched — that is the existing, correct behaviour.
   */
  private async resolveResidency(
    input: ProcessingPolicyInput,
    reasons: string[],
  ): Promise<{ required: boolean; region: string | null }> {
    const decision = await this.residency.resolve(input.tenantId);
    const requiredByPolicy = this.residencyRequiredFeatures().has(input.feature);

    if (!decision.enforced) {
      if (requiredByPolicy) {
        // Platform policy says this workload must be processed regionally, but
        // the tenant has no usable deployment. Refuse — never fall through to
        // the global region for a workload explicitly marked as needing one.
        this.failClosed(
          input.tenantId,
          `feature "${input.feature}" requires regional processing but the tenant has no enabled deployment`,
        );
      }
      reasons.push('residency_not_required');
      return { required: false, region: null };
    }

    if (!(await this.entitled(input.tenantId, FeatureKey.AI_DATA_RESIDENCY))) {
      // The tenant's deployment says its data must stay in a region, but the
      // entitlement is absent. Processing globally would be exactly the silent
      // downgrade residency exists to prevent, so this refuses instead.
      this.failClosed(
        input.tenantId,
        'the tenant requires regional processing but is not entitled to AI Data Residency',
      );
    }

    reasons.push(
      requiredByPolicy ? 'residency_platform_policy' : 'residency_tenant_deployment',
    );
    return { required: true, region: decision.region };
  }

  /**
   * Entitlement check that honors the platform's own enforcement posture: a
   * decision that would not actually block at this site (shadow mode) is
   * treated as entitled, exactly as every other `AccessControlService` caller
   * behaves. Never throws — callers decide what a `false` means.
   */
  private async entitled(tenantId: string, key: FeatureKey): Promise<boolean> {
    const decision = await this.access.resolve(tenantId, key);
    if (decision.allowed) return true;
    return !this.access.shouldBlock(decision, {
      surface: 'service',
      detail: `AiProcessingPolicyService.${key}`,
    });
  }

  /** Features platform policy marks as requiring regional processing (CSV env). */
  private residencyRequiredFeatures(): Set<string> {
    return new Set(
      String(this.config.get('AI_RESIDENCY_REQUIRED_FEATURES', ''))
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );
  }

  /**
   * Mirrors `AiDataResidencyService.failClosed` — same error code, same public
   * reason — so a caller cannot tell which of the two refused, and neither
   * leaks tenant billing state to an end user (this path is reachable from the
   * unauthenticated guest widget).
   */
  private failClosed(tenantId: string, reason: string): never {
    this.logger.error(
      `AI processing policy fail-closed for tenant ${tenantId}: ${reason}`,
    );
    throw new AppError(ErrorCode.FORBIDDEN, {
      message:
        'AI data residency is required for this request but its regional deployment is unavailable. ' +
        'The request was refused rather than processed in the global region.',
      publicContext: { reason: AI_COMPLIANCE_ROUTE_UNAVAILABLE },
      internalContext: { tenantId, reason },
    });
  }

  /** The composed telemetry label persisted on metrics rows. */
  private label(mode: AiExecutionMode, residencyRequired: boolean): string {
    return residencyRequired ? `${mode}+RESIDENCY` : mode;
  }
}
