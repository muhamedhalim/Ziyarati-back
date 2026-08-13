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

import { ConversationParticipantService } from './conversation-participant.service';
import { AddParticipantDto } from './dto/add-participant.dto';
import { UpdateParticipantDto } from './dto/update-participant.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
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

const S_PARTICIPANT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        full_name: { type: 'string', nullable: true },
      },
    },
    joined_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * Conversation participants (staff users). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant isolation is enforced through the conversation.
 *
 * Schema note: `conversation_participants` has no role/status/left_at column —
 * role is derived from the user's RBAC role; "remove" deletes the row.
 */
@ApiTags('Conversation Participants')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.CONVERSATIONS)
@Controller('conversations/:conversationId/participants')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class ConversationParticipantController {
  constructor(
    private readonly participants: ConversationParticipantService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Add a participant',
    description: `
**Protected — requires \`participants.manage\`. Clinic must be active.**

Adds a staff user as a participant (idempotent — a duplicate returns 409). The
user is validated against the tenant.

**Who can call this:** Owner, Manager, Receptionist (\`participants.manage\`).

**Tenant scoping:** Conversation ownership verified; user validated tenant-scoped.
    `.trim(),
  })
  @ApiParam({
    name: 'conversationId',
    description: 'Conversation UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({
    description: 'Participant added.',
    schema: S_PARTICIPANT,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `participants.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Conversation not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'User is already a participant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'User not found in this tenant.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.PARTICIPANTS_MANAGE)
  add(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: AddParticipantDto,
  ) {
    return this.participants.add(
      this.ctx.requireTenantId(),
      conversationId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'List participants',
    description: `**Protected — requires \`participants.manage\`. Clinic must be active.** Lists the conversation's participants (with join timestamps).`,
  })
  @ApiParam({
    name: 'conversationId',
    description: 'Conversation UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Participants.',
    schema: { type: 'array', items: S_PARTICIPANT },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `participants.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Conversation not found in this tenant.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.PARTICIPANTS_MANAGE)
  list(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    return this.participants.list(this.ctx.requireTenantId(), conversationId);
  }

  @ApiOperation({
    summary: 'Update participant role/status (schema-limited)',
    description: `
**Protected — requires \`participants.manage\`. Clinic must be active.**

⚠️ The finalized \`conversation_participants\` table has **no role/status
column**, so role/status cannot be persisted. This endpoint always returns
**422** with an explanation — a participant's role is derived from the user's
RBAC role. Documented for API completeness / forward compatibility.
    `.trim(),
  })
  @ApiParam({
    name: 'conversationId',
    description: 'Conversation UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'participantId',
    description: 'Participant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `participants.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Conversation not found in this tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Role/status is not persisted by the current schema.',
    schema: S_ERROR,
  })
  @Patch(':participantId')
  @RequirePermissions(PERMISSION.PARTICIPANTS_MANAGE)
  update(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
    @Body() _dto: UpdateParticipantDto,
  ) {
    return this.participants.update(
      this.ctx.requireTenantId(),
      conversationId,
      participantId,
    );
  }

  @ApiOperation({
    summary: 'Remove a participant',
    description: `**Protected — requires \`participants.manage\`. Clinic must be active.** Removes the participant (no \`left_at\` column exists, so the row is deleted).`,
  })
  @ApiParam({
    name: 'conversationId',
    description: 'Conversation UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiParam({
    name: 'participantId',
    description: 'Participant UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Participant removed.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `participants.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Conversation or participant not found in this tenant.',
    schema: S_ERROR,
  })
  @Delete(':participantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.PARTICIPANTS_MANAGE)
  remove(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('participantId', ParseUUIDPipe) participantId: string,
  ) {
    return this.participants.remove(
      this.ctx.requireTenantId(),
      conversationId,
      participantId,
    );
  }
}
