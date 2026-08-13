import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { WebhookDeliveryService } from './webhook-delivery.service';
import { QueryWebhookDeliveriesDto } from './dto/query-webhook-deliveries.dto';

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
  },
};

/**
 * Outbound webhook delivery history + manual replay. Tenant-scoped and
 * DB-row-driven throughout — never exposes or accepts a raw BullMQ jobId, so
 * one tenant can never inspect or replay another tenant's delivery.
 */
@ApiTags('Platform Webhooks (Outbound)')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/webhooks/deliveries')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WebhookDeliveryController {
  constructor(
    private readonly deliveries: WebhookDeliveryService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List webhook delivery history',
    description:
      '**Protected — `platform.webhooks-outbound.read`. Clinic active.** Filterable by endpoint/status; paginated.',
  })
  @ApiOkResponse({ description: 'Paginated delivery history.' })
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
  list(@Query() query: QueryWebhookDeliveriesDto) {
    return this.deliveries.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get a webhook delivery',
    description:
      "**Protected — `platform.webhooks-outbound.read`. Clinic active.** Another tenant's delivery returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook delivery UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Webhook delivery detail.' })
  @ApiNotFoundResponse({
    description: 'Not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Manually replay a failed/dead-lettered delivery',
    description:
      '**Protected — `platform.webhooks-outbound.manage`. Clinic active.** Creates a NEW delivery (linked via `replayedFromId`) with the exact original event type/payload and a fresh attempt budget — the original delivery keeps its terminal status untouched. Requires the endpoint to be active. Delivery is at-least-once: receivers should dedupe on `X-Webhook-Id`.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook delivery UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Delivery re-queued.' })
  @ApiNotFoundResponse({
    description: 'Not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Delivery is not in a replayable state, or its endpoint is disabled.',
    schema: S_ERROR,
  })
  @Post(':id/replay')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_OUTBOUND_MANAGE)
  replay(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.deliveries.replay(this.ctx.requireTenantId(), id, {
      userId,
      ip,
    });
  }
}
