import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import type { WhatsappWebhookBody } from './webhooks/whatsapp-webhook.types';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { WhatsappWebhookService } from './whatsapp-webhook.service';
import { CreateWhatsappWebhookDto } from './dto/create-whatsapp-webhook.dto';
import { UpdateWhatsappWebhookDto } from './dto/update-whatsapp-webhook.dto';
import { WhatsappWebhookFilterDto } from './dto/whatsapp-webhook-filter.dto';

import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

// These endpoints are @Public() — reachable by anyone, not just Meta — so they
// get their own budget rather than the app-wide default. Relaxed under Jest for
// the same reason as the app-wide default in app.module.ts — a single e2e spec
// file's requests all land in one in-memory bucket.
const IS_TEST = process.env.NODE_ENV === 'test';

// The GET handshake is only ever hit when someone registers the callback URL.
const PUBLIC_WEBHOOK_THROTTLE = {
  default: { limit: IS_TEST ? 1_000_000 : 60, ttl: 60_000 },
};

/** Default POST budget, per IP per minute — see `eventsThrottleLimit`. */
export const WHATSAPP_EVENTS_THROTTLE_DEFAULT = 3000;

/**
 * Budget for `POST /events`, per IP per minute. Meta delivers EVERY clinic's
 * events from a small shared set of addresses, and each outbound message adds up
 * to three status webhooks (sent / delivered / read), so a per-IP budget sized
 * for one clinic starts answering 429 as soon as the platform has a few busy
 * ones — and Meta then backs off redelivery, delaying patients' replies.
 *
 * It is NOT the flood defence: that is the HMAC over the raw body (checked
 * before any database write), the freshness window and the body-size limit. This
 * only bounds the cost of an unauthenticated flood reaching them.
 *
 * Read per request, not at import: the decorator is evaluated before `.env` is
 * loaded. `WHATSAPP_WEBHOOK_THROTTLE_PER_MIN` overrides the default.
 */
export function eventsThrottleLimit(): number {
  if (IS_TEST) return 1_000_000;
  const n = Number(process.env.WHATSAPP_WEBHOOK_THROTTLE_PER_MIN);
  return Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : WHATSAPP_EVENTS_THROTTLE_DEFAULT;
}

const EVENTS_THROTTLE = {
  default: { limit: () => eventsThrottleLimit(), ttl: 60_000 },
};

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

