import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
} from '@nestjs/swagger';

import { ApiLogService } from './api-log.service';
import { QueryApiLogsDto } from './dto/query-api-logs.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
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
 * API request logs (read-only observability). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 */
@ApiTags('Platform API Logs')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/api-logs')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class ApiLogController {
  constructor(
    private readonly logs: ApiLogService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List / filter API logs',
    description:
      '**Protected — `platform.api-logs.read`. Clinic active.** Tenant-scoped, with endpoint/method/status/date filters, sort + pagination.',
  })
  @ApiOkResponse({ description: 'Paginated API logs.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.api-logs.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.PLATFORM_API_LOGS_READ)
  list(@Query() query: QueryApiLogsDto) {
    return this.logs.list(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'API usage statistics',
    description:
      '**Protected — `platform.api-logs.read`. Clinic active.** Consumption metrics: total requests, avg response time, error rate, breakdown by method/status.',
  })
  @ApiOkResponse({ description: 'Usage statistics.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.api-logs.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get('stats')
  @RequirePermissions(PERMISSION.PLATFORM_API_LOGS_READ)
  stats() {
    return this.logs.stats(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get API log details',
    description:
      "**Protected — `platform.api-logs.read`. Clinic active.** Another tenant's log returns 404.",
  })
  @ApiParam({
    name: 'id',
    description: 'API log UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'API log details.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `platform.api-logs.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'API log not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.PLATFORM_API_LOGS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.logs.get(this.ctx.requireTenantId(), id);
  }
}
