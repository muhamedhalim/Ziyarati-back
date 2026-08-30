import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CampaignDeliveryPayload,
  CampaignDeliveryProvider,
  CampaignDeliveryResult,
} from './campaign-delivery.provider.interface';
import { CAMPAIGN_CHANNEL } from '../campaign.constants';
import { EmailProviderFactory } from '../../email/providers/email-provider.factory';
import { resolveEmailConfig } from '../../email/email.config';
import { renderEmail } from '../../email/email.templates';

/**
 * REAL email campaign delivery (Phase 11, US7, T131).
 *
 * Deliberately a THIN adapter, mirroring `WhatsappCampaignDeliveryProvider`:
 * it owns no HTTP/SDK code of its own. Rendering reuses the SAME
 * `renderEmail`/`campaign_marketing` template `EmailDeliveryService` would use
 * for a transactional send, and sending reuses the SAME `EmailProviderFactory`
 * (Resend adapter) — no parallel provider integration is introduced.
 *
 * NOT routed through `EmailService`/`EmailDeliveryService` directly: those are
 * built for FIRE-AND-FORGET transactional mail (queued, best-effort, no
 * synchronous result) and their own `email_logs` recording, whereas
 * `CampaignDispatchService` needs an immediate {success, providerRef, error,
 * transient} result to drive `campaign_recipients` (the authoritative record
 * for campaign analytics — T138). Going through the shared provider +
 * template layer, rather than a hand-rolled HTTP call, is what keeps this
 * from being a second integration.
 *
 * Contract: never throws for expected failures — same as every other
 * CampaignDeliveryProvider.
 */
@Injectable()
export class EmailCampaignDeliveryProvider implements CampaignDeliveryProvider {
  readonly name = 'email-campaign';
  private readonly logger = new Logger('EmailCampaignDeliveryProvider');

  constructor(
    private readonly providers: EmailProviderFactory,
    private readonly config: ConfigService,
  ) {}

  supports(channel?: string): boolean {
    return channel === CAMPAIGN_CHANNEL.EMAIL;
  }

  async send(
    payload: CampaignDeliveryPayload,
  ): Promise<CampaignDeliveryResult> {
    const to = payload.email;
    if (!to) {
      // No email to send to (customer/recipient snapshot has none) — this
      // can never succeed on retry.
      return {
        success: false,
        error: 'Recipient has no email address',
        transient: false,
      };
    }

    try {
      const cfg = resolveEmailConfig(this.config);
      const rendered = renderEmail(
        'campaign_marketing',
        {
          subject: payload.emailSubject,
          body: payload.emailBody,
          ...payload.metadata,
        },
        { appUrl: cfg.appUrl, locale: cfg.defaultLocale, brand: 'Ziyarati' },
      );

      const provider = this.providers.resolve();
      const result = await provider.send({
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        from: cfg.from,
        // FR-E018 — sent from the platform's single configured sender, with
        // the clinic's own contact set as reply-to. No per-clinic sending
        // domain is introduced.
        replyTo: payload.replyTo ?? cfg.replyTo,
        tags: [{ name: 'campaign', value: payload.campaignId }],
      });

      if (result.success) {
        if (!result.providerMessageId) {
          // No id = nothing to write to the UNIQUE provider_ref guard — must
          // not be recorded as a successful send.
          return {
            success: false,
            error: 'Email provider returned no message id',
          };
        }
        return { success: true, providerRef: result.providerMessageId };
      }
      return {
        success: false,
        error: result.error ?? 'Email provider rejected the message',
        transient: result.transient,
      };
    } catch (err) {
      // Unexpected throw — leave unclassified for the dispatcher's heuristic.
      const message = (err as Error)?.message ?? 'Email send failed';
      this.logger.warn(
        `Unclassified email campaign send failure (campaign=${payload.campaignId}): ${message}`,
      );
      return { success: false, error: message };
    }
  }
}
