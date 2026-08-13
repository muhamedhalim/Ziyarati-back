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

import { AiAgentService } from './ai-agent.service';
import { CreateAiAgentDto } from './dto/create-ai-agent.dto';
import { UpdateAiAgentDto } from './dto/update-ai-agent.dto';
import { AiAgentFilterDto } from './dto/ai-agent-filter.dto';

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
    statusCode: { type: 'number' },
    errorCode: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

const S_AGENT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', nullable: true, example: 'Reception Assistant' },
    model: { type: 'string', nullable: true, example: 'gpt-4o-mini' },
    system_prompt: { type: 'string', nullable: true },
    temperature: { type: 'number', example: 0.2 },
    is_active: { type: 'boolean', example: true },
    branch: {
      type: 'object',
      nullable: true,
      properties: { id: { type: 'string', format: 'uuid' } },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_AGENT_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_AGENT },
    total: { type: 'number', example: 4 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * AI agents. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id from
 * TenantContext. Knowledge bases & prompts are assigned via their own endpoints
 * (by setting `agentId`). Activate/deactivate ↔ `is_active`; delete = soft
 * (archive).
 */
@ApiTags('AI Agents')
@ApiBearerAuth('JWT-auth')
@Controller('ai/agents')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature(FeatureKey.AI_ASSISTANT)
export class AiAgentController {
  constructor(
    private readonly agents: AiAgentService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create an AI agent',
    description: `**Protected — requires \`ai.agents.manage\`. Clinic must be active.** Creates an agent (model, temperature, system instructions). Branch validated tenant-scoped. **Who:** Owner/Manager.`,
  })
  @ApiCreatedResponse({ description: 'Agent created.', schema: S_AGENT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Branch not found in this tenant.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.AI_AGENTS_MANAGE)
  create(@Body() dto: CreateAiAgentDto) {
    return this.agents.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List AI agents',
    description: `**Protected — \`ai.agents.read\`. Clinic active.** Tenant-scoped, filter by search/model/active.`,
  })
  @ApiOkResponse({ description: 'Paginated agents.', schema: S_AGENT_LIST })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.AI_AGENTS_READ)
  findAll(@Query() filter: AiAgentFilterDto) {
    return this.agents.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get agent details',
    description: `**Protected — \`ai.agents.read\`. Clinic active.** Foreign-tenant agent returns 404.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Agent details.', schema: S_AGENT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Agent not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.AI_AGENTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update an AI agent',
    description: `**Protected — \`ai.agents.manage\`. Clinic active.** Updates model/temperature/system instructions/branch.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Agent updated.', schema: S_AGENT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Agent not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.AI_AGENTS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiAgentDto,
  ) {
    return this.agents.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Activate agent',
    description: `**Protected — \`ai.agents.manage\`. Clinic active.** Sets \`is_active = true\`.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Agent activated.', schema: S_AGENT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Agent not found.', schema: S_ERROR })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_AGENTS_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Deactivate agent',
    description: `**Protected — \`ai.agents.manage\`. Clinic active.** Sets \`is_active = false\`.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Agent deactivated.', schema: S_AGENT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Agent not found.', schema: S_ERROR })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_AGENTS_MANAGE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Delete (archive) an agent',
    description: `**Protected — \`ai.agents.manage\`. Clinic active.** Soft-deletes the agent (the entity's \`deleted_at\` = archive). Cascades to its knowledge-base chunks.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Agent archived.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.agents.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Agent not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.AI_AGENTS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.agents.remove(this.ctx.requireTenantId(), id);
  }
}
