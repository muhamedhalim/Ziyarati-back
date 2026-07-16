import { Injectable, Logger } from '@nestjs/common';

import {
  CampaignDeliveryPayload,
  CampaignDeliveryProvider,
  CampaignDeliveryResult,
} from './campaign-delivery.provider.interface';
import { CAMPAIGN_CHANNEL } from '../campaign.constants';
import { WhatsappExecutionService } from '../../whatsapp/whatsapp-execution.service';
import { WHATSAPP_DELIVERY_STATUS } from '../../whatsapp/whatsapp.constants';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * REAL WhatsApp campaign delivery.
 *
 * Deliberately a THIN adapter: it owns no send logic of its own and delegates
 * to WhatsappExecutionService.sendTemplateMessage — the single send seam that
 * already resolves the tenant's account, validates the template, resolves the
 * recipient, enforces the usage quota, and records the notification log. Ad-hoc
 * sends, scheduled sends and campaign sends therefore all behave identically;
 * duplicating any of that here is how the two paths would drift apart.
 *
 * Its real job is TRANSLATION between two contracts:
 *  - campaign payload  → template-send DTO (customerId is the recipient), and
 *  - thrown AppErrors  → the {success,transient} result the dispatcher expects.
 *
 * Contract: never throws for expected failures — CampaignDispatchService relies
 * on the returned `transient` flag to decide retry vs. permanent-fail.
 */
@Injectable()
export class WhatsappCampaignDeliveryProvider implements CampaignDeliveryProvider {
  readonly name = 'whatsapp-campaign';
  private readonly logger = new Logger('WhatsappCampaignDeliveryProvider');

  constructor(private readonly execution: WhatsappExecutionService) {}

  supports(channel?: string): boolean {
    return channel === CAMPAIGN_CHANNEL.WHATSAPP;
  }

  async send(payload: CampaignDeliveryPayload): Promise<CampaignDeliveryResult> {
    // WhatsApp business-initiated messages MUST use an approved template — a
    // campaign without one can never succeed, so fail it permanently rather
    // than burning retries on it.
    if (!payload.templateId) {
      return {
        success: false,
        error: 'Campaign has no WhatsApp template; business-initiated sends require one',
        transient: false,
      };
    }

    try {
      const result = await this.execution.sendTemplateMessage(
        payload.tenantId,
        payload.templateId,
        {
          customerId: payload.customerId,
          // Send from the campaign's own number when it names one. Without this
          // a re-run months later could silently switch identity just because
          // the tenant's default changed.
          accountId: payload.accountId,
          variables: payload.metadata,
        },
      );

      if (result.status === WHATSAPP_DELIVERY_STATUS.SENT && result.providerMessageId) {
        return { success: true, providerRef: result.providerMessageId };
      }

      // The send seam already logged + classified nothing: let the dispatcher's
      // heuristic read the provider's own error text (429/timeout ⇒ transient).
      return {
        success: false,
        error: result.error ?? 'WhatsApp provider rejected the message',
      };
    } catch (err) {
      return this.classifyThrown(err, payload);
    }
  }

  /**
   * Maps a thrown AppError onto the dispatcher's retry contract.
   *
   * The distinction that matters: a misconfiguration (no connected number, bad
   * template, unknown customer) will fail identically on every retry, so
   * retrying it just burns quota and delays the run's completion. Genuine
   * infrastructure faults are left unclassified for the dispatcher's heuristic.
   */
  private classifyThrown(err: unknown, payload: CampaignDeliveryPayload): CampaignDeliveryResult {
    const message = (err as Error)?.message ?? 'WhatsApp send failed';

    if (err instanceof AppError) {
      const permanent: ErrorCode[] = [
        ErrorCode.NOT_FOUND, // no connected account / template / customer
        ErrorCode.BAD_REQUEST, // malformed recipient
        ErrorCode.UNPROCESSABLE_ENTITY, // inactive account, unapproved template, quota exhausted
        ErrorCode.FORBIDDEN,
      ];
      if (permanent.includes(err.code)) {
        return { success: false, error: message, transient: false };
      }
    }

    this.logger.warn(
      `Unclassified WhatsApp campaign send failure (campaign=${payload.campaignId}): ${message}`,
    );
    return { success: false, error: message };
  }
}
