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

import { PaymentWebhookService } from './payment-webhook.service';
import type { MoyasarWebhookEvent } from './webhooks/moyasar-webhook.types';

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
 * Moyasar inbound webhook — the PLATFORM endpoint the gateway calls.
 *
 * Public (no JWT): authenticated by the shared secret, NOT by a user token. The
 * tenant is resolved internally from our own Payment row (via the gateway
 * payment id) — never from the request body. Processing is idempotent.
 *
 * The body is typed as a plain interface so the global ValidationPipe does not
 * whitelist-strip unmodeled provider fields.
 */
@ApiTags('Payments Webhooks')
@Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @ApiOperation({
    summary: 'Ingest a Moyasar webhook event (public)',
    description:
      '**Public endpoint — called by Moyasar, not by app users.** Verifies the shared secret (header `x-moyasar-token` or body `secret_token`), de-duplicates on the event id, resolves the payment by gateway id, and updates the tenant-scoped record idempotently. Invalid secret → 401.',
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
  @Post('moyasar')
  @HttpCode(HttpStatus.OK)
  ingestMoyasar(
    @Body() body: MoyasarWebhookEvent,
    @Headers('x-moyasar-token') token?: string,
  ) {
    return this.webhooks.handleMoyasar(body, token);
  }
}
