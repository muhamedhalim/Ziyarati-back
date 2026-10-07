import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { TapWebhookHandler } from './webhooks/tap-webhook.handler';
import type { TapWebhookPayload } from './providers/tap/tap.types';

import { Public } from '../auth/decorators/public.decorator';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * Gateway inbound webhooks — the PLATFORM endpoints the gateways call.
 *
 * Public (no JWT): each route authenticates the gateway's own signature scheme
 * (Tap: HMAC `hashstring`), NOT a user token. The
 * tenant is resolved internally from our own Payment row (via the gateway
 * payment id) — never from the request body. Processing is idempotent.
 *
 * The body is typed as a plain interface so the global ValidationPipe does not
 * whitelist-strip unmodeled provider fields.
 */
@ApiTags('Payments Webhooks')
@Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(
    private readonly tapWebhooks: TapWebhookHandler,
  ) {}

  @ApiOperation({
    summary: 'Ingest a Tap webhook event (public)',
    description:
      '**Public endpoint — called by Tap, not by app users.** Verifies the `hashstring` header (HMAC-SHA256 of the posted charge fields, keyed by the Tap secret key), re-fetches the charge from Tap with our own key, de-duplicates on `tap:{chargeId}:{status}`, resolves the payment by gateway id (falling back to our echoed `reference.transaction`) and updates the tenant-scoped record idempotently. Invalid signature → 401. Tap unreachable while re-fetching → 503 so Tap retries.',
  })
  @ApiOkResponse({
    description: 'Event accepted.',
    schema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean', example: true },
        matched: { type: 'boolean', example: true },
        deduplicated: { type: 'boolean', example: false },
        status: { type: 'string', example: 'PAID' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid webhook signature.',
    schema: S_ERROR,
  })
  @Public()
  @Post('tap')
  @HttpCode(HttpStatus.OK)
  ingestTap(
    @Body() body: TapWebhookPayload,
    @Headers('hashstring') hashstring?: string,
  ) {
    return this.tapWebhooks.handle(body, hashstring);
  }
}
