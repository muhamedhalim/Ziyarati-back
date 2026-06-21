import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ConversationAnalyticsService } from './conversation-analytics.service';
import { ConversationAnalyticsFilterDto } from './dto/conversation-analytics-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';

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
 * Conversation & messaging analytics. Guarded by PermissionsGuard +
 * ActiveTenantGuard; every aggregate is tenant-scoped.
 */
@ApiTags('Conversation Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('conversation-analytics')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ConversationAnalyticsController {
  constructor(
    private readonly analytics: ConversationAnalyticsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Conversation metrics overview',
    description: `**Protected — requires \`analytics.read\`. Clinic must be active.** Totals, active count, status breakdown and resolution rate (tenant-scoped, optional date range).`,
  })
  @ApiOkResponse({
    description: 'Conversation overview.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        totalConversations: { type: 'number', example: 870 },
        activeConversations: { type: 'number', example: 120 },
        resolvedConversations: { type: 'number', example: 700 },
        resolutionRate: { type: 'number', example: 80.46 },
        byStatus: { type: 'object', additionalProperties: { type: 'number' } },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('overview')
  @RequirePermissions(PERMISSION.CONVERSATION_ANALYTICS_READ)
  overview(@Query() filter: ConversationAnalyticsFilterDto) {
    return this.analytics.overview(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Message metrics',
    description: `**Protected — requires \`analytics.read\`. Clinic must be active.** Message volume in the period, broken down by sender type.`,
  })
  @ApiOkResponse({
    description: 'Message metrics.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        totalMessages: { type: 'number', example: 5400 },
        bySenderType: { type: 'object', additionalProperties: { type: 'number' }, example: { AGENT: 2600, CUSTOMER: 2700, BOT: 100 } },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('messages')
  @RequirePermissions(PERMISSION.CONVERSATION_ANALYTICS_READ)
  messages(@Query() filter: ConversationAnalyticsFilterDto) {
    return this.analytics.messages_(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Agent performance',
    description: `**Protected — requires \`analytics.read\`. Clinic must be active.** Per-agent messages sent + conversations assigned (tenant-scoped, optional date/agent filter).`,
  })
  @ApiOkResponse({
    description: 'Agent performance.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agentId: { type: 'string', format: 'uuid' },
              messagesSent: { type: 'number' },
              conversationsAssigned: { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('agents')
  @RequirePermissions(PERMISSION.CONVERSATION_ANALYTICS_READ)
  agents(@Query() filter: ConversationAnalyticsFilterDto) {
    return this.analytics.agentPerformance(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Response time & engagement',
    description: `**Protected — requires \`analytics.read\`. Clinic must be active.** Average first-agent-response latency + average messages per conversation (sampled, tenant-scoped, date-bounded).`,
  })
  @ApiOkResponse({
    description: 'Response-time & engagement metrics.',
    schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', format: 'uuid' },
        sampledConversations: { type: 'number' },
        respondedConversations: { type: 'number' },
        averageFirstResponseSeconds: { type: 'number', example: 320 },
        avgMessagesPerConversation: { type: 'number', example: 6.2 },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('response-time')
  @RequirePermissions(PERMISSION.CONVERSATION_ANALYTICS_READ)
  responseTime(@Query() filter: ConversationAnalyticsFilterDto) {
    return this.analytics.responseTime(this.ctx.requireTenantId(), filter);
  }
}
