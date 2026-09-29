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
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';

import { IntegrationWebhookEndpointService } from './integration-webhook-endpoint.service';
import { IntegrationInboundService } from './integration-inbound.service';
import {
  CreateWebhookEndpointDto,
  QueryInboundEventsDto,
  UpdateWebhookEndpointDto,
} from '../dto/webhook-endpoint.dto';
import {
  INBOUND_EVENTS,
  DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
  LEGACY_WEBHOOK_SIGNATURE_SCHEMES,
  WEBHOOK_SIGNATURE_SCHEMES,
} from '../integration-platform.constants';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * Tenant-admin management of inbound webhook endpoints + delivery history
 * (Phase 4). Guarded by PermissionsGuard + ActiveTenantGuard; the tenant id
 * always comes from TenantContext, never from the request body.
 *
 * The signing secret is returned in plaintext ONLY by `create` and `rotate` —
 * show-once. Every other response carries a short prefix. Delivery history
 * exposes ids, event types, statuses and safe reason CODES; never a payload.
 */
@ApiTags('Integration Webhooks')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations/webhooks')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationInboundEndpointsController {
  constructor(
    private readonly endpoints: IntegrationWebhookEndpointService,
    private readonly inbound: IntegrationInboundService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Supported inbound event types and signature schemes',
    description:
      '**Protected — `platform.integrations.read`.** The compiled allowlists.',
  })
  @Get('catalog')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  catalog() {
    return {
      events: INBOUND_EVENTS,
      signatureSchemes: WEBHOOK_SIGNATURE_SCHEMES,
      /** What a new endpoint gets when none is chosen. */
      defaultSignatureScheme: DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
      /** Still accepted, but their event id/type headers are not signed (SEC-01). */
      legacySignatureSchemes: LEGACY_WEBHOOK_SIGNATURE_SCHEMES,
    };
  }

  @ApiOperation({
    summary: 'List inbound webhook endpoints',
    description:
      '**Protected — `platform.integrations.read`.** Secret prefix only; never the secret.',
  })
  @Get('endpoints')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  list() {
    return this.endpoints.list(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Create an inbound webhook endpoint',
    description:
      '**Protected — `platform.integrations.manage`.** Returns the signing secret in plaintext ONCE — it cannot be retrieved again.',
  })
  @Post('endpoints')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
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
    summary: 'Get an endpoint',
    description: '**Protected — `platform.integrations.read`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Get('endpoints/:id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.endpoints.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update an endpoint (events, scheme, tolerance, active)',
    description: '**Protected — `platform.integrations.manage`.**',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Patch('endpoints/:id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
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
    summary: 'Rotate the signing secret',
    description:
      '**Protected — `platform.integrations.manage`.** Returns the NEW secret once; deliveries signed with the old secret stop verifying immediately.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Post('endpoints/:id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  rotate(
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
    summary: 'Delete an endpoint',
    description:
      '**Protected — `platform.integrations.manage`.** Delivery history is PRESERVED (its endpoint reference is nulled, not cascaded).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @Delete('endpoints/:id')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
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

  @ApiOperation({
    summary: 'Inbound delivery + rejection history',
    description:
      '**Protected — `platform.integrations.read`.** Safe metadata only — ids, event type, status, reason code. Payloads are never returned.',
  })
  @Get('events')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  events(@Query() query: QueryInboundEventsDto) {
    return this.inbound.list(this.ctx.requireTenantId(), query);
  }
}
