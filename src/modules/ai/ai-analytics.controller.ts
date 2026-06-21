import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AiAnalyticsService } from './ai-analytics.service';
import { AiAnalyticsFilterDto } from './dto/ai-analytics-filter.dto';

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

/**
 * AI analytics. Guarded by PermissionsGuard + ActiveTenantGuard; every aggregate
 * is tenant-scoped.
 */
@ApiTags('AI Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('ai/analytics')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('ai')
export class AiAnalyticsController {
  constructor(
    private readonly analytics: AiAnalyticsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Usage analytics', description: `**Protected — \`ai.analytics.read\`. Clinic active.** Token consumption, request counts, monthly trends, top agents (from ai_usage_logs).` })
  @ApiOkResponse({ description: 'Usage analytics.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('usage')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  usage(@Query() filter: AiAnalyticsFilterDto) {
    return this.analytics.usage(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Cost analytics', description: `**Protected — \`ai.analytics.read\`. Clinic active.** Total + monthly spend (from ai_cost_logs; tenant-level — no agent dimension).` })
  @ApiOkResponse({ description: 'Cost analytics.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('cost')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  cost(@Query() filter: AiAnalyticsFilterDto) {
    return this.analytics.cost(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Conversation analytics', description: `**Protected — \`ai.analytics.read\`. Clinic active.** Totals, status mix, total messages, handover & AI-resolution rates, active agents.` })
  @ApiOkResponse({ description: 'Conversation analytics.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('conversations')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  conversations(@Query() filter: AiAnalyticsFilterDto) {
    return this.analytics.conversations(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Agent analytics', description: `**Protected — \`ai.analytics.read\`. Clinic active.** Per-agent tokens/requests + active-agent count.` })
  @ApiOkResponse({ description: 'Agent analytics.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('agents')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  agents(@Query() filter: AiAnalyticsFilterDto) {
    return this.analytics.agents_(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Knowledge analytics', description: `**Protected — \`ai.analytics.read\`. Clinic active.** Knowledge-chunk inventory per agent (retrieval frequency not tracked at schema level).` })
  @ApiOkResponse({ description: 'Knowledge analytics.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.analytics.read`, or clinic inactive.', schema: S_ERROR })
  @Get('knowledge')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  knowledge() {
    return this.analytics.knowledge(this.ctx.requireTenantId());
  }
}
