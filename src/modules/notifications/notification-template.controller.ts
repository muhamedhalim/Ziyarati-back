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
} from '@nestjs/swagger';

import { NotificationTemplateService } from './notification-template.service';
import { CreateNotificationTemplateDto } from './dto/create-notification-template.dto';
import { UpdateNotificationTemplateDto } from './dto/update-notification-template.dto';
import { NotificationTemplateFilterDto } from './dto/notification-template-filter.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
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

const S_TEMPLATE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Appointment Reminder (24h)' },
    type: { type: 'string', nullable: true, example: 'appointment_reminder' },
    channel: { type: 'string', nullable: true, example: 'WHATSAPP' },
    content_ar: { type: 'string', nullable: true },
    content_en: { type: 'string', nullable: true },
    is_active: { type: 'boolean', example: true },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_TEMPLATE_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_TEMPLATE },
    total: { type: 'number', example: 9 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * Reusable notification templates. Guarded by PermissionsGuard + ActiveTenantGuard.
 * Tenant id comes from TenantContext; every template belongs to the caller's tenant.
 */
@ApiTags('Notification Templates')
@ApiBearerAuth('JWT-auth')
@Controller('notification-templates')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
export class NotificationTemplateController {
  constructor(
    private readonly templates: NotificationTemplateService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a notification template',
    description: `
**Protected — requires \`notification_templates.manage\`. Clinic must be active.**

Creates a reusable template (appointment confirmation/reminder/cancellation/
reschedule, follow-up, review request, payment reminder, subscription notice,
or internal staff message). Bilingual bodies (\`contentAr\`/\`contentEn\`) may
contain placeholders rendered at send time.

**Who can call this:** Owner, Manager (\`notification_templates.manage\`).

**Tenant scoping:** The template is stamped with the caller's tenant.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Template created.', schema: S_TEMPLATE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.manage`, or clinic inactive.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_MANAGE)
  create(@Body() dto: CreateNotificationTemplateDto) {
    return this.templates.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List notification templates',
    description: `
**Protected — requires \`notification_templates.read\`. Clinic must be active.**

Returns the tenant's templates with optional filters (\`search\`, \`type\`,
\`channel\`, \`isActive\`) and pagination.

**Who can call this:** Owner, Manager, Receptionist (\`notification_templates.read\`).

**Tenant scoping:** Only the caller's templates are returned.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated templates.', schema: S_TEMPLATE_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_READ)
  findAll(@Query() filter: NotificationTemplateFilterDto) {
    return this.templates.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get template details',
    description: `
**Protected — requires \`notification_templates.read\`. Clinic must be active.**

Returns one template. A template from another tenant returns 404 (no leak).

**Who can call this:** Owner, Manager, Receptionist (\`notification_templates.read\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Template UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Template details.', schema: S_TEMPLATE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Template not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a notification template',
    description: `
**Protected — requires \`notification_templates.manage\`. Clinic must be active.**

Partially updates a template's fields. Prefer the activate/deactivate
endpoints for toggling availability.

**Who can call this:** Owner, Manager (\`notification_templates.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Template UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Template updated.', schema: S_TEMPLATE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotificationTemplateDto,
  ) {
    return this.templates.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Activate a template',
    description: `**Protected — requires \`notification_templates.manage\`. Clinic must be active.** Sets \`is_active = true\`.`,
  })
  @ApiParam({ name: 'id', description: 'Template UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Template activated.', schema: S_TEMPLATE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Deactivate a template',
    description: `**Protected — requires \`notification_templates.manage\`. Clinic must be active.** Sets \`is_active = false\` (kept but unusable for new rules/sends).`,
  })
  @ApiParam({ name: 'id', description: 'Template UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Template deactivated.', schema: S_TEMPLATE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_MANAGE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Delete a template',
    description: `
**Protected — requires \`notification_templates.manage\`. Clinic must be active.**

Hard-deletes a template (no soft-delete column). **Blocked (409) if the
template is still referenced** by any rule or non-cancelled scheduled
notification — detach those first or deactivate instead.

**Who can call this:** Owner, Manager (\`notification_templates.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'id', description: 'Template UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Template deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_templates.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Template is still referenced by rules or pending notifications.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.NOTIFICATION_TEMPLATES_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.remove(this.ctx.requireTenantId(), id);
  }
}
