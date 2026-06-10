import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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

import { WebhookLogService } from './webhook-log.service';
import { QueryWebhookLogsDto } from './dto/query-webhook-logs.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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
 * Webhook logs (auditing + processing visibility). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 */
@ApiTags('Platform Webhook Logs')
@ApiBearerAuth('JWT-auth')
@Controller('platform/webhook-logs')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WebhookLogController {
  constructor(
    private readonly logs: WebhookLogService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'List webhook logs', description: '**Protected — `platform.webhooks.read`. Clinic active.** Tenant-scoped, with source/event/status/date filters + pagination.' })
  @ApiOkResponse({ description: 'Paginated webhook logs.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.webhooks.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_READ)
  list(@Query() query: QueryWebhookLogsDto) {
    return this.logs.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({ summary: 'Get webhook log details', description: '**Protected — `platform.webhooks.read`. Clinic active.** Includes the stored payload + error. Another tenant\'s log returns 404.' })
  @ApiParam({ name: 'id', description: 'Webhook log UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Webhook log details.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.webhooks.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Webhook log not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.logs.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Retry a failed webhook', description: '**Protected — `platform.webhooks.manage`. Clinic active.** Re-queues the webhook (status → PENDING) for a future processor. A successful webhook returns 422.' })
  @ApiParam({ name: 'id', description: 'Webhook log UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Webhook re-queued.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `platform.webhooks.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Webhook log not found in this tenant.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'A successful webhook cannot be retried.', schema: S_ERROR })
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_WEBHOOKS_MANAGE)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.logs.retry(this.ctx.requireTenantId(), id);
  }
}
