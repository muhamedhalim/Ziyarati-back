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

import { AiPromptService } from './ai-prompt.service';
import { CreateAiPromptDto } from './dto/create-ai-prompt.dto';
import { UpdateAiPromptDto } from './dto/update-ai-prompt.dto';
import { AiPromptFilterDto } from './dto/ai-prompt-filter.dto';

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

const S_PROMPT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', nullable: true },
    content: { type: 'string' },
    is_active: { type: 'boolean', example: true },
    agent: {
      type: 'object',
      nullable: true,
      properties: { id: { type: 'string', format: 'uuid' } },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * AI prompts. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id from
 * TenantContext. Schema note: no type/version column — prompt type & versioning
 * are not persisted.
 */
@ApiTags('AI Prompts')
@ApiBearerAuth('JWT-auth')
@Controller('ai/prompts')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature(FeatureKey.AI_ASSISTANT)
export class AiPromptController {
  constructor(
    private readonly prompts: AiPromptService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a prompt',
    description: `**Protected — \`ai.prompts.manage\`. Clinic active.** Optional \`agentId\` assigns it to an agent.`,
  })
  @ApiCreatedResponse({ description: 'Prompt created.', schema: S_PROMPT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Agent not found in this tenant.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.AI_PROMPTS_MANAGE)
  create(@Body() dto: CreateAiPromptDto) {
    return this.prompts.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List prompts',
    description: `**Protected — \`ai.prompts.read\`. Clinic active.** Filter by agent/search/active.`,
  })
  @ApiOkResponse({ description: 'Paginated prompts.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.AI_PROMPTS_READ)
  findAll(@Query() filter: AiPromptFilterDto) {
    return this.prompts.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get a prompt',
    description: `**Protected — \`ai.prompts.read\`. Clinic active.**`,
  })
  @ApiParam({
    name: 'id',
    description: 'Prompt UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Prompt details.', schema: S_PROMPT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Prompt not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.AI_PROMPTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.prompts.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a prompt',
    description: `**Protected — \`ai.prompts.manage\`. Clinic active.**`,
  })
  @ApiParam({
    name: 'id',
    description: 'Prompt UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Prompt updated.', schema: S_PROMPT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Prompt not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.AI_PROMPTS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAiPromptDto,
  ) {
    return this.prompts.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Activate a prompt',
    description: `**Protected — \`ai.prompts.manage\`. Clinic active.** Sets \`is_active = true\`.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Prompt UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Prompt activated.', schema: S_PROMPT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Prompt not found.', schema: S_ERROR })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_PROMPTS_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.prompts.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Deactivate a prompt',
    description: `**Protected — \`ai.prompts.manage\`. Clinic active.** Sets \`is_active = false\`.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Prompt UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Prompt deactivated.', schema: S_PROMPT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Prompt not found.', schema: S_ERROR })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_PROMPTS_MANAGE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.prompts.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Delete a prompt',
    description: `**Protected — \`ai.prompts.manage\`. Clinic active.**`,
  })
  @ApiParam({
    name: 'id',
    description: 'Prompt UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Prompt deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `ai.prompts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Prompt not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.AI_PROMPTS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.prompts.remove(this.ctx.requireTenantId(), id);
  }
}
