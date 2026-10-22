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
import {
  OrchestrateMessageDto,
  PatchSessionDto,
} from './dto/orchestrate-message.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { AppError, ErrorCode } from '../../common/errors';
import { AiWsRateLimitService } from '../ai-realtime/ai-ws-rate-limit.service';

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
@RequireFeature(FeatureKey.AI_ASSISTANT)
export class AiOrchestratorController {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly sessions: ConversationSessionService,
    private readonly ctx: TenantContextService,
    private readonly turnLimit: AiWsRateLimitService,
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
  async message(@Body() dto: OrchestrateMessageDto) {
    const tenantId = this.ctx.requireTenantId();
    // RL-11: the same per-user turn budget the `/ai` socket enforces, keyed on
    // the same identity (the authenticated user id), so REST and socket turns
    // draw from ONE allowance instead of REST being unlimited.
    const userId = this.ctx.getUser()?.id;
    if (userId) {
      const decision = await this.turnLimit.checkAndRecord(
        userId,
        'authenticated',
      );
      if (!decision.allowed) {
        throw new AppError(decision.code ?? ErrorCode.RATE_LIMITED, {
          message:
            decision.code === ErrorCode.SERVICE_UNAVAILABLE
              ? 'The AI assistant is temporarily unavailable. Please try again shortly.'
              : 'Too many AI messages. Please wait a moment and try again.',
        });
      }
    }
    return this.orchestrator.handle(tenantId, {
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
    description:
      'The short-term active state (selected clinic/branch/doctor, current intent, language, booking draft, auth state, context) for the conversation.',
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
    description:
      'Shallow-merges client-owned session updates (current intent, language, booking draft, device/timezone, working context) without sending a message. Server-owned keys are ignored: the guest ownership binding, the resolved `selected*` booking state, the channel history, the active agent role, and `context.customerId` — those are written only by validated server code.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Merged session state.' })
  @Patch(':id/session')
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  patchSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchSessionDto,
  ) {
    return this.sessions.patchFromClient(
      this.ctx.requireTenantId(),
      id,
      dto.session,
    );
  }
}
