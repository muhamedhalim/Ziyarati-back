import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AiConversationService } from './ai-conversation.service';
import { AiExecutionService } from './ai-execution.service';
import { AiMessageService } from './ai-message.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ConversationFilterDto } from './dto/conversation-filter.dto';
import { SendMessageDto } from './dto/send-message.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';

/** Pagination for history endpoint. */
class HistoryQueryDto {
  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 200.', example: 50, minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

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
    status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'HANDED_OVER', 'ARCHIVED'], example: 'ACTIVE' },
    agent: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    conversation: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_SEND_RESULT = {
  type: 'object',
  properties: {
    message: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        role: { type: 'string', example: 'assistant' },
        content: { type: 'string' },
        tokens_used: { type: 'number' },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
    retrievedChunks: { type: 'number', example: 3 },
    usage: {
      type: 'object',
      properties: {
        promptTokens: { type: 'number' },
        completionTokens: { type: 'number' },
        totalTokens: { type: 'number' },
      },
    },
    fallback: { type: 'boolean', example: true, description: 'True when produced by the no-op provider (no real LLM configured).' },
  },
};

/**
 * AI conversations + the RAG message turn. Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 */
@ApiTags('AI Conversations')
@ApiBearerAuth('JWT-auth')
@Controller('ai/conversations')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class AiConversationController {
  constructor(
    private readonly conversations: AiConversationService,
    private readonly execution: AiExecutionService,
    private readonly messages: AiMessageService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Start an AI conversation', description: `**Protected — \`ai.conversations.manage\`. Clinic active.** Creates an ACTIVE session, optionally bound to an agent + messaging conversation (validated tenant-scoped).` })
  @ApiCreatedResponse({ description: 'Conversation started.', schema: S_CONVERSATION })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Agent or linked conversation not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  start(@Body() dto: CreateConversationDto) {
    return this.conversations.start(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List AI conversations', description: `**Protected — \`ai.conversations.read\`. Clinic active.** Filter by status/agent.` })
  @ApiOkResponse({ description: 'Paginated AI conversations.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_READ)
  findAll(@Query() filter: ConversationFilterDto) {
    return this.conversations.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get an AI conversation', description: `**Protected — \`ai.conversations.read\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'AI conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'AI conversation.', schema: S_CONVERSATION })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'AI conversation not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Send a message (RAG turn)',
    description: `
**Protected — requires \`ai.conversations.manage\`. Clinic must be active.**

Runs the RAG pipeline transactionally: persists the user message → retrieves
knowledge context for the agent → assembles the prompt → calls the provider
abstraction (no-op fallback by default) → persists the assistant message →
records usage + cost. 422 if the conversation is not ACTIVE.
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'AI conversation UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Assistant reply + usage.', schema: S_SEND_RESULT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'AI conversation not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Conversation is not ACTIVE.', schema: S_ERROR })
  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  send(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.execution.sendMessage(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Get conversation history', description: `**Protected — \`ai.conversations.read\`. Clinic active.** Chronological messages (paginated).` })
  @ApiParam({ name: 'id', description: 'AI conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Paginated message history.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'AI conversation not found.', schema: S_ERROR })
  @Get(':id/messages')
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_READ)
  history(@Param('id', ParseUUIDPipe) id: string, @Query() query: HistoryQueryDto) {
    return this.messages.history(this.ctx.requireTenantId(), id, query.page, query.limit);
  }

  @ApiOperation({ summary: 'Close a conversation', description: `**Protected — \`ai.conversations.manage\`. Clinic active.** Sets status COMPLETED.` })
  @ApiParam({ name: 'id', description: 'AI conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation closed.', schema: S_CONVERSATION })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'AI conversation not found.', schema: S_ERROR })
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.close(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Archive a conversation', description: `**Protected — \`ai.conversations.manage\`. Clinic active.** Sets status ARCHIVED.` })
  @ApiParam({ name: 'id', description: 'AI conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation archived.', schema: S_CONVERSATION })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.conversations.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'AI conversation not found.', schema: S_ERROR })
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_CONVERSATIONS_MANAGE)
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.archive(this.ctx.requireTenantId(), id);
  }
}
