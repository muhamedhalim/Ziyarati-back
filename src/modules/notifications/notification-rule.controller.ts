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

import { NotificationRuleService } from './notification-rule.service';
import { CreateNotificationRuleDto } from './dto/create-notification-rule.dto';
import { UpdateNotificationRuleDto } from './dto/update-notification-rule.dto';
import { NotificationRuleFilterDto } from './dto/notification-rule-filter.dto';

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

const S_RULE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    trigger_event: { type: 'string', example: 'appointment.completed' },
    delay_minutes: { type: 'number', example: 120 },
    is_active: { type: 'boolean', example: true },
    template: {
      type: 'object',
      nullable: true,
      properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_RULE_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_RULE },
    total: { type: 'number', example: 5 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * Notification automation rules. Guarded by PermissionsGuard + ActiveTenantGuard.
 * Tenant id from TenantContext; every rule belongs to the caller's tenant.
 */
@ApiTags('Notification Rules')
@ApiBearerAuth('JWT-auth')
@Controller('notification-rules')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class NotificationRuleController {
  constructor(
    private readonly rules: NotificationRuleService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a notification rule',
    description: `
**Protected — requires \`notification_rules.manage\`. Clinic must be active.**

Defines an automation: when \`triggerEvent\` fires (e.g.
\`appointment.completed\`), schedule a notification using \`templateId\` offset by
\`delayMinutes\`. Rules are per-tenant and independently enable/disable-able.

**Validation/edge cases:** if \`templateId\` is supplied it must belong to the
tenant (422 otherwise).

**Who can call this:** Owner, Manager (\`notification_rules.manage\`).

**Tenant scoping:** Stamped with the caller's tenant.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Rule created.', schema: S_RULE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Referenced template not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_MANAGE)
  create(@Body() dto: CreateNotificationRuleDto) {
    return this.rules.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List notification rules',
    description: `
**Protected — requires \`notification_rules.read\`. Clinic must be active.**

Returns the tenant's rules with optional filters (\`triggerEvent\`,
\`templateId\`, \`isActive\`) and pagination.

**Who can call this:** Owner, Manager (\`notification_rules.read\`).
    `.trim(),
  })
  @ApiOkResponse({ description: 'Paginated rules.', schema: S_RULE_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_READ)
  findAll(@Query() filter: NotificationRuleFilterDto) {
    return this.rules.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get rule details',
    description: `**Protected — requires \`notification_rules.read\`. Clinic must be active.** A rule from another tenant returns 404.`,
  })
  @ApiParam({ name: 'id', description: 'Rule UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Rule details.', schema: S_RULE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Rule not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update a notification rule',
    description: `**Protected — requires \`notification_rules.manage\`. Clinic must be active.** Partially updates the rule; a new \`templateId\` is validated against the tenant.`,
  })
  @ApiParam({ name: 'id', description: 'Rule UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Rule updated.', schema: S_RULE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Rule not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Referenced template not found in this tenant.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotificationRuleDto,
  ) {
    return this.rules.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Enable a rule',
    description: `**Protected — requires \`notification_rules.manage\`. Clinic must be active.** Sets \`is_active = true\`.`,
  })
  @ApiParam({ name: 'id', description: 'Rule UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Rule enabled.', schema: S_RULE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Rule not found.', schema: S_ERROR })
  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_MANAGE)
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Disable a rule',
    description: `**Protected — requires \`notification_rules.manage\`. Clinic must be active.** Sets \`is_active = false\` (rule stops firing).`,
  })
  @ApiParam({ name: 'id', description: 'Rule UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Rule disabled.', schema: S_RULE })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Rule not found.', schema: S_ERROR })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_MANAGE)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Delete a rule',
    description: `**Protected — requires \`notification_rules.manage\`. Clinic must be active.** Hard-deletes the rule.`,
  })
  @ApiParam({ name: 'id', description: 'Rule UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Rule deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `notification_rules.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Rule not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.NOTIFICATION_RULES_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.remove(this.ctx.requireTenantId(), id);
  }
}
