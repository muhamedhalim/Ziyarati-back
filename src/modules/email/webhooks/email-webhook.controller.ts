import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../auth/decorators/public.decorator';
import { SkipCsrf } from '../../auth/decorators/skip-csrf.decorator';
import { AppError, ErrorCode } from '../../../common/errors';
import { RecipientDelivery } from '../../../entities/enums';

import { EmailWebhookSignatureVerifier } from './email-webhook-signature.verifier';
import { RecipientDeliveryService } from '../../campaigns/recipient-delivery.service';
import { EmailSuppressionService } from '../email-suppression.service';

/** Minimal shape read from Resend's bounce/complaint event payload. */
interface ResendWebhookBody {
  type?: string;
  data?: { email_id?: string; to?: string[] | string };
}

const RESEND_BOUNCE_EVENT = 'email.bounced';
const RESEND_COMPLAINT_EVENT = 'email.complained';

/** Reachable by anyone claiming to be Resend — bounded independent of signature verification. */
const EMAIL_WEBHOOK_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : 60,
    ttl: 60_000,
  },
};

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T136).
 *
 * Consumes Resend bounce/complaint feedback, VERIFYING it before acting on
 * it (T136's own hard requirement — an unverified message must suppress
 * NOTHING, or an attacker could suppress a clinic's whole marketing list by
 * forging events). Only the campaign_recipients row matched by the webhook's
 * `email_id` (== our own `provider_ref`, written at dispatch time) is ever
 * touched — the tenant and address come from THAT row
 * (`RecipientDeliveryService.recordDeliveryTrusted`), never trusted from the
 * payload's own claimed `to` field.
 *
 * Replay safety: both the delivery-state transition (forward-only ranked,
 * `Not(BOUNCED)`-guarded) and the suppression write (`ON CONFLICT DO
 * NOTHING`) are already idempotent, so a redelivered/duplicated webhook is a
 * harmless no-op — no separate nonce-tracking table is introduced.
 */
@ApiTags('Public — Email Webhooks')
@Controller('public/email/webhooks')
export class EmailWebhookController {
  constructor(
    private readonly verifier: EmailWebhookSignatureVerifier,
    private readonly delivery: RecipientDeliveryService,
    private readonly suppression: EmailSuppressionService,
  ) {}

  @Public()
  @SkipCsrf()
  @Throttle(EMAIL_WEBHOOK_THROTTLE)
  @Post('resend')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: ResendWebhookBody,
    @Headers('x-resend-signature') signature?: string,
  ) {
    if (!this.verifier.verify(signature, req.rawBody)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'Invalid webhook signature',
      });
    }

    const emailId = body?.data?.email_id;
    if (
      !emailId ||
      (body?.type !== RESEND_BOUNCE_EVENT &&
        body?.type !== RESEND_COMPLAINT_EVENT)
    ) {
      // A verified but irrelevant/unrecognised event (e.g. email.delivered,
      // email.opened) — accepted, nothing to suppress.
      return { accepted: true, suppressed: false };
    }

    const result = await this.delivery.recordDeliveryTrusted(
      emailId,
      RecipientDelivery.BOUNCED,
    );
    if (!result.tenantId || !result.email) {
      // Verified, but we have no matching send of ours to act on.
      return { accepted: true, suppressed: false };
    }

    const reason = body.type === RESEND_BOUNCE_EVENT ? 'BOUNCE' : 'COMPLAINT';
    await this.suppression.suppress(
      result.tenantId,
      result.email,
      reason,
      'webhook',
    );
    return { accepted: true, suppressed: true };
  }
}
