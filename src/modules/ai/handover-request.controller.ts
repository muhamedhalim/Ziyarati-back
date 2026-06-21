import {
  Body,
  Controller,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { HandoverRequestService } from './handover-request.service';
import { CreateHandoverRequestDto } from './dto/create-handover-request.dto';
import { UpdateHandoverRequestDto } from './dto/update-handover-request.dto';
import { AssignHandoverDto } from './dto/assign-handover.dto';
import { HandoverRequestFilterDto } from './dto/handover-request-filter.dto';

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

const S_HANDOVER = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    reason: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['PENDING', 'ASSIGNED', 'ACCEPTED', 'RESOLVED', 'REJECTED'], example: 'PENDING' },
    conversation: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
    assigned_to: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
    resolved_at: { type: 'string', format: 'date-time', nullable: true },
  },
};

/**
 * Human handover requests (escalate to staff). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext. Lifecycle: PENDING → ASSIGNED
 * → ACCEPTED → RESOLVED, or → REJECTED.
 */
@ApiTags('AI Handover Requests')
@ApiBearerAuth('JWT-auth')
@Controller('ai/handovers')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('ai')
export class HandoverRequestController {
  constructor(
    private readonly handovers: HandoverRequestService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({ summary: 'Create a handover request', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Escalates a messaging conversation (validated tenant-scoped). Optionally flips a linked AI conversation to HANDED_OVER.` })
  @ApiCreatedResponse({ description: 'Handover created (PENDING).', schema: S_HANDOVER })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Conversation not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  create(@Body() dto: CreateHandoverRequestDto) {
    return this.handovers.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({ summary: 'List handover requests', description: `**Protected — \`ai.handover.read\`. Clinic active.** Filter by status/assignee.` })
  @ApiOkResponse({ description: 'Paginated handover requests.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.AI_HANDOVER_READ)
  findAll(@Query() filter: HandoverRequestFilterDto) {
    return this.handovers.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get a handover request', description: `**Protected — \`ai.handover.read\`. Clinic active.**` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover request.', schema: S_HANDOVER })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.AI_HANDOVER_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.handovers.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update handover reason', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Lifecycle uses the action endpoints below.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover updated.', schema: S_HANDOVER })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHandoverRequestDto) {
    return this.handovers.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Assign handover to staff', description: `**Protected — \`ai.handover.manage\`. Clinic active.** PENDING → ASSIGNED (assignee validated tenant-scoped).` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover assigned.', schema: S_HANDOVER })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Handover is already terminal.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Assignee not found in this tenant.', schema: S_ERROR })
  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignHandoverDto) {
    return this.handovers.assign(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Accept a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** ASSIGNED → ACCEPTED.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover accepted.', schema: S_HANDOVER })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Cannot accept from the current status.', schema: S_ERROR })
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  accept(@Param('id', ParseUUIDPipe) id: string) {
    return this.handovers.accept(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Resolve a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** → RESOLVED (sets resolved_at).` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover resolved.', schema: S_HANDOVER })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Handover is already terminal.', schema: S_ERROR })
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.handovers.resolve(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Reject a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** → REJECTED (sets resolved_at).` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover rejected.', schema: S_HANDOVER })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Handover is already terminal.', schema: S_ERROR })
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHandoverRequestDto) {
    return this.handovers.reject(this.ctx.requireTenantId(), id, dto.reason);
  }
}