const S_WEBHOOK = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    event_type: { type: 'string', nullable: true, example: 'message_status' },
    payload: { type: 'object', nullable: true, additionalProperties: true },
    processed: { type: 'boolean', example: false },
    idempotency_key: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_WEBHOOK_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_WEBHOOK },
    total: { type: 'number', example: 320 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * WhatsApp inbound webhook events.
 *
 * Public endpoints (`/verify`, `/events`) are how the provider reaches us — they
 * bypass JWT (signature-verified instead) and resolve the tenant from the
 * payload. Management endpoints are authenticated + tenant-scoped.
 *
 * Schema note: `whatsapp_webhooks` is an event LOG (no URL/secret column);
 * verify-token & signing secret come from configuration.
 */
@ApiTags('WhatsApp Webhooks')
@Controller('whatsapp/webhooks')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WhatsappWebhookController {
  constructor(
    private readonly webhooks: WhatsappWebhookService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiExcludeEndpoint()
  @Public()
  @Throttle(PUBLIC_WEBHOOK_THROTTLE)
  @Get('verify')
  verify(@Query() query: Record<string, string>, @Res() res: Response) {
    this.respondToChallenge(query, res);
  }

  /**
   * The SAME handshake, on the ingestion path.
   *
   * Meta's webhook configuration takes ONE Callback URL and uses it for both
   * halves of the protocol: a `GET` carrying `hub.mode`/`hub.verify_token`/
   * `hub.challenge` when the URL is saved, and every subsequent event `POST`.
   * With the handshake living only on `/verify`, neither path could actually be
   * registered — `GET /events` fell through to the authenticated `@Get(':id')`
   * below and answered 401, so Meta refused to save the URL, while `/verify`
   * has no POST handler and would 404 every real event.
   *
   * Declared BEFORE `@Get(':id')` so Nest's in-order matching resolves
   * `events` here rather than treating it as a (non-UUID) id.
   *
   * Security is unchanged: this delegates to the same `resolveChallenge` —
   * same constant-time `META_WEBHOOK_VERIFY_TOKEN` comparison, same
   * fail-closed 403. It only adds a route, never a bypass. `/verify` is kept
   * so anything already pointed at it keeps working.
   */
  @ApiExcludeEndpoint()
  @Public()
  @Throttle(PUBLIC_WEBHOOK_THROTTLE)
  @Get('events')
  verifyOnEventsPath(
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ) {
    this.respondToChallenge(query, res);
  }

  /** Echo `hub.challenge` when the token matches, else 403. */
  private respondToChallenge(
    query: Record<string, string>,
    res: Response,
  ): void {
    const challenge = this.webhooks.resolveChallenge(
      query['hub.mode'],
      query['hub.verify_token'],
      query['hub.challenge'],
    );
    if (challenge === null) {
      res.status(HttpStatus.FORBIDDEN).send('verification failed');
      return;
    }
    res.status(HttpStatus.OK).send(challenge);
  }

  @ApiOperation({
    summary: 'Ingest an inbound WhatsApp event (public)',
    description: `
**Public endpoint — called by the WhatsApp provider, not by app users.**

Verifies the \`X-Hub-Signature-256\` header (signature abstraction), de-duplicates
on \`idempotencyKey\`, resolves the tenant from the payload's \`phone_number_id\`,
and stores the event (\`processed = false\`). Authentication is via signature, not
JWT; the tenant is NEVER taken from the request body.

**Failure scenarios:** invalid signature → 401. Duplicate event → accepted +
\`deduplicated: true\`.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Event accepted.',
    schema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean', example: true },
        id: { type: 'string', format: 'uuid' },
        deduplicated: { type: 'boolean', example: false },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid webhook signature.',
    schema: S_ERROR,
  })
  @Public()
  @Throttle(EVENTS_THROTTLE)
  @Post('events')
  @HttpCode(HttpStatus.OK)
  ingest(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: WhatsappWebhookBody,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    // The verifier hashes the EXACT raw bytes (req.rawBody), never the parsed
    // body — that is the only signature input Meta will agree with.
    return this.webhooks.ingest(body, req.rawBody, signature);
  }

  @ApiOperation({
    summary: 'Create a webhook log entry',
    description: `**Protected — requires \`whatsapp.webhooks.manage\`. Clinic active.** Manually records a webhook event for the caller's tenant (admin/testing).`,
  })
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ description: 'Webhook entry created.', schema: S_WEBHOOK })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.webhooks.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  create(@Body() dto: CreateWhatsappWebhookDto) {
    return this.webhooks.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List webhook event logs',
    description: `**Protected — requires \`whatsapp.webhooks.manage\`. Clinic active.** Tenant-scoped, filter by event type / processed / date range.`,
  })
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({
    description: 'Paginated webhook logs.',
    schema: S_WEBHOOK_LIST,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.webhooks.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  findAll(@Query() filter: WhatsappWebhookFilterDto) {
    return this.webhooks.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get a webhook event',
    description: `**Protected — \`whatsapp.webhooks.manage\`. Clinic active.** Foreign-tenant event returns 404.`,
  })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'id',
    description: 'Webhook event UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook event.', schema: S_WEBHOOK })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.webhooks.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Webhook event not found.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a webhook event',
    description: `**Protected — \`whatsapp.webhooks.manage\`. Clinic active.** Update event type / payload / processed flag.`,
  })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'id',
    description: 'Webhook event UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook event updated.', schema: S_WEBHOOK })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.webhooks.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Webhook event not found.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWhatsappWebhookDto,
  ) {
    return this.webhooks.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Retry processing a webhook event',
    description: `**Protected — requires \`whatsapp.webhooks.manage\`. Clinic active.** Re-queues the event (sets \`processed = false\`) for the processing worker. Architecture seam — no synchronous reprocessing here.`,
  })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'id',
    description: 'Webhook event UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Event re-queued.', schema: S_WEBHOOK })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.webhooks.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Webhook event not found.',
    schema: S_ERROR,
  })
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_WEBHOOKS_MANAGE)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.retry(this.ctx.requireTenantId(), id);
  }
}
