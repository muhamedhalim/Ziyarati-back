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
  ApiConflictResponse,
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

import { CampaignService } from './campaign.service';
import { CampaignExecutionService } from './campaign-execution.service';

import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { CampaignQueryDto } from './dto/campaign-query.dto';
import { ScheduleCampaignDto } from './dto/schedule-campaign.dto';
import { LaunchCampaignDto } from './dto/launch-campaign.dto';
import { CancelCampaignDto } from './dto/cancel-campaign.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
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

const S_CAMPAIGN = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['BIRTHDAY', 'HOLIDAY', 'REACTIVATION', 'PROMOTION', 'CUSTOM'], example: 'PROMOTION' },
    name: { type: 'string', example: 'Summer Whitening Promo' },
    status: { type: 'string', enum: ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'], example: 'DRAFT' },
    segment: { type: 'object', nullable: true, additionalProperties: true },
    scheduled_at: { type: 'string', format: 'date-time', nullable: true },
    throttle_per_minute: { type: 'number', example: 30 },
    daily_cap: { type: 'number', nullable: true, example: 1000 },
    monthly_cap: { type: 'number', nullable: true, example: 20000 },
    template: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time', nullable: true },
  },
};

const S_CAMPAIGN_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_CAMPAIGN },
    total: { type: 'number', example: 12 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * Campaign lifecycle. Guarded by PermissionsGuard + ActiveTenantGuard. Tenant id
 * from TenantContext; every campaign belongs to the caller's tenant. CRUD/
 * archive/duplicate are handled by CampaignService; lifecycle transitions
 * (schedule/launch/pause/resume/cancel/retry) by CampaignExecutionService.
 */
@ApiTags('Campaigns')
@ApiBearerAuth('JWT-auth')
@Controller('campaigns')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('campaigns')
export class CampaignController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly execution: CampaignExecutionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a campaign',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Creates a campaign in \`DRAFT\`. Optionally links a WhatsApp template (validated
against the tenant) and an audience \`segment\` (JSONB). Throttle/caps control
delivery pacing for the future execution engine.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).

**Tenant scoping:** Stamped with the caller's tenant; \`created_by\` is the
authenticated user.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Campaign created (DRAFT).', schema: S_CAMPAIGN })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Referenced template not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  create(@Body() dto: CreateCampaignDto, @CurrentUser('id') userId: string) {
    return this.campaigns.create(this.ctx.requireTenantId(), userId, dto);
  }

  @ApiOperation({
    summary: 'List campaigns',
    description: `
**Protected — requires \`campaigns.read\`. Clinic must be active.**

Returns the tenant's campaigns with filters (\`status\`, \`type\`, \`search\`,
\`includeArchived\`), sorting (\`sortBy\`/\`sortOrder\`) and pagination. Archived
(soft-deleted) campaigns are excluded unless \`includeArchived=true\`.

**Who can call this:** Owner, Manager, Receptionist (\`campaigns.read\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated campaigns.', schema: S_CAMPAIGN_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CAMPAIGNS_READ)
  findAll(@Query() query: CampaignQueryDto) {
    return this.campaigns.findAll(this.ctx.requireTenantId(), query);
  }

  @ApiOperation({
    summary: 'Get campaign details',
    description: `**Protected — requires \`campaigns.read\`. Clinic must be active.** A campaign from another tenant (or archived) returns 404.`,
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign details.', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.CAMPAIGNS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a campaign',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Partially updates campaign configuration. Allowed only while the campaign is
editable (\`DRAFT\`/\`SCHEDULED\`/\`PAUSED\`) — 409 otherwise. Status changes use the
dedicated lifecycle endpoints, not this one.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign updated.', schema: S_CAMPAIGN })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Campaign is not in an editable status.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Referenced template not found in this tenant.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaigns.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Delete a campaign (permanent)',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Hard-deletes the campaign and (via CASCADE) its recipients. To keep history,
use **archive** instead.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Campaign deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.remove(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Archive a campaign',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Soft-archives the campaign (sets \`deleted_at\`) so it is hidden from default
lists but preserved for history/analytics. Re-list it with
\`?includeArchived=true\`.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign archived.', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.archive(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Duplicate a campaign',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Clones the campaign's configuration (type, name + " (Copy)", template,
segment, throttle, caps) into a new \`DRAFT\`. Recipients are **not** copied.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Source campaign UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Duplicated campaign (DRAFT).', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Source campaign not found.', schema: S_ERROR })
  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.campaigns.duplicate(this.ctx.requireTenantId(), userId, id);
  }

  // ─────────────────────────── Lifecycle / execution ─────────────────────── //

  @ApiOperation({
    summary: 'Schedule a campaign',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Sets \`scheduled_at\` (must be in the future) and transitions the campaign to
\`SCHEDULED\`. Allowed from \`DRAFT\`/\`SCHEDULED\`/\`PAUSED\` (409 on illegal
transition). This is the produce step a future delayed-queue job hooks into.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign scheduled.', schema: S_CAMPAIGN })
  @ApiBadRequestResponse({ description: 'scheduledAt is not in the future / invalid.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Illegal status transition.', schema: S_ERROR })
  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  schedule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleCampaignDto) {
    return this.execution.schedule(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Launch a campaign immediately',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Transitions the campaign to \`RUNNING\`. By default a campaign with zero
recipients is rejected (422) — pass \`force=true\` to override. This is the
enqueue seam; actual per-recipient delivery is performed by the execution
layer / future worker.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign launched (RUNNING).', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Illegal status transition.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Campaign has no recipients (and force not set).', schema: S_ERROR })
  @Post(':id/launch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  launch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LaunchCampaignDto) {
    return this.execution.launch(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Pause a running campaign',
    description: `**Protected — requires \`campaigns.manage\`. Clinic must be active.** \`RUNNING\` → \`PAUSED\` (409 otherwise).`,
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign paused.', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Illegal status transition.', schema: S_ERROR })
  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  pause(@Param('id', ParseUUIDPipe) id: string) {
    return this.execution.pause(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Resume a paused campaign',
    description: `**Protected — requires \`campaigns.manage\`. Clinic must be active.** \`PAUSED\` → \`RUNNING\` (409 otherwise).`,
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign resumed.', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Illegal status transition.', schema: S_ERROR })
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  resume(@Param('id', ParseUUIDPipe) id: string) {
    return this.execution.resume(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Cancel a campaign',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Transitions a non-terminal campaign to \`CANCELLED\`. \`reason\` is accepted for
audit logging only (no column to persist it).

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Campaign cancelled.', schema: S_CAMPAIGN })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Campaign is already terminal.', schema: S_ERROR })
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelCampaignDto) {
    return this.execution.cancel(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Retry failed deliveries',
    description: `
**Protected — requires \`campaigns.manage\`. Clinic must be active.**

Re-queues the campaign's \`FAILED\` recipients (sets them back to \`QUEUED\`) so
the execution layer / future worker re-attempts delivery. Returns the count
re-queued. Queue-ready: no synchronous mass-send happens here.

**Who can call this:** Owner, Manager (\`campaigns.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Failed recipients re-queued.',
    schema: { type: 'object', properties: { requeued: { type: 'number', example: 12 } } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaigns.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found.', schema: S_ERROR })
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGNS_MANAGE)
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.execution.retryFailed(this.ctx.requireTenantId(), id);
  }
}
