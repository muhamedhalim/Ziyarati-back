import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { HandoverChatService } from './handover-chat.service';
import { SendHandoverReplyDto } from '../ai/dto/send-handover-reply.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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
    success: { type: 'boolean', example: false },
    statusCode: { type: 'number', example: 409 },
    code: { type: 'string', example: 'CONFLICT' },
    message: { type: 'string' },
  },
};

/**
 * REST fallback for the realtime `ai:agent:reply` socket event.
 *
 * Lives in the ai-realtime module — not next to the rest of `ai/handovers/*` in
 * `HandoverRequestController` — because delivering an agent's reply over
 * WhatsApp needs `HandoverChatService`, which depends on the WhatsApp module,
 * and `AiModule` cannot import that module without a cycle. The path is
 * unchanged, so clients are unaffected.
 *
 * It used to call `HandoverRequestService.sendAgentReply` directly: the reply
 * was saved to the timeline and the AI history, but never sent to the patient.
 * Going through `HandoverChatService` makes the REST path and the socket path
 * the same one — one persistence, one WhatsApp dispatch.
 */
@ApiTags('AI Handover Requests')
@ApiBearerAuth('JWT-auth')
@Controller('ai/handovers')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature(FeatureKey.AI_ASSISTANT)
export class HandoverReplyController {
  constructor(
    private readonly handoverChat: HandoverChatService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Send a reply as the assigned agent',
    description: `**Protected — \`ai.handover.manage\`. Clinic active.** REST fallback for the realtime \`ai:agent:reply\` socket event — same persistence + WhatsApp/web delivery (for a WhatsApp conversation the reply is sent to the patient over WhatsApp). Only the assigned agent may reply (Conversation Locking).`,
  })
  @ApiParam({
    name: 'aiConversationId',
    description: 'AI conversation UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({ description: 'Message sent.' })
  @ApiConflictResponse({
    description: 'Assigned to another agent.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Conversation is not handed over.',
    schema: S_ERROR,
  })
  @Post('conversations/:aiConversationId/reply')
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  async reply(
    @Param('aiConversationId', ParseUUIDPipe) aiConversationId: string,
    @Body() dto: SendHandoverReplyDto,
    @CurrentUser('id') userId: string,
  ) {
    const { message } = await this.handoverChat.sendAgentReply(
      this.ctx.requireTenantId(),
      userId,
      aiConversationId,
      dto.content,
    );
    return message;
  }
}
