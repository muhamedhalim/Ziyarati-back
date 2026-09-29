import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { QueryWebhookEndpointsDto } from './dto/query-webhook-endpoints.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

const S_ERROR = {
  type: 'object',
  properties: {
    statusCode: { type: 'number' },
    code: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

/**
 * Outbound webhook endpoint management for external (clinic-owned) systems.
 * Guarded by PermissionsGuard + ActiveTenantGuard; tenant id from TenantContext.
 * The plaintext signing secret is returned ONLY by create/rotate-secret and
 * never again.
 */
@ApiTags('Platform Webhooks (Outbound)')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/webhooks/endpoints')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WebhookEndpointController {
  constructor(
    private readonly endpoints: WebhookEndpointService,
    private readonly deliveries: WebhookDeliveryService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Register a webhook endpoint',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.** Returns the plaintext secret ONCE.',
  })
  @ApiCreatedResponse({
    description: 'Webhook endpoint created (secret returned once).',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `platform.webhooks-outbound.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  create(
    @Body() dto: CreateWebhookEndpointDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.endpoints.create(this.ctx.requireTenantId(), dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'List webhook endpoints',
    description:
      '**Protected — `platform.webhooks-outbound.read`. Clinic active.** Tenant-scoped; secrets never included.',
  })
  @ApiOkResponse({ description: 'Paginated webhook endpoints (no secrets).' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `platform.webhooks-outbound.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_READ)
  list(@Query() query: QueryWebhookEndpointsDto) {
    return this.endpoints.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get a webhook endpoint',
    description:
      "**Protected — `platform.webhooks-outbound.read`. Clinic active.** Another tenant's endpoint returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook endpoint details (no secret).' })
  @ApiNotFoundResponse({
    description: 'Not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.endpoints.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a webhook endpoint',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.** Updates name, URL, and/or subscribed events. A URL change is re-validated by the same SSRF guard used at creation.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook endpoint updated.' })
  @ApiNotFoundResponse({
    description: 'Not found in this tenant.',
    schema: S_ERROR,
  })
  @Patch(':id')
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWebhookEndpointDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.endpoints.update(this.ctx.requireTenantId(), id, dto, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Rotate the webhook signing secret',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.** Issues a new secret (returned once); the old secret stops signing future deliveries immediately.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Secret rotated (new plaintext returned once).',
  })
  @ApiNotFoundResponse({
    description: 'Not found in this tenant.',
    schema: S_ERROR,
  })
  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  rotateSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.endpoints.rotateSecret(this.ctx.requireTenantId(), id, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Activate a webhook endpoint',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.**',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook endpoint activated.' })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.endpoints.setActive(this.ctx.requireTenantId(), id, true, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Deactivate a webhook endpoint',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.** Reversible via activate; no further deliveries are attempted while inactive.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook endpoint deactivated.' })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.endpoints.setActive(this.ctx.requireTenantId(), id, false, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Delete a webhook endpoint',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.** Soft-deletes the endpoint (stops delivery immediately); its delivery history and audit trail are preserved.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook endpoint deleted.' })
  @ApiNotFoundResponse({
    description: 'Not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':id')
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.endpoints.remove(this.ctx.requireTenantId(), id, {
      userId,
      ip,
    });
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  @ApiOperation({
    summary: 'Send a test event to an endpoint',
    description:
      '**Protected — `platform.webhooks.outbound.manage`. Clinic active.** Queues a signed `webhook.test` delivery to this endpoint through the normal delivery pipeline (same headers, signature, retries and history) so you can verify your receiver. Returns the queued delivery; follow its outcome under Deliveries. The endpoint must be active. Limited to 5 per minute per endpoint.',
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiAcceptedResponse({ description: 'Test delivery queued.' })
  @ApiUnprocessableEntityResponse({ description: 'The endpoint is disabled.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Endpoint not found in this tenant.', schema: S_ERROR })
  sendTest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.deliveries.sendTest(this.ctx.requireTenantId(), id, { userId, ip });
  }
}
