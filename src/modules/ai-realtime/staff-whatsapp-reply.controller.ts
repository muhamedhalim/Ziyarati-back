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
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { StaffWhatsappReplyService } from './staff-whatsapp-reply.service';
import { StaffWhatsappReplyDto } from './dto/staff-whatsapp-reply.dto';
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

/**
 * Staff reply to a patient over WhatsApp from the inbox.
 *
 * Lives in the ai-realtime module — not beside `MessageController` — because
 * delivering over WhatsApp and reaching the AI session both need modules the
 * conversations module cannot import without a cycle (the same reason as the
 * handover reply). The path still sits under `conversations/:id/…`.
 *
 * `POST /conversations/:id/messages` is unchanged: it saves a message and never
 * sends it. This is the route that sends.
 */
@ApiTags('Conversations')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.WHATSAPP)
@Controller('conversations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class StaffWhatsappReplyController {
  constructor(
    private readonly reply: StaffWhatsappReplyService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Reply to a patient over WhatsApp',
    description: `**Protected — \`messages.send\` and \`whatsapp.send\`. Clinic active, WhatsApp entitled.** Saves the reply on the conversation and sends it to the patient over WhatsApp. If the clinic has an automatic-takeover window (\`aiHumanTakeoverMinutes\` > 0), the AI stays silent on this conversation for that long (\`aiPausedUntil\`); an AI turn already running does not send over the person.

\`dispatchedToWhatsapp: false\` means the reply was saved but WhatsApp did not accept it (the message is marked FAILED). A conversation handed to another agent returns 409; one that is not a WhatsApp conversation returns 422. Another clinic's conversation returns 404.`,
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({
    description: 'Reply saved.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'object' },
        conversationId: { type: 'string', format: 'uuid' },
        dispatchedToWhatsapp: { type: 'boolean' },
        aiPausedUntil: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Conversation not found.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Assigned to another agent.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Not a WhatsApp conversation.',
    schema: S_ERROR,
  })
  @Post(':id/whatsapp-reply')
  @RequirePermissions(PERMISSION.MESSAGES_SEND, PERMISSION.WHATSAPP_SEND)
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StaffWhatsappReplyDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.reply.send(this.ctx.requireTenantId(), userId, id, dto.content);
  }
}
