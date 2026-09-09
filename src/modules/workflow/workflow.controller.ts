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
  WORKFLOW_EMAIL_TEMPLATE_KEYS,
  WORKFLOW_OPERATORS,
  WORKFLOW_RECIPIENT_TYPES,
  WORKFLOW_TRIGGERS,
} from './workflow.constants';
import { WorkflowRecipientResolver } from './workflow-recipient.resolver';
import { QueueService } from '../../queue/queue.service';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
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

const S_WORKFLOW = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    trigger_event: { type: 'string', example: 'appointment.created' },
    is_active: { type: 'boolean', example: true },
    conditions: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
      nullable: true,
    },
    actions: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * Workflow Engine — tenant automations (Event → Conditions → Actions).
 *
 * Guarded by the standard clinic chain (PermissionsGuard + ActiveTenantGuard) and
 * `ai.manage` (the seeded automation permission). The engine executes actions via
 * the existing Email / WhatsApp services — never inline.
 */
@ApiTags('Workflows')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.AUTOMATIONS)
@Controller('workflows')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequirePermissions(PERMISSION.AI_MANAGE)
export class WorkflowController {
  constructor(
    private readonly workflows: WorkflowService,
    private readonly ctx: TenantContextService,
    private readonly queue: QueueService,
    private readonly recipients: WorkflowRecipientResolver,
  ) {}

  @ApiOperation({
    summary:
      'List available triggers, action types, operators, recipient types and email templates',
  })
  @ApiOkResponse({
    description: 'Static engine metadata for building workflows.',
  })
  @Get('meta')
  meta() {
    return {
      triggers: WORKFLOW_TRIGGERS,
      actionTypes: WORKFLOW_ACTION_TYPES,
      operators: WORKFLOW_OPERATORS,
      recipientTypes: WORKFLOW_RECIPIENT_TYPES,
      emailTemplates: WORKFLOW_EMAIL_TEMPLATE_KEYS,
    };
  }

  @ApiOperation({ summary: 'Create a workflow' })
  @ApiCreatedResponse({ description: 'Workflow created.', schema: S_WORKFLOW })
  @ApiForbiddenResponse({
    description: 'Missing `ai.manage` or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
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

  @ApiOperation({ summary: "List a workflow's execution runs (audit)" })
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
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.workflows.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Manually run a workflow now (Test Run — always a dry run)',
    description:
      'Creates a run and enqueues its actions for real — bypasses the trigger, not the conditions. ALWAYS a ' +
      "dry run: the run's context is seeded from one of the tenant's own existing customers/staff (never an " +
      'id the caller supplies), and its EMAIL/WHATSAPP actions resolve their recipient and render their ' +
      'content for real but never call the provider. Poll `GET /workflows/runs/:runId` for the result.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Run enqueued (or not, with a reason).' })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(@Param('id', ParseUUIDPipe) id: string) {
    const tenantId = this.ctx.requireTenantId();
    const workflow = await this.workflows.findOne(tenantId, id);
    const sample = await this.recipients.pickSampleContext(tenantId);
    const context: Record<string, unknown> = { ...sample };
    if (!this.workflows.evaluateConditions(workflow.conditions, context)) {
      return { enqueued: false, reason: 'conditions_not_met' };
    }
    const created = await this.workflows.createRunWithOutbox(
      tenantId,
      workflow,
      context,
      this.ctx.getCorrelationId() ?? undefined,
      /* dryRun */ true,
    );
    return { enqueued: true, runId: created.id };
  }

  @ApiOperation({
    summary: 'Get one run (for polling a Test Run to completion)',
    description:
      'Tenant-scoped — returns 404 for a run belonging to another tenant.',
  })
  @ApiParam({ name: 'runId', format: 'uuid' })
  @ApiOkResponse({
    description: 'The run, with its current status and per-action results.',
  })
  @ApiNotFoundResponse({ description: 'Run not found.', schema: S_ERROR })
  @Get('runs/:runId')
  getRun(@Param('runId', ParseUUIDPipe) runId: string) {
    return this.workflows.getOwnedRun(this.ctx.requireTenantId(), runId);
  }

  @ApiOperation({
    summary: 'Duplicate a workflow',
    description:
      'Copies name/trigger/conditions/actions into a NEW, inactive workflow so it can be reviewed before enabling.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({
    description: 'Duplicated workflow.',
    schema: S_WORKFLOW,
  })
  @ApiNotFoundResponse({ description: 'Workflow not found.', schema: S_ERROR })
  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.duplicate(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: "Retry a run's failed actions",
    description:
      'Re-enqueues every action whose last outcome was FAILED (SUCCEEDED/SKIPPED actions are left untouched).',
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
    if (!failedIndices.length)
      return { retried: 0, reason: 'no_failed_actions' };

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
