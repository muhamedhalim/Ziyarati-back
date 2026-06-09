import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { MessageService } from './message.service';
import { ConversationExecutionService } from './conversation-execution.service';
import { MessageStatusService } from './message-status.service';
import { SendMessageDto } from './dto/send-message.dto';
import { UpdateMessageDto } from './dto/update-message.dto';
import { MessageFilterDto } from './dto/message-filter.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

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

const S_MESSAGE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    sender_type: { type: 'string', enum: ['CUSTOMER', 'AGENT', 'BOT', 'SYSTEM'], example: 'AGENT' },
    content: { type: 'string', nullable: true },
    message_type: { type: 'string', example: 'text' },
    sender_user: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_MESSAGE_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_MESSAGE },
    total: { type: 'number', example: 340 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 50 },
  },
};

/**
 * Messages within a conversation. Guarded by PermissionsGuard + ActiveTenantGuard;
 * tenant id from TenantContext. Ordering is guaranteed by `created_at ASC`.
 */
@ApiTags('Messages')
@ApiBearerAuth('JWT-auth')
@Controller('conversations/:conversationId/messages')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class MessageController {
  constructor(
    private readonly messages: MessageService,
    private readonly execution: ConversationExecutionService,
    private readonly status: MessageStatusService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Send a message',
    description: `
**Protected — requires \`messages.send\`. Clinic must be active.**

Creates a message in the conversation transactionally (message + initial SENT
status log + \`last_message_at\` bump). The sender (for \`AGENT\`) is the
authenticated user — never taken from the body. \`text\`/\`system\` require
content; \`image\`/\`file\` carry content on the attachment.

**Who can call this:** Owner, Manager, Receptionist (\`messages.send\`).

**Tenant scoping:** Conversation validated tenant-scoped; message stamped with
the tenant.
    `.trim(),
  })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Message sent.', schema: S_MESSAGE })
  @ApiBadRequestResponse({ description: 'Validation failed / missing content for text.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.send`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.MESSAGES_SEND)
  send(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.execution.sendMessage(this.ctx.requireTenantId(), userId, conversationId, dto);
  }

  @ApiOperation({
    summary: 'Get messages in a conversation',
    description: `**Protected — requires \`messages.read\`. Clinic must be active.** Ordered oldest→newest with sender/type/date filters and pagination.`,
  })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Paginated messages (chronological).', schema: S_MESSAGE_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found in this tenant.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.MESSAGES_READ)
  list(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() filter: MessageFilterDto,
  ) {
    return this.messages.list(this.ctx.requireTenantId(), conversationId, filter);
  }

  @ApiOperation({ summary: 'Get a message + status history', description: `**Protected — \`messages.read\`. Clinic active.** Returns the message and its delivery status history.` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Message with status history.',
    schema: {
      type: 'object',
      properties: {
        message: S_MESSAGE,
        statusHistory: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } } },
        currentStatus: { type: 'string', nullable: true, example: 'SENT' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Message not found in this tenant.', schema: S_ERROR })
  @Get(':messageId')
  @RequirePermissions(PERMISSION.MESSAGES_READ)
  async findOne(
    @Param('conversationId', ParseUUIDPipe) _conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    const tenantId = this.ctx.requireTenantId();
    const message = await this.messages.findOne(tenantId, messageId);
    const statusHistory = await this.status.history(tenantId, messageId);
    return {
      message,
      statusHistory,
      currentStatus: statusHistory.length ? statusHistory[statusHistory.length - 1].status : null,
    };
  }

  @ApiOperation({
    summary: 'Edit a message',
    description: `**Protected — requires \`messages.send\`. Clinic must be active.** Updates message content. Schema note: no \`edited_at\` column, so the edit is not separately audited.`,
  })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Message updated.', schema: S_MESSAGE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.send`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Message not found in this tenant.', schema: S_ERROR })
  @Patch(':messageId')
  @RequirePermissions(PERMISSION.MESSAGES_SEND)
  edit(
    @Param('conversationId', ParseUUIDPipe) _conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: UpdateMessageDto,
  ) {
    return this.messages.edit(this.ctx.requireTenantId(), messageId, dto);
  }

  @ApiOperation({
    summary: 'Mark a message as read',
    description: `**Protected — requires \`messages.read\`. Clinic must be active.** Appends a READ entry to the message status log.`,
  })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Read status recorded.',
    schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', example: 'READ' }, created_at: { type: 'string', format: 'date-time' } } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Message not found in this tenant.', schema: S_ERROR })
  @Post(':messageId/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.MESSAGES_READ)
  markRead(
    @Param('conversationId', ParseUUIDPipe) _conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.execution.markRead(this.ctx.requireTenantId(), messageId);
  }

  @ApiOperation({
    summary: 'Delete a message',
    description: `**Protected — requires \`messages.send\`. Clinic must be active.** Schema note: \`messages\` has no \`deleted_at\` column, so this is a HARD delete (CASCADE removes attachments + status logs).`,
  })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Message deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.send`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Message not found in this tenant.', schema: S_ERROR })
  @Delete(':messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.MESSAGES_SEND)
  remove(
    @Param('conversationId', ParseUUIDPipe) _conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.messages.remove(this.ctx.requireTenantId(), messageId);
  }
}
