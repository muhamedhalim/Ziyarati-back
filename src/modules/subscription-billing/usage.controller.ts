import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { UsageService } from './usage.service';
import { QueryUsageDto } from './dto/query-usage.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

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

const S_USAGE = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    subscriptionId: { type: 'string', format: 'uuid' },
    periodMonth: { type: 'string', example: '2026-06' },
    aiTokensUsed: { type: 'number', example: 125000 },
    whatsappMessagesUsed: { type: 'number', example: 320 },
    appointmentsUsed: { type: 'number', example: 540 },
    campaignsUsed: { type: 'number', example: 4 },
    updatedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

const S_BREAKDOWN = {
  type: 'object',
  properties: {
    tenantId: { type: 'string', format: 'uuid' },
    periodMonth: { type: 'string', example: '2026-06' },
    planId: { type: 'string', format: 'uuid' },
    planName: { type: 'string', example: 'Professional' },
    metrics: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          used: { type: 'number', example: 320 },
          limit: { type: 'number', nullable: true, example: 5000 },
          remaining: { type: 'number', nullable: true, example: 4680 },
          percentUsed: { type: 'number', nullable: true, example: 6.4 },
          exceeded: { type: 'boolean', example: false },
        },
      },
    },
  },
};

/**
 * Usage statistics per tenant per billing month. Guarded by PermissionsGuard;
 * tenant id from TenantContext. Usage rows are isolated by their `tenant_id`
 * column and resolved via the tenant's own subscription.
 */
@ApiTags('Usage')
@ApiBearerAuth('JWT-auth')
@Controller('usage')
@UseGuards(PermissionsGuard)
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Get usage stats for a billing period',
    description: `
**Protected — requires \`usage.read\`.**

Returns raw usage counters (AI tokens, WhatsApp messages, appointments,
campaigns) for the given \`periodMonth\` (defaults to the current month).

**Who can call this:** Owner, Manager (\`usage.read\`).

**Tenant scoping:** Resolved from the caller's own subscription + \`tenant_id\`.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Usage counters for the period.',
    schema: S_USAGE,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `usage.read`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No active subscription found for this tenant.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.USAGE_READ)
  getUsage(@Query() query: QueryUsageDto) {
    return this.usage.getUsage(this.ctx.requireTenantId(), query.periodMonth);
  }

  @ApiOperation({
    summary: 'Get usage breakdown vs plan limits',
    description: `
**Protected — requires \`usage.read\`.**

Returns each metric's usage against the current plan's limit, with
\`remaining\`, \`percentUsed\`, and an \`exceeded\` flag. A null limit means the
metric is unlimited on the plan. Powers usage meters/progress bars.

**Who can call this:** Owner, Manager (\`usage.read\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Usage vs limits breakdown.',
    schema: S_BREAKDOWN,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `usage.read`.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'No active subscription found for this tenant.',
    schema: S_ERROR,
  })
  @Get('breakdown')
  @RequirePermissions(PERMISSION.USAGE_READ)
  getBreakdown(@Query() query: QueryUsageDto) {
    return this.usage.getBreakdown(
      this.ctx.requireTenantId(),
      query.periodMonth,
    );
  }
}
