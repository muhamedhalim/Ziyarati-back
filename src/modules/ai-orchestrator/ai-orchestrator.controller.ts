import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { AiOrchestratorService } from './ai-orchestrator.service';
import { ConversationSessionService } from './conversation-session.service';
import { OrchestrateMessageDto, PatchSessionDto } from './dto/orchestrate-message.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/**
 * AI Orchestrator — the single cross-channel entry point (Phase 2).
 *
 * Reuses the existing AI guard chain (permissions + active tenant + active
 * subscription + `ai` feature flag). The heavy lifting lives in
 * `AiOrchestratorService` → `AiExecutionService`; this controller stays thin and
 * never touches a provider.
 */
@ApiTags('AI Orchestrator')
@ApiBearerAuth('JWT-auth')
@Controller('ai/orchestrator')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('ai')
export class AiOrchestratorController {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly sessions: ConversationSessionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Route an AI turn through the orchestrator (any channel)',
    description:
      'The single entry point for AI execution. Resolves/creates a channel-scoped conversation, maintains active session state, then delegates to the existing RAG + tool-calling engine (booking, usage/cost metering reused — never duplicated). Returns a unified envelope with the reply, session and usage.',
  })
  @ApiCreatedResponse({ description: 'Assistant reply + session + usage.' })
  @Post('message')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  message(@Body() dto: OrchestrateMessageDto) {
    return this.orchestrator.handle(this.ctx.requireTenantId(), {
      channel: dto.channel,
      content: dto.content,
      idempotencyKey: dto.idempotencyKey,
      aiConversationId: dto.aiConversationId,
      agentId: dto.agentId,
      conversationId: dto.conversationId,
      language: dto.language,
      device: dto.device,
      timezone: dto.timezone,
      autoRoute: dto.autoRoute,
      useMemory: dto.useMemory,
      sessionPatch: dto.sessionPatch,
    });
  }

  @ApiOperation({
    summary: 'Get active conversation session state',
    description: 'The short-term active state (selected clinic/branch/doctor, current intent, language, booking draft, auth state, context) for the conversation.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Session state.' })
  @Get(':id/session')
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_READ)
  getSession(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Patch active conversation session state',
    description: 'Shallow-merges session updates (e.g. the user selected a clinic/branch/doctor in the UI) without sending a message.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Merged session state.' })
  @Patch(':id/session')
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  patchSession(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PatchSessionDto) {
    return this.sessions.patch(this.ctx.requireTenantId(), id, dto.session);
  }
}
