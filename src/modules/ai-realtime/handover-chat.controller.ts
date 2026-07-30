import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { AgentPresenceService } from './agent-presence.service';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/**
 * REST fallback for the Agent Inbox's presence panel — the socket (`ai:presence`
 * events) is the live source of truth, but the Inbox needs an initial snapshot
 * before/without a live connection (e.g. first paint).
 */
@ApiTags('Live Agent Handover')
@ApiBearerAuth('JWT-auth')
@Controller('ai-realtime')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class HandoverChatController {
  constructor(
    private readonly presence: AgentPresenceService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Snapshot of agent presence for this tenant',
    description: `**Protected — \`ai.handover.read\`.** Reflects the current Redis-backed presence state (correct across every API replica); live updates arrive over \`ai:presence\`.`,
  })
  @ApiOkResponse({ description: 'Presence per agent.' })
  @Get('presence')
  @RequirePermissions(PERMISSION.AI_HANDOVER_READ)
  presenceSnapshot() {
    return this.presence.snapshot(this.ctx.requireTenantId());
  }
}
