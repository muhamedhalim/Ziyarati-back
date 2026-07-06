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
import { TransferHandoverDto } from './dto/transfer-handover.dto';
import { HandoverNoteDto } from './dto/handover-note.dto';
import { SendHandoverReplyDto } from './dto/send-handover-reply.dto';
import { HandoverRequestFilterDto } from './dto/handover-request-filter.dto';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
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
 * Live Agent Handover — escalate an AI/messaging conversation to staff, and
 * manage the full human-agent lifecycle around it (assign/accept/transfer/
 * return-to-AI/close, internal notes, agent replies). Guarded by
 * PermissionsGuard + ActiveTenantGuard; tenant id from TenantContext.
 *
 * Lifecycle: PENDING → ASSIGNED → ACCEPTED → RESOLVED, or → REJECTED. Transfer
 * resolves the current request and opens a new one. Return-to-AI resolves the
 * request AND flips the linked AI conversation back to ACTIVE (see
 * `HandoverRequestService.returnToAi` — the actual AI-pause/resume mechanism).
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

  @ApiOperation({ summary: 'Create a handover request', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Escalates a conversation to the Waiting queue and immediately stops the AI (flips the linked AI conversation to HANDED_OVER).` })
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

  @ApiOperation({ summary: 'List agents eligible for assignment/transfer', description: `**Protected — \`ai.handover.read\`. Clinic active.** Tenant users holding \`ai.handover.manage\` (Owner/Manager/Receptionist by default) — not clinical Staff profiles, which only cover bookable practitioners. Powers the Transfer dialog's agent picker.` })
  @ApiOkResponse({ description: 'Eligible agents.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.read`, or clinic inactive.', schema: S_ERROR })
  @Get('agents')
  @RequirePermissions(PERMISSION.AI_HANDOVER_READ)
  listEligibleAgents() {
    return this.handovers.listEligibleAgents(this.ctx.requireTenantId());
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

  @ApiOperation({ summary: 'Accept a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** ASSIGNED → ACCEPTED. Only the assigned agent may accept.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover accepted.', schema: S_HANDOVER })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `ai.handover.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Handover not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Cannot accept from the current status, or assigned to someone else.', schema: S_ERROR })
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.handovers.accept(this.ctx.requireTenantId(), id, userId);
  }

  @ApiOperation({ summary: 'Take over a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Claims a waiting/unassigned handover in one step (assign + accept as the caller).` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover taken over.', schema: S_HANDOVER })
  @ApiConflictResponse({ description: 'Already handled by another agent, or terminal.', schema: S_ERROR })
  @Post(':id/take-over')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  takeOver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.handovers.takeOver(this.ctx.requireTenantId(), id, userId);
  }

  @ApiOperation({ summary: 'Release a handover back to the Waiting queue', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Only the assigned agent may release.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover released.', schema: S_HANDOVER })
  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    return this.handovers.release(this.ctx.requireTenantId(), id, userId);
  }

  @ApiOperation({ summary: 'Transfer a handover to another agent', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Resolves the current request and opens a new ASSIGNED one for the target agent.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'New handover request (ASSIGNED).', schema: S_HANDOVER })
  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  transfer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferHandoverDto, @CurrentUser('id') userId: string) {
    return this.handovers.transfer(this.ctx.requireTenantId(), id, dto, userId);
  }

  @ApiOperation({ summary: 'Return the conversation to AI', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Resolves the handover and flips the linked AI conversation back to ACTIVE — the AI resumes with the FULL history (no new conversation, no memory loss).` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover resolved; AI resumed.', schema: S_HANDOVER })
  @Post(':id/return-to-ai')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  returnToAi(@Param('id', ParseUUIDPipe) id: string) {
    return this.handovers.returnToAi(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Resolve a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** → RESOLVED (sets resolved_at). "Mark Resolved" agent action.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover resolved.', schema: S_HANDOVER })
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  resolve(@Param('id', ParseUUIDPipe) id: string) {
    return this.handovers.resolve(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Reject a handover', description: `**Protected — \`ai.handover.manage\`. Clinic active.** → REJECTED (sets resolved_at); releases the conversation back to the Waiting queue for another agent.` })
  @ApiParam({ name: 'id', description: 'Handover UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Handover rejected.', schema: S_HANDOVER })
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHandoverRequestDto) {
    return this.handovers.reject(this.ctx.requireTenantId(), id, dto.reason);
  }

  // ───────────────────── Conversation-scoped actions ──────────────────────── //

  @ApiOperation({ summary: 'Get the latest handover request for a conversation', description: `**Protected — \`ai.handover.read\`. Clinic active.** Returns null if the conversation was never escalated. The Agent Inbox uses this to resolve the handover id it needs for accept/transfer/etc.` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Latest handover request, or null.', schema: S_HANDOVER })
  @Get('conversations/:conversationId/latest')
  @RequirePermissions(PERMISSION.AI_HANDOVER_READ)
  latestForConversation(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.handovers.findLatestForConversation(this.ctx.requireTenantId(), conversationId);
  }

  @ApiOperation({ summary: 'Send a reply as the assigned agent', description: `**Protected — \`ai.handover.manage\`. Clinic active.** REST fallback for the realtime \`ai:agent:reply\` socket event — same persistence + WhatsApp/web delivery. Only the assigned agent may reply (Conversation Locking).` })
  @ApiParam({ name: 'aiConversationId', description: 'AI conversation UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Message sent.' })
  @ApiConflictResponse({ description: 'Assigned to another agent.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Conversation is not handed over.', schema: S_ERROR })
  @Post('conversations/:aiConversationId/reply')
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  async reply(
    @Param('aiConversationId', ParseUUIDPipe) aiConversationId: string,
    @Body() dto: SendHandoverReplyDto,
    @CurrentUser('id') userId: string,
  ) {
    const { message } = await this.handovers.sendAgentReply(this.ctx.requireTenantId(), userId, aiConversationId, dto.content);
    return message;
  }

  @ApiOperation({ summary: 'Close a conversation', description: `**Protected — \`ai.handover.manage\`. Clinic active.** Sets the conversation CLOSED and resolves any open handover on it.` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation closed.' })
  @Post('conversations/:conversationId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  closeConversation(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.handovers.closeConversation(this.ctx.requireTenantId(), conversationId);
  }

  @ApiOperation({ summary: 'Reopen a closed conversation', description: `**Protected — \`ai.handover.manage\`. Clinic active.**` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation reopened.' })
  @Post('conversations/:conversationId/reopen')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_MANAGE)
  reopenConversation(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.handovers.reopenConversation(this.ctx.requireTenantId(), conversationId);
  }

  @ApiOperation({ summary: 'Mark a conversation as read', description: `**Protected — \`ai.handover.read\`. Clinic active.** Clears the Inbox "unread" indicator for the assigned agent.` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Marked as read.' })
  @Post('conversations/:conversationId/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.AI_HANDOVER_READ)
  async markRead(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    await this.handovers.markConversationRead(this.ctx.requireTenantId(), conversationId);
    return { ok: true };
  }

  @ApiOperation({ summary: 'Add an internal note', description: `**Protected — \`crm.notes.manage\`. Clinic active.** Staff-only — never visible to the customer. Stored as a first-class CRM note against the conversation's customer.` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Note added.' })
  @ApiUnprocessableEntityResponse({ description: 'Conversation has no customer profile.', schema: S_ERROR })
  @Post('conversations/:conversationId/notes')
  @RequirePermissions(PERMISSION.CRM_NOTES_MANAGE)
  addNote(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: HandoverNoteDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.handovers.addNote(this.ctx.requireTenantId(), userId, conversationId, dto);
  }

  @ApiOperation({ summary: 'List internal notes for a conversation', description: `**Protected — \`crm.notes.read\`. Clinic active.**` })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Internal notes, newest first.' })
  @Get('conversations/:conversationId/notes')
  @RequirePermissions(PERMISSION.CRM_NOTES_READ)
  listNotes(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.handovers.listNotes(this.ctx.requireTenantId(), conversationId);
  }
}
