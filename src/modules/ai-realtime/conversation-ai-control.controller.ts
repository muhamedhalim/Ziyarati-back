import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import {
  ConversationAiControlService,
  ConversationAiStatus,
} from '../conversations/conversation-ai-control.service';
import { WhatsappAiPolicyService } from '../whatsapp/whatsapp-ai-policy.service';
import { AiPolicyReason } from '../whatsapp/whatsapp-ai-policy.constants';
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
    statusCode: { type: 'number' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
};

const S_AI_STATUS = {
  type: 'object',
  properties: {
    conversationId: { type: 'string', format: 'uuid' },
    mode: { type: 'string', enum: ['DEFAULT', 'ENABLED', 'DISABLED'] },
    pausedUntil: { type: 'string', format: 'date-time', nullable: true },
    changedAt: { type: 'string', format: 'date-time', nullable: true },
    changedBy: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string', nullable: true },
      },
    },
    ownerType: { type: 'string', enum: ['AI', 'HUMAN'] },
    effective: {
      type: 'object',
      description: 'Would the AI answer the next patient message right now?',
      properties: {
        allowed: { type: 'boolean' },
        reason: {
          type: 'string',
          nullable: true,
          description:
            'Why not — one of SUBSCRIPTION_DISABLED, FEATURE_DISABLED, CLINIC_AI_DISABLED, PATIENT_AI_DISABLED, CONVERSATION_AI_DISABLED, HUMAN_TAKEOVER, NO_CONVERSATION, POLICY_READ_FAILED.',
        },
      },
    },
  },
};

/** What the staff UI receives: the stored state plus the live decision. */
export type ConversationAiStatusView = Omit<
  ConversationAiStatus,
  'customerId'
> & {
  effective: { allowed: boolean; reason: AiPolicyReason | null };
};

/**
 * Per-conversation AI control: pause, resume, and "why is the AI (not)
 * answering here?".
 *
 * Lives in the ai-realtime module — not beside `ConversationController` —
 * because the live `effective` answer comes from `WhatsappAiPolicyService`, and
 * the conversations module cannot import the WhatsApp module without a cycle.
 * The paths still sit under `conversations/:id/…`.
 *
 * The tenant is always the caller's own (`TenantContext`); the conversation id
 * is only ever looked up inside it, so another clinic's id answers 404.
 */
@ApiTags('Conversations')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CONVERSATIONS)
@Controller('conversations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ConversationAiControlController {
  constructor(
    private readonly control: ConversationAiControlService,
    private readonly policy: WhatsappAiPolicyService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: "Get a conversation's WhatsApp AI status",
    description: `**Protected — \`conversations.read\`. Clinic active.** The staff override (\`DEFAULT\`/\`ENABLED\`/\`DISABLED\`), any automatic-takeover deadline, who changed it and when, and \`effective\`: whether the AI would answer the next patient message right now and, if not, the reason. Foreign-tenant conversation returns 404.`,
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'AI status.', schema: S_AI_STATUS })
  @ApiNotFoundResponse({
    description: 'Conversation not found.',
    schema: S_ERROR,
  })
  @Get(':id/ai-status')
  @RequirePermissions(PERMISSION.CONVERSATIONS_READ)
  async status(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationAiStatusView> {
    return this.withEffective(
      await this.control.getStatus(this.ctx.requireTenantId(), id),
    );
  }

  @ApiOperation({
    summary: 'Pause the WhatsApp AI on a conversation',
    description: `**Protected — \`ai.handover.manage\`. Clinic active.** The AI stops answering this conversation; the patient's messages are still received and shown, and staff can still reply. Idempotent. Audited.`,
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Paused.', schema: S_AI_STATUS })
  @ApiNotFoundResponse({
    description: 'Conversation not found.',
    schema: S_ERROR,
  })
  @Post(':id/ai/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  async pause(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<ConversationAiStatusView> {
    return this.withEffective(
      await this.control.pause(this.ctx.requireTenantId(), userId, id),
    );
  }

  @ApiOperation({
    summary: 'Resume the WhatsApp AI on a conversation',
    description: `**Protected — \`ai.handover.manage\`. Clinic active.** Back to the clinic default and ends any automatic-takeover window. Idempotent. Audited. Resuming does not override the clinic, patient or handover rules: \`effective\` reports whether the AI will actually answer.`,
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Resumed.', schema: S_AI_STATUS })
  @ApiNotFoundResponse({
    description: 'Conversation not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description:
      'The conversation is handed over to a person — release it with "Return to AI".',
    schema: S_ERROR,
  })
  @Post(':id/ai/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  async resume(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<ConversationAiStatusView> {
    return this.withEffective(
      await this.control.resume(this.ctx.requireTenantId(), userId, id),
    );
  }

  @ApiOperation({
    summary: 'Assign a conversation to the WhatsApp AI',
    description: `**Protected — \`ai.handover.manage\`. Clinic active.** Marks the conversation as assigned to the AI (\`ENABLED\`). In the clinic's assigned-only mode this is what lets the AI answer; it never overrides the clinic switch, the patient exclusion, the schedule or an active handover — \`effective\` reports whether the AI will actually answer. Ends any automatic-takeover window. Idempotent. Audited.`,
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Assigned to the AI.', schema: S_AI_STATUS })
  @ApiNotFoundResponse({
    description: 'Conversation not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description:
      'The conversation is handed over to a person — release it with "Return to AI".',
    schema: S_ERROR,
  })
  @Post(':id/ai/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  async enable(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<ConversationAiStatusView> {
    return this.withEffective(
      await this.control.enable(this.ctx.requireTenantId(), userId, id),
    );
  }

  /**
   * Reuses the one decision the inbound path takes, so what staff are shown can
   * never drift from what the AI actually does. `explain` does not count as a
   * patient-message decision (no metric, no log line).
   */
  private async withEffective(
    status: ConversationAiStatus,
  ): Promise<ConversationAiStatusView> {
    const { customerId, ...rest } = status;
    const decision = await this.policy.explain(this.ctx.requireTenantId(), {
      conversationId: status.conversationId,
      customerId,
    });
    return {
      ...rest,
      effective: decision.allowed
        ? { allowed: true, reason: null }
        : { allowed: false, reason: decision.reason },
    };
  }
}
