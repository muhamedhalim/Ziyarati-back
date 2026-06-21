import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { WhatsappAnalyticsService } from './whatsapp-analytics.service';
import { WhatsappAnalyticsFilterDto } from './dto/whatsapp-analytics-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';

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

const S_OVERVIEW = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    totalMessages: { type: 'number', example: 5400 },
    deliveredCount: { type: 'number', example: 5100 },
    readCount: { type: 'number', example: 4200 },
    failedCount: { type: 'number', example: 120 },
    deliveryRate: { type: 'number', example: 94.4 },
    readRate: { type: 'number', example: 77.8 },
    failureRate: { type: 'number', example: 2.2 },
    byStatus: { type: 'object', additionalProperties: { type: 'number' } },
  },
};

/**
 * WhatsApp messaging analytics (computed over notification_logs where
 * channel = WHATSAPP). Guarded by PermissionsGuard + ActiveTenantGuard; all
 * aggregates are tenant-scoped.
 */
@ApiTags('WhatsApp Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('whatsapp/analytics')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('whatsapp')
export class WhatsappAnalyticsController {
  constructor(
    private readonly analytics: WhatsappAnalyticsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Messaging overview',
    description: `**Protected — requires \`whatsapp.analytics.read\`. Clinic must be active.** Totals + delivery/read/failure rates for the tenant's WhatsApp messages, optional date/template filters.`,
  })
  @ApiOkResponse({ description: 'Messaging overview.', schema: S_OVERVIEW })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('overview')
  @RequirePermissions(PERMISSION.WHATSAPP_ANALYTICS_READ)
  overview(@Query() filter: WhatsappAnalyticsFilterDto) {
    return this.analytics.overview(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Template performance',
    description: `**Protected — requires \`whatsapp.analytics.read\`. Clinic must be active.** Per-template message counts with delivered/failed/read breakdown.`,
  })
  @ApiOkResponse({
    description: 'Per-template performance.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        templates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              templateId: { type: 'string' },
              total: { type: 'number' },
              delivered: { type: 'number' },
              read: { type: 'number' },
              failed: { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('templates')
  @RequirePermissions(PERMISSION.WHATSAPP_ANALYTICS_READ)
  templates(@Query() filter: WhatsappAnalyticsFilterDto) {
    return this.analytics.templatePerformance(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Contact engagement',
    description: `**Protected — requires \`whatsapp.analytics.read\`. Clinic must be active.** Top recipients by message volume (engagement), optional date/template filters.`,
  })
  @ApiOkResponse({
    description: 'Top recipients by message count.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        topRecipients: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              recipientType: { type: 'string' },
              recipientId: { type: 'string' },
              messageCount: { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('engagement')
  @RequirePermissions(PERMISSION.WHATSAPP_ANALYTICS_READ)
  engagement(@Query() filter: WhatsappAnalyticsFilterDto) {
    return this.analytics.engagement(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Account usage',
    description: `**Protected — requires \`whatsapp.analytics.read\`. Clinic must be active.** Account inventory (total / active / with credentials) for the tenant.`,
  })
  @ApiOkResponse({
    description: 'Account usage.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        totalAccounts: { type: 'number' },
        activeAccounts: { type: 'number' },
        inactiveAccounts: { type: 'number' },
        accountsWithCredentials: { type: 'number' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('accounts')
  @RequirePermissions(PERMISSION.WHATSAPP_ANALYTICS_READ)
  accounts() {
    return this.analytics.accountUsage(this.ctx.requireTenantId());
  }
}
