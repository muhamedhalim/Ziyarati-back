import {
  Controller,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../auth/decorators/public.decorator';
import { SkipCsrf } from '../../auth/decorators/skip-csrf.decorator';

import { IntegrationInboundService } from './integration-inbound.service';
import { INBOUND_HEADER } from '../integration-platform.constants';

/**
 * PUBLIC inbound webhook receiver (Phase 4).
 *
 * `@Public()` because the caller is an external clinic system, not a platform
 * session — but "public" here means "no JWT", never "unauthenticated": the
 * request is authenticated by an HMAC signature over the RAW body using the
 * connection's endpoint secret, and is rejected outright without a valid one
 * (see IntegrationInboundService.receive).
 *
 * `@SkipCsrf()` for the same reason a cookie is irrelevant here: there is no
 * browser session and no cookie is read to authorize anything. The route is
 * addressed by CONNECTION ID alone — a caller can never assert a tenant id, and
 * the tenant is taken from the endpoint row.
 *
 * The raw body is read from `req.rawBody` (enabled by `rawBody: true` in
 * main.ts). Signatures MUST be verified over the exact received bytes; a
 * re-serialized object reorders keys and would break valid signatures.
 */
@ApiTags('Integration API')
@Controller('integrations/inbound')
export class IntegrationInboundWebhookController {
  constructor(private readonly inbound: IntegrationInboundService) {}

  @ApiOperation({
    summary: 'Receive an inbound integration event',
    description: [
      'Signed by the connection endpoint secret. Required headers:',
      `\`${INBOUND_HEADER.SIGNATURE}\` (\`sha256=<hex>\` over \`"{timestamp}.{rawBody}"\`),`,
      `\`${INBOUND_HEADER.TIMESTAMP}\` (unix seconds),`,
      `\`${INBOUND_HEADER.EVENT_ID}\` (the provider's own event id — the replay key),`,
      `\`${INBOUND_HEADER.EVENT_TYPE}\` (must be on the endpoint allowlist).`,
      'Body: `{ "externalId": "...", "data": { ... } }`.',
      '202 accepted (queued), 200 duplicate, 403 signature/replay failure, 422 rejected with a safe reason code.',
    ].join(' '),
  })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  @Public()
  @SkipCsrf()
  @Post(':connectionId')
  @HttpCode(202)
  async receive(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    // Exact received bytes. Falls back to a re-serialized body only when the raw
    // buffer is unavailable, which would itself break signature verification and
    // therefore fail closed rather than accept an unverified delivery.
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body ?? {});
    const receipt = await this.inbound.receive(
      connectionId,
      rawBody,
      req.headers as Record<string, string | undefined>,
      ip,
    );
    res.status(receipt.status);
    return receipt.body;
  }

  /** Reachability probe for partners configuring the URL. Never touches data. */
  @ApiExcludeEndpoint()
  @Public()
  @SkipCsrf()
  @Post(':connectionId/ping')
  @HttpCode(200)
  ping(@Param('connectionId', ParseUUIDPipe) connectionId: string) {
    return { ok: true, connectionId };
  }
}
