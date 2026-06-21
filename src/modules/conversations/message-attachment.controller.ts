import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
} from '@nestjs/swagger';

import { MessageAttachmentService } from './message-attachment.service';
import { CreateMessageAttachmentDto } from './dto/create-message-attachment.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';

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

const S_ATTACHMENT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    file_url: { type: 'string', nullable: true },
    file_type: { type: 'string', nullable: true, example: 'image/jpeg' },
    file_name: { type: 'string', nullable: true, example: 'xray.jpg' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/**
 * Message attachment metadata (no file storage). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext. Mounted under the message
 * (message is tenant-scoped directly).
 */
@ApiTags('Message Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('messages/:messageId/attachments')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class MessageAttachmentController {
  constructor(
    private readonly attachments: MessageAttachmentService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Add attachment metadata',
    description: `
**Protected — requires \`attachments.manage\`. Clinic must be active.**

Records attachment metadata (URL/type/name) for a message. No file storage is
implemented — upload the file to your storage provider first, then register
the metadata here.

**Who can call this:** Owner, Manager, Receptionist (\`attachments.manage\`).

**Tenant scoping:** Message validated tenant-scoped; attachment stamped with
the tenant.
    `.trim(),
  })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Attachment metadata stored.', schema: S_ATTACHMENT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `attachments.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Message not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.ATTACHMENTS_MANAGE)
  add(
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: CreateMessageAttachmentDto,
  ) {
    return this.attachments.add(this.ctx.requireTenantId(), messageId, dto);
  }

  @ApiOperation({
    summary: 'Get attachments for a message',
    description: `**Protected — requires \`messages.read\`. Clinic must be active.** Lists attachment metadata for the message.`,
  })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Attachments.', schema: { type: 'array', items: S_ATTACHMENT } })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Message not found in this tenant.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.MESSAGES_READ)
  list(@Param('messageId', ParseUUIDPipe) messageId: string) {
    return this.attachments.listByMessage(this.ctx.requireTenantId(), messageId);
  }

  @ApiOperation({
    summary: 'Get download access for an attachment',
    description: `
**Protected — requires \`messages.read\`. Clinic must be active.**

Returns a time-limited access descriptor (download abstraction). No storage
provider is implemented — a real adapter would mint a signed URL here.
    `.trim(),
  })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Download access descriptor.',
    schema: {
      type: 'object',
      properties: {
        attachmentId: { type: 'string', format: 'uuid' },
        fileName: { type: 'string', nullable: true },
        fileType: { type: 'string', nullable: true },
        url: { type: 'string', nullable: true },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `messages.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Attachment not found in this tenant.', schema: S_ERROR })
  @Get(':attachmentId/download')
  @RequirePermissions(PERMISSION.MESSAGES_READ)
  download(
    @Param('messageId', ParseUUIDPipe) _messageId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.attachments.downloadAccess(this.ctx.requireTenantId(), attachmentId);
  }

  @ApiOperation({
    summary: 'Delete an attachment',
    description: `**Protected — requires \`attachments.manage\`. Clinic must be active.** Removes the attachment metadata row.`,
  })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Attachment deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `attachments.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Attachment not found in this tenant.', schema: S_ERROR })
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.ATTACHMENTS_MANAGE)
  remove(
    @Param('messageId', ParseUUIDPipe) _messageId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.attachments.remove(this.ctx.requireTenantId(), attachmentId);
  }
}
