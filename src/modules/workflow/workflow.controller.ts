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
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { WorkflowService } from './workflow.service';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowFilterDto } from './dto/workflow-filter.dto';
import {
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_OPERATORS,
  WORKFLOW_TRIGGERS,
} from './workflow.constants';
import { QueueService } from '../../queue/queue.service';

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

const S_WORKFLOW = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    trigger_event: { type: 'string', example: 'appointment.created' },
    is_active: { type: 'boolean', example: true },
    conditions: { type: 'array', items: { type: 'object', additionalProperties: true }, nullable: true },
    actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * Workflow Engine — tenant automations (Event → Conditions → Actions).
 *
 * Guarded by the standard clinic chain (PermissionsGuard + ActiveTenantGuard) and
 * `ai.manage` (the seeded automation permission). The engine executes actions via
 * the existing Email / WhatsApp / Notification / AI services — never inline.
 */
@ApiTags('Workflows')
@ApiBearerAuth('JWT-auth')
@Controller('workflows')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequirePermissions(PERMISSION.AI_MANAGE)
export class WorkflowController {
  constructor(
    private readonly workflows: WorkflowService,
    private readonly ctx: TenantContextService,
    private readonly queue: QueueService,
  ) {}

  @ApiOperation({ summary: 'List available triggers, action types and operators' })
  @ApiOkResponse({ description: 'Static engine metadata for building workflows.' })
  @Get('meta')
  meta() {
    return {
      triggers: WORKFLOW_TRIGGERS,
      actionTypes: WORKFLOW_ACTION_TYPES,
      operators: WORKFLOW_OPERATORS,
    };
  }

  @ApiOperation({ summary: 'Create a workflow' })
  @ApiCreatedResponse({ description: 'Workflow created.', schema: S_WORKFLOW })
  @ApiForbiddenResponse({ description: 'Missing `ai.manage` or clinic inactive.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @Post()
  create(@Body() dto: CreateWorkflowDto) {
    return this.workflows.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List workflows (paginated, filterable)' })
  @ApiOkResponse({ description: 'Paginated workflows.' })
  @Get()
  findAll(@Query() filter: WorkflowFilterDto) {
    return this.workflows.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get a workflow' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Workflow.', schema: S_WORKFLOW })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'List a workflow\'s execution runs (audit)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Paginated runs for the workflow.' })
  @Get(':id/runs')
  runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.workflows.listRuns(
      this.ctx.requireTenantId(),
      id,
      Math.max(1, Number(page) || 1),
      Math.min(100, Math.max(1, Number(limit) || 20)),
    );
  }

  @ApiOperation({ summary: 'Update a workflow' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Workflow updated.', schema: S_WORKFLOW })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkflowDto) {
    return this.workflows.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Manually run a workflow now (test)',
    description: 'Creates a run with the provided context and enqueues its actions — bypasses the trigger, not the conditions.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Run enqueued.' })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(@Param('id', ParseUUIDPipe) id: string, @Body() body: { context?: Record<string, unknown> }) {
    const tenantId = this.ctx.requireTenantId();
    const workflow = await this.workflows.findOne(tenantId, id);
    const context = body?.context ?? {};
    if (!this.workflows.evaluateConditions(workflow.conditions, context)) {
      return { enqueued: false, reason: 'conditions_not_met' };
    }
    const created = await this.workflows.createRun(tenantId, workflow, context);
    await this.queue.enqueueWorkflowRun({ tenantId, runId: created.id });
    return { enqueued: true, runId: created.id };
  }

  @ApiOperation({
    summary: 'Duplicate a workflow',
    description: 'Copies name/trigger/conditions/actions into a NEW, inactive workflow so it can be reviewed before enabling.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Duplicated workflow.', schema: S_WORKFLOW })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.duplicate(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Retry a run\'s failed actions',
    description: 'Re-enqueues every action whose last outcome was FAILED (SUCCEEDED/SKIPPED actions are left untouched).',
  })
  @ApiParam({ name: 'runId', format: 'uuid' })
  @ApiOkResponse({ description: 'Retry enqueued.' })
  @ApiNotFoundResponse({ description: 'Run not found.', schema: S_ERROR })
  @Post('runs/:runId/retry')
  @HttpCode(HttpStatus.OK)
  async retryRun(@Param('runId', ParseUUIDPipe) runId: string) {
    const tenantId = this.ctx.requireTenantId();
    const run = await this.workflows.getOwnedRun(tenantId, runId);
    const failedIndices = this.workflows.failedActionIndices(run);
    if (!failedIndices.length) return { retried: 0, reason: 'no_failed_actions' };

    await this.workflows.reopenForRetry(runId);
    for (const actionIndex of failedIndices) {
      await this.queue.retryWorkflowAction({ tenantId, runId, actionIndex });
    }
    return { retried: failedIndices.length };
  }

  @ApiOperation({ summary: 'Delete a workflow' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Workflow deleted.' })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(this.ctx.requireTenantId(), id);
  }
}
