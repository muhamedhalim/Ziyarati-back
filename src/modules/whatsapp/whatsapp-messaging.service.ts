import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WhatsappProviderFactory } from './providers/whatsapp-provider.factory';
import {
  WhatsappSendPayload,
  WhatsappSendResult,
  WhatsappSessionPayload,
} from './providers/whatsapp-message.provider.interface';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { UsageService } from '../subscription-billing/usage.service';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import {
  assessSessionContent,
  describeViolations,
  resolveContentPolicyMode,
} from './whatsapp-content-policy';

/**
 * Thin messaging wrapper over the provider abstraction. Resolves the right
 * provider (strategy) and delegates the send. Holds NO persistence or business
 * rules — orchestration (validation + logging) lives in WhatsappExecutionService.
 * This is the unit a future queue worker would call per message.
 *
 * ENTITLEMENT AND METERING FOR SESSION SENDS live here, and deliberately not in
 * the three callers. `sendTemplateMessage` is the single seam for TEMPLATE
 * sends and gates/meters there, but `sendSession` — the free-form reply used
 * inside the 24h service window — had NO seam of its own: the AI bot reply
 * (`WhatsappInboundAiService`), the agent handover reply (`HandoverChatService`)
 * and the workflow WHATSAPP action (`WorkflowActionExecutor`) each called the
 * provider directly. A tenant whose WhatsApp capability was never granted, or
 * was administratively suspended, still sent real messages down all three, and
 * none of them incremented `WHATSAPP_MESSAGES` — so a clinic on a paid plan
 * could exceed its message cap without the counter ever moving.
 *
 * Putting the check at the provider boundary rather than in each caller is the
 * point: a fourth caller added later inherits it by construction. That is also
 * why this is NOT expressed as "if whatsapp inbound, check X" anywhere — the
 * seam asks `AccessControlService` the same question an HTTP route asks, and
 * takes whatever answer it gets.
 */
@Injectable()
export class WhatsappMessagingService {
  private readonly logger = new Logger('WhatsappMessagingService');

  constructor(
    private readonly factory: WhatsappProviderFactory,
    private readonly access: AccessControlService,
    private readonly usage: UsageService,
    // Optional so direct-construction tests keep working; Nest injects it.
    @Optional() private readonly config?: ConfigService,
  ) {}

  send(payload: WhatsappSendPayload): Promise<WhatsappSendResult> {
    const provider = this.factory.resolve(payload);
    return provider.send(payload);
  }

  /**
   * Sends a free-form session (text / interactive) message — the reply channel
   * for inbound AI conversations. Resolves the same provider strategy; if the
   * resolved provider does not implement session sends, returns a clear error
   * instead of throwing (the caller logs it).
   *
   * REFUSES rather than throws, matching this method's existing contract: all
   * three callers already branch on `result.success` — the workflow executor in
   * particular has a claimed `notification_logs` row it must finalize, and an
   * exception thrown past it would strand that row in SENDING until the stale
   * reclaim window elapsed. A denial is therefore a normal, recorded failure
   * outcome, and nothing reaches the provider.
   */
  async sendSession(
    payload: WhatsappSessionPayload,
  ): Promise<WhatsappSendResult> {
    const denial = await this.refuseIfNotEntitled(payload.tenantId);
    if (denial) return denial;

    // Residency plan P5: a free-form reply (AI bot, agent handover, workflow)
    // must not carry a national ID, card number, insurance number or credential.
    // Refuses like every other denial here — a normal, recorded failure, never a
    // throw — and reports categories only, never the text.
    const mode = resolveContentPolicyMode(
      this.config?.get('WHATSAPP_CONTENT_POLICY', 'enforce'),
    );
    if (mode !== 'off') {
      const violations = assessSessionContent(payload);
      if (violations.length > 0) {
        const reason = describeViolations(violations);
        if (mode === 'enforce') {
          this.logger.warn(
            `Blocked WhatsApp session send (tenant=${payload.tenantId}): ${reason}`,
          );
          return {
            success: false,
            error: `Blocked by the WhatsApp content policy: ${reason}`,
          };
        }
        this.logger.warn(
          `[monitor] WhatsApp content policy would block this session send (tenant=${payload.tenantId}): ${reason}`,
        );
      }
    }

    const provider = this.factory.resolve();
    if (!provider.sendSession) {
      return {
        success: false,
        error: `Provider "${provider.name}" does not support session messages`,
      };
    }

    // Reserved BEFORE the provider call and released if the send does not
    // succeed — the same atomic admission `sendTemplateMessage` uses (FND-034),
    // for the same reason: a check-then-act pair would admit two concurrent
    // sends at the cap. For a tenant running on a feature override this always
    // admits (`UNMETERED_BY_PLAN`) but still WRITES the counter, so the
    // platform can see what a subscription-less clinic consumes.
    const admission = await this.usage.incrementIfWithinLimit(
      payload.tenantId,
      USAGE_METRIC.WHATSAPP_MESSAGES,
      1,
    );
    if (!admission.applied) {
      this.logger.warn(
        `Refusing WhatsApp session send for tenant ${payload.tenantId}: monthly message limit reached ` +
          `(${admission.used}/${admission.limit})`,
      );
      return {
        success: false,
        error: `Usage limit reached for ${USAGE_METRIC.WHATSAPP_MESSAGES} (${admission.used}/${admission.limit})`,
      };
    }

    let result: WhatsappSendResult;
    try {
      result = await provider.sendSession(payload);
    } catch (err) {
      result = {
        success: false,
        error: (err as Error)?.message ?? 'provider error',
      };
    }

    if (!result.success) {
      await this.usage.release(
        payload.tenantId,
        USAGE_METRIC.WHATSAPP_MESSAGES,
        1,
      );
    }
    return result;
  }

  /**
   * The entitlement half of the seam: `null` when the tenant may send, or the
   * refusal result to return otherwise.
   *
   * Fails CLOSED. This runs on webhook, worker and socket paths that never pass
   * a guard, so an unreadable decision must not become a send. The message
   * returned to the caller is deliberately generic — these results are logged
   * and, on the workflow path, persisted as `error_message` on a notification
   * log, so it must not carry the tenant's subscription state.
   */
  private async refuseIfNotEntitled(
    tenantId: string,
  ): Promise<WhatsappSendResult | null> {
    try {
      const decision = await this.access.resolve(tenantId, FeatureKey.WHATSAPP);
      if (decision.allowed) return null;
      if (
        !this.access.shouldBlock(decision, {
          surface: 'service',
          detail: 'WhatsappMessagingService.sendSession',
        })
      ) {
        return null; // ACCESS_POLICY_MODE=shadow — recorded, not enforced
      }
      this.logger.warn(
        `Refusing WhatsApp session send for tenant ${tenantId}: not entitled to "${FeatureKey.WHATSAPP}" ` +
          `(source=${decision.source})`,
      );
      return {
        success: false,
        error: 'WhatsApp messaging is not available for this clinic',
      };
    } catch (err) {
      this.logger.error(
        `WhatsApp entitlement check failed for tenant ${tenantId} — refusing the send (fail closed): ` +
          `${(err as Error)?.message}`,
      );
      return {
        success: false,
        error: 'WhatsApp messaging is not available for this clinic',
      };
    }
  }
}
