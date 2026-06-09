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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { ConversationService } from './conversation.service';
import { ConversationExecutionService } from './conversation-execution.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { ConversationFilterDto } from './dto/conversation-filter.dto';
import { AssignConversationDto } from './dto/assign-conversation.dto';
import { BulkMessageDto } from './dto/bulk-message.dto';

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

const S_CONVERSATION = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', nullable: true, example: 'support' },
    status: { type: 'string', example: 'OPEN' },
    last_message_at: { type: 'string', format: 'date-time', nullable: true },
    branch: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    customer: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    assigned_to: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_CONVERSATION_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_CONVERSATION },
    total: { type: 'number', example: 87 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * Conversation lifecycle. Guarded by PermissionsGuard + ActiveTenantGuard; tenant
 * id from TenantContext. Archive = ARCHIVED status; delete = permanent (CASCADE).
 */
@ApiTags('Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('conversations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class ConversationController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly execution: ConversationExecutionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a conversation',
    description: `
**Protected — requires \`conversations.manage\`. Clinic must be active.**

Creates a conversation for the tenant (defaults to OPEN, or ASSIGNED if an
assignee is given). Branch/customer/WhatsApp-account/assignee are validated
against the tenant.

**Who can call this:** Owner, Manager, Receptionist (\`conversations.manage\`).

**Tenant scoping:** Stamped with the caller's tenant.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Conversation created.', schema: S_CONVERSATION })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'A referenced branch/customer/account/user is not in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CONVERSATIONS_MANAGE)
  create(@Body() dto: CreateConversationDto) {
    return this.conversations.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Broadcast a message to many conversations',
    description: `
**Protected — requires \`messages.send\`. Clinic must be active.**

Sends the same message to multiple conversations (max 500). Each conversation
is validated to belong to the tenant; per-conversation results are returned so
partial failures are visible. The sender is the authenticated user.

**Who can call this:** Owner, Manager, Receptionist (\`messages.send\`).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Per-conversation send results.',
    schema: {
      type: 'object',
      properties: {
        requested: { type: 'number' },
        sent: { type: 'number' },
        failed: { type: 'number' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              conversationId: { type: 'string', format: 'uuid' },
              success: { type: 'boolean' },
              messageId: { type: 'string', format: 'uuid', nullable: true },
              error: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.send`, or clinic inactive.', schema: S_ERROR })
  @Post('bulk-message')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.MESSAGES_SEND)
  bulkMessage(@Body() dto: BulkMessageDto, @CurrentUser('id') userId: string) {
    return this.execution.sendBulk(this.ctx.requireTenantId(), userId, dto);
  }

  @ApiOperation({
    summary: 'List conversations',
    description: `
**Protected — requires \`conversations.read\`. Clinic must be active.**

Tenant-scoped list with filters (status, type, assignee, customer, branch,
participant, date range), ordered by most recent activity (\`last_message_at\`,
then \`created_at\`).

**Who can call this:** Owner, Manager, Receptionist (\`conversations.read\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated conversations.', schema: S_CONVERSATION_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CONVERSATIONS_READ)
  findAll(@Query() filter: ConversationFilterDto) {
    return this.conversations.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get conversation details', description: `**Protected — \`conversations.read\`. Clinic active.** Foreign-tenant conversation returns 404.` })
  @ApiParam({ name: 'id', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation details.', schema: S_CONVERSATION })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.CONVERSATIONS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a conversation', description: `**Protected — \`conversations.manage\`. Clinic active.** Update type/status/branch. Prefer assign/archive endpoints for those transitions.` })
  @ApiParam({ name: 'id', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation updated.', schema: S_CONVERSATION })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.CONVERSATIONS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConversationDto) {
    return this.conversations.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Assign conversation to an agent', description: `**Protected — \`conversations.manage\`. Clinic active.** Sets the assignee (validated tenant user) and status ASSIGNED.` })
  @ApiParam({ name: 'id', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation assigned.', schema: S_CONVERSATION })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Assignee not found in this tenant.', schema: S_ERROR })
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CONVERSATIONS_MANAGE)
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignConversationDto) {
    return this.conversations.assign(this.ctx.requireTenantId(), id, dto.assignedToUserId);
  }

  @ApiOperation({ summary: 'Archive a conversation', description: `**Protected — \`conversations.manage\`. Clinic active.** Sets status ARCHIVED (hidden from active views; restorable).` })
  @ApiParam({ name: 'id', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation archived.', schema: S_CONVERSATION })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found.', schema: S_ERROR })
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CONVERSATIONS_MANAGE)
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.archive(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Unarchive a conversation', description: `**Protected — \`conversations.manage\`. Clinic active.** Restores an archived conversation to OPEN.` })
  @ApiParam({ name: 'id', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation restored.', schema: S_CONVERSATION })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found.', schema: S_ERROR })
  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CONVERSATIONS_MANAGE)
  unarchive(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.unarchive(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Delete a conversation (permanent)',
    description: `**Protected — \`conversations.manage\`. Clinic active.** Hard-deletes the conversation and (via CASCADE) its participants, messages, attachments and status logs. Use archive to keep history.`,
  })
  @ApiParam({ name: 'id', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Conversation deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Conversation not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.CONVERSATIONS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.remove(this.ctx.requireTenantId(), id);
  }
}
