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
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { AiKnowledgeBaseService } from './ai-knowledge-base.service';
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from './dto/update-knowledge-base.dto';
import { KnowledgeBaseFilterDto } from './dto/knowledge-base-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';

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

const S_KB = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    content: { type: 'string' },
    source_type: { type: 'string', nullable: true },
    source_id: { type: 'string', format: 'uuid', nullable: true },
    agent: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * AI knowledge base (per-agent content chunks). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 *
 * Schema note: no name/status/enabled column — a row is a knowledge chunk;
 * "search" is keyword over content; "rebuild embeddings" is an abstraction seam.
 */
@ApiTags('AI Knowledge Bases')
@ApiBearerAuth('JWT-auth')
@Controller('ai/knowledge-bases')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('ai')
export class AiKnowledgeBaseController {
  constructor(
    private readonly kb: AiKnowledgeBaseService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Create a knowledge chunk', description: `**Protected — \`ai.knowledge.manage\`. Clinic active.** Adds a content chunk to an agent (validated tenant-scoped).` })
  @ApiCreatedResponse({ description: 'Knowledge chunk created.', schema: S_KB })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.knowledge.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Agent not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.AI_KNOWLEDGE_MANAGE)
  create(@Body() dto: CreateKnowledgeBaseDto) {
    return this.kb.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List / search knowledge chunks', description: `**Protected — \`ai.knowledge.read\`. Clinic active.** Filter by agent and keyword-search content.` })
  @ApiOkResponse({ description: 'Paginated knowledge chunks.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.knowledge.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.AI_KNOWLEDGE_READ)
  findAll(@Query() filter: KnowledgeBaseFilterDto) {
    return this.kb.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Rebuild embeddings (abstraction)', description: `**Protected — \`ai.knowledge.manage\`. Clinic active.** Architecture seam — acknowledges a rebuild request for an agent's chunks (no vector store configured).` })
  @ApiQuery({ name: 'agentId', required: true, description: 'Agent UUID', format: 'uuid' })
  @ApiOkResponse({ description: 'Rebuild accepted.', schema: { type: 'object', properties: { accepted: { type: 'boolean' }, agentId: { type: 'string', format: 'uuid' }, chunks: { type: 'number' } } } })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.knowledge.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Agent not found in this tenant.', schema: S_ERROR })
  @Post('rebuild')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_KNOWLEDGE_MANAGE)
  rebuild(@Query('agentId', ParseUUIDPipe) agentId: string) {
    return this.kb.rebuildEmbeddings(this.ctx.requireTenantId(), agentId);
  }

  @ApiOperation({ summary: 'Get a knowledge chunk', description: `**Protected — \`ai.knowledge.read\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'Knowledge chunk UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Knowledge chunk.', schema: S_KB })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.knowledge.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Knowledge chunk not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.AI_KNOWLEDGE_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.kb.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a knowledge chunk', description: `**Protected — \`ai.knowledge.manage\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'Knowledge chunk UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Knowledge chunk updated.', schema: S_KB })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.knowledge.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Knowledge chunk not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.AI_KNOWLEDGE_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKnowledgeBaseDto) {
    return this.kb.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Delete a knowledge chunk', description: `**Protected — \`ai.knowledge.manage\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'Knowledge chunk UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Knowledge chunk deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.knowledge.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Knowledge chunk not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.AI_KNOWLEDGE_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.kb.remove(this.ctx.requireTenantId(), id);
  }
}
