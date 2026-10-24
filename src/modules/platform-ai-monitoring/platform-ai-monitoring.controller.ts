import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AiMonitoringService } from './ai-monitoring.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLE } from '../../rbac/rbac.constants';

/**
 * Platform AI monitoring — super-admin only (Feature 10). Read-only cross-tenant
 * snapshot of AI requests, tokens, cost, conversations, handover and queue depth,
 * aggregated over the existing AI stores. No duplicated calculations.
 */
@ApiTags('Platform AI Monitoring')
@ApiBearerAuth('JWT-auth')
@Controller('platform/ai-monitoring')
@UseGuards(RolesGuard)
@Roles(ROLE.SUPER_ADMIN)
export class PlatformAiMonitoringController {
  constructor(private readonly monitoring: AiMonitoringService) {}

  @ApiOperation({
    summary: 'Platform-wide AI monitoring snapshot (super-admin)',
    description:
      'Requests, tokens (prompt/completion), cost, conversations (status/channel/active), handover rate, AI queue depth, provider config, and top tenants by tokens/cost — from ai_usage_logs / ai_cost_logs / ai_conversations / handover_requests + the AI queue. Metrics with no schema support (latency, streaming, per-model, revenue) are listed under `notTracked`.',
  })
  @ApiOkResponse({ description: 'AI monitoring snapshot.' })
  @Get('overview')
  overview() {
    return this.monitoring.overview();
  }

  @ApiOperation({
    summary: 'Which AI model is actually in effect (super-admin)',
    description:
      'The saved `ai.default_model` and whether it is an override or the code default, routing flags, how many agents follow the default versus pin their own model, and the last model observed in use. Read-only; never returns keys, message content or tenant identity.',
  })
  @ApiOkResponse({ description: 'Model runtime status.' })
  @Get('model-runtime')
  modelRuntime() {
    return this.monitoring.modelRuntime();
  }
}
