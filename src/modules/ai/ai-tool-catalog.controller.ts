import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

import { AI_TOOLS } from './tools/ai-tools.constants';
import { AI_ADMIN_TOOLS } from './tools/ai-admin-tools.constants';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/**
 * AI Tool Management (read-only). Surfaces the EXACT tool catalog the model is
 * given every turn (`AI_TOOLS` + `AI_ADMIN_TOOLS`, the same arrays
 * `AiExecutionService` merges into `ALL_TOOLS`) plus the tenant's recent
 * `ai_tool_calls` audit ledger (written by `AiToolDispatchService`) — no new
 * business logic, just visibility into what already runs.
 */
@ApiTags('AI Analytics')
@ApiBearerAuth('JWT-auth')
@Controller('ai/tools')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class AiToolCatalogController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'List the AI tool catalog',
    description: `**Protected — \`ai.analytics.read\`.** The exact tool definitions (name/description/parameters) the model can call this turn — discovery/booking tools (every channel) and the Dashboard Assistant's read-only admin tools (permission-gated per call).`,
  })
  @ApiOkResponse({ description: 'Tool catalog.' })
  @Get('catalog')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  catalog() {
    return {
      bookingAndDiscovery: AI_TOOLS.map((t) => ({ name: t.name, description: t.description })),
      dashboardAssistant: AI_ADMIN_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    };
  }

  @ApiOperation({
    summary: 'Recent tool call audit log',
    description: `**Protected — \`ai.analytics.read\`.** The tenant's most recent tool executions (name, status, appointment linkage, error) from the \`ai_tool_calls\` idempotency ledger.`,
  })
  @ApiOkResponse({ description: 'Recent tool calls.' })
  @Get('calls')
  @RequirePermissions(PERMISSION.AI_ANALYTICS_READ)
  async recentCalls(@Query('limit') limit?: string) {
    const take = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = await this.dataSource.query(
      `SELECT id, tool_name, status, appointment_id, error, created_at, completed_at
         FROM ai_tool_calls
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [this.ctx.requireTenantId(), take],
    );
    return { data: rows };
  }
}
