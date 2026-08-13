import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AiMetricsService } from './ai-metrics.service';
import { AiAnalyticsFilterDto } from './dto/ai-analytics-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';

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
 * Advanced AI Monitoring (tenant-scoped). Reads `ai_execution_metrics`, written
 * best-effort by `AiExecutionService` after every turn. Guarded identically to
 * `AiAnalyticsController` (same permission — this is the same "AI Analytics"
 * capability, just a different lens: latency/tool health vs. usage volume).
 */
@ApiTags('AI Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('ai/metrics')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature(FeatureKey.AI_ASSISTANT)
export class AiMetricsController {
  constructor(
    private readonly metrics: AiMetricsService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'AI execution metrics summary',
    description: `**Protected — \`ai.analytics.read\`. Clinic active.** Latency (avg/P50/P95/P99, total + first-token), streaming duration, RAG/embedding/tool timing, tool success/failure rate, error rate, and token/sec.`,
  })
  @ApiOkResponse({ description: 'Execution metrics summary.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.analytics.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('summary')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  summary(@Query() filter: AiAnalyticsFilterDto) {
    return this.metrics.summary(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'AI execution metrics time series',
    description: `**Protected — \`ai.analytics.read\`. Clinic active.** Daily requests, average latency, tokens, and error count — for historical charts.`,
  })
  @ApiOkResponse({ description: 'Daily time series.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.analytics.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('timeseries')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  timeSeries(@Query() filter: AiAnalyticsFilterDto) {
    return this.metrics.timeSeries(this.ctx.requireTenantId(), filter);
  }
}
