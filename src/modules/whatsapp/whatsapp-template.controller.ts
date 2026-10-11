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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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

import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappExecutionService } from './whatsapp-execution.service';
import { ValidateWhatsappTemplateDto } from './dto/validate-whatsapp-template.dto';
import { UpdateTemplateVariableMappingDto } from './dto/update-template-variable-mapping.dto';
import { CreateWhatsappTemplateDto } from './dto/create-whatsapp-template.dto';
import { UpdateWhatsappTemplateDto } from './dto/update-whatsapp-template.dto';
import { WhatsappTemplateFilterDto } from './dto/whatsapp-template-filter.dto';
import { SendTemplateMessageDto } from './dto/send-template-message.dto';

import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { PERMISSION } from '../../rbac/rbac.constants';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../core/tenant-context/active-tenant.guard';
import {
  WHATSAPP_TEMPLATE_STATUSES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
} from './whatsapp.constants';

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
    name: { type: 'string', example: 'appointment_reminder' },
    language: { type: 'string', example: 'ar' },
    category: { type: 'string', nullable: true, example: 'UTILITY' },
    status: {
      type: 'string',
      enum: ['draft', 'pending_review', 'approved', 'rejected', 'paused', 'disabled'],
      example: 'approved',
    },
    components: { type: 'object', nullable: true, additionalProperties: true },
    provider_template_id: {
      type: 'string',
      nullable: true,
      description: "Meta's own template id.",
      example: '1234567890123456',
    },
    waba_id: { type: 'string', nullable: true, example: '102290129340398' },
    rejected_reason: {
      type: 'string',
      nullable: true,
      description: "Meta's reason, when the template was rejected/paused/disabled.",
    },
    variable_mapping: {
      type: 'object',
      nullable: true,
      additionalProperties: { type: 'string' },
      description: 'Placeholder to trusted data source, used by the notification pipeline.',
    },
    last_synced_at: { type: 'string', format: 'date-time', nullable: true },
    needs_refresh: {
      type: 'boolean',
      description:
        'True when the status is older than the freshness window (or never reconciled): show "needs refresh", not the status as current.',
    },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_TEMPLATE_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_TEMPLATE },
    total: { type: 'number', example: 14 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

const S_SEND_RESULT = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'],
      example: 'SENT',
    },
    providerMessageId: {
      type: 'string',
      nullable: true,
      example: 'noop_wamid_...',
    },
    recipient: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        id: { type: 'string', nullable: true },
        to: { type: 'string' },
      },
    },
    logId: { type: 'string', format: 'uuid' },
  },
};

/**
 * WhatsApp templates + template-message sending. Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext.
 */
@ApiTags('WhatsApp Templates')
@ApiBearerAuth('JWT-auth')
@Controller('whatsapp/templates')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature(FeatureKey.WHATSAPP)
export class WhatsappTemplateController {
  constructor(
    private readonly templates: WhatsappTemplateService,
    private readonly execution: WhatsappExecutionService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a template on Meta',
    description: `
**Protected — requires \`whatsapp.templates.manage\`. Clinic must be active.**

Submits a **real** message template to Meta
(\`POST /{waba-id}/message_templates\`) on the clinic's own connected WhatsApp
Business Account, then stores the mirror row.

**Order of operations:** Meta is called BEFORE anything is persisted. If Meta
rejects the template nothing is written, so there is never a local row for a
template that does not exist on the WABA.

**Status comes from Meta** (normally \`pending_review\`) and can never be
supplied by the caller — see \`PATCH :id/status\` (GAP-002). The WABA is taken
from the tenant's resolved account, never from the request body.

Unique per (tenant, name, language) — a duplicate returns 409.

**Who can call this:** Owner, Manager (\`whatsapp.templates.manage\`).
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Template created on Meta and mirrored locally.',
    schema: S_TEMPLATE,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed (name format, language code, category, components).',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `whatsapp.templates.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'Template name+language already exists.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'No connected WhatsApp account, referenced account not in this tenant, invalid component structure (missing BODY, placeholders without examples), or Meta rejected the template.',
    schema: S_ERROR,
  })
  @Post()
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  async create(@Body() dto: CreateWhatsappTemplateDto) {
    const tenantId = this.ctx.requireTenantId();
    const created = await this.templates.create(tenantId, dto);
    return this.templates.findOneView(tenantId, created.id);
  }

  @ApiOperation({
    summary: 'Validate a template draft (dry run)',
    description: `
**Protected, requires \`whatsapp.templates.manage\`.**

Runs the same pre-submission checks as create (placeholder numbering, start/end
position, adjacency, sample values, length limits, variable density) and
returns every issue with a stable \`code\`, the \`field\` it belongs to and a
suggested fix. **Nothing is sent to Meta and nothing is stored.**

\`valid: true\` means no structural error was found; it is **not** a promise of
approval. Meta's own review (policy, category, an unpublished variable-density
rule) still decides. Density is reported as a \`warning\`, never an error.
    `.trim(),
  })
  @ApiOkResponse({ description: 'Validation result.' })
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  validate(@Body() dto: ValidateWhatsappTemplateDto) {
    return this.templates.validate(dto);
  }

  @ApiOperation({
    summary: 'Data sources a placeholder can be bound to',
    description:
      '**Protected, `whatsapp.templates.read`.** The closed set of trusted values (patient name, appointment date, ...) the notification pipeline can fill a placeholder with.',
  })
  @ApiOkResponse({ description: 'Source identifiers.' })
  @Get('variable-sources')
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_READ)
  variableSources() {
    return { sources: WHATSAPP_TEMPLATE_VARIABLE_SOURCES };
  }

  @ApiOperation({
    summary: 'List templates',
    description: `**Protected — requires \`whatsapp.templates.read\`. Clinic must be active.** Tenant-scoped, filter by status/category/language/search.`,
  })
  @ApiOkResponse({
    description: 'Paginated templates.',
    schema: S_TEMPLATE_LIST,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.templates.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_READ)
  findAll(@Query() filter: WhatsappTemplateFilterDto) {
    return this.templates.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get template details',
    description: `**Protected — \`whatsapp.templates.read\`. Clinic active.** Foreign-tenant template returns 404.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Template UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Template details.', schema: S_TEMPLATE })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.templates.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.findOneView(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: "Refresh one template's status from Meta",
    description: `
**Protected, requires \`whatsapp.templates.manage\`.**

Re-reads this template's verdict from Meta (a read-only \`GET\`) and mirrors it.
Safe to repeat: it cannot create or alter anything on Meta. If Meta cannot be
reached the call fails and the **last known status is left untouched**: the
response is an error, never an invented status. If Meta no longer has the
template it is removed from the list (404).
    `.trim(),
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'The template with its freshly reconciled status.', schema: S_TEMPLATE })
  @ApiNotFoundResponse({ description: 'Template not found, or gone from Meta.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({
    description: 'Never submitted to Meta, account unusable, or Meta unreachable (see `context.meta`).',
    schema: S_ERROR,
  })
  @Post(':id/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.refresh(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Bind placeholders to data sources',
    description: `
**Protected, requires \`whatsapp.templates.manage\`.**

Chooses which trusted value fills each placeholder when this template is sent by
a notification rule (\`{{1}}\` is the patient name, \`{{2}}\` the appointment
date, ...). Values are resolved on the server from the appointment, clinic and
customer, never from the request. An empty \`mapping\` clears the binding.
    `.trim(),
  })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Template with the new binding.', schema: S_TEMPLATE })
  @Put(':id/variable-mapping')
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  setVariableMapping(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateVariableMappingDto,
  ) {
    return this.templates.setVariableMapping(this.ctx.requireTenantId(), id, dto.mapping);
  }

  @ApiOperation({
    summary: 'Update a template',
    description: `**Protected — \`whatsapp.templates.manage\`. Clinic active.** Partial update.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Template UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Template updated.', schema: S_TEMPLATE })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `whatsapp.templates.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWhatsappTemplateDto,
  ) {
    return this.templates.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Set template review status',
    description: `
**Protected — requires \`whatsapp.templates.manage\`. Clinic must be active.**

Tracks the approval lifecycle: \`draft\` → \`pending_review\` → \`rejected\` or
\`disabled\`. Only \`approved\` templates can be sent.

**\`approved\` cannot be set here (GAP-002).** It is reachable ONLY through
WhatsApp/Meta's own review callback — never via this endpoint, regardless of
caller or permission. Attempting to set it is refused with 403.

**Who can call this:** Owner, Manager (\`whatsapp.templates.manage\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Template UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: WHATSAPP_TEMPLATE_STATUSES as unknown as string[],
          description:
            '`approved` is rejected — see the operation description.',
        },
      },
    },
  })
  @ApiOkResponse({ description: 'Status updated.', schema: S_TEMPLATE })
  @ApiBadRequestResponse({
    description: 'Invalid status value.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `whatsapp.templates.manage`, the clinic is inactive, or `status` was `approved` (GAP-002 — Meta-callback-only).',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Patch(':id/status')
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: string,
  ) {
    return this.templates.setStatus(this.ctx.requireTenantId(), id, status);
  }

  @ApiOperation({
    summary: 'Delete a template (soft)',
    description: `**Protected — \`whatsapp.templates.manage\`. Clinic active.** Soft-deletes the template.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Template UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Template deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `whatsapp.templates.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Template not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.remove(this.ctx.requireTenantId(), id);
  }

  // ─────────────────────────── Messaging ─────────────────────────────────── //

  @ApiOperation({
    summary: 'Send a template message',
    description: `
**Protected — requires \`whatsapp.send\`. Clinic must be active.**

Sends an **approved** template to one recipient (\`contactId\` | \`customerId\` |
\`toWaId\`) via the provider abstraction (no real provider implemented). The
outcome is recorded on \`notification_logs\` (channel WHATSAPP) for analytics.

**Failure scenarios:** template not approved (422), no active account (404/422),
no recipient supplied (400), recipient not found (404).

**Who can call this:** Owner, Manager, Receptionist (\`whatsapp.send\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Template UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({
    description: 'Message dispatched; outcome logged.',
    schema: S_SEND_RESULT,
  })
  @ApiBadRequestResponse({
    description: 'No/invalid recipient.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.send`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Template, account, or recipient not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Template not approved, or account inactive.',
    schema: S_ERROR,
  })
  @Post(':id/send')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.WHATSAPP_SEND)
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendTemplateMessageDto,
  ) {
    return this.execution.sendTemplateMessage(
      this.ctx.requireTenantId(),
      id,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Schedule a template message',
    description: `
**Protected — requires \`whatsapp.send\`. Clinic must be active.**

Validates account/template/recipient and records a \`QUEUED\` log for a future
send at \`scheduledAt\` (required). Queue-ready seam — production enqueues a
BullMQ delayed job carrying the send params.

**Who can call this:** Owner, Manager, Receptionist (\`whatsapp.send\`).
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Template UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiCreatedResponse({
    description: 'Message queued.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'QUEUED' },
        scheduledAt: { type: 'string', format: 'date-time' },
        logId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Missing scheduledAt / recipient.',
    schema: S_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.send`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Template, account, or recipient not found.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Template not approved, or account inactive.',
    schema: S_ERROR,
  })
  @Post(':id/schedule')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.WHATSAPP_SEND)
  schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendTemplateMessageDto,
  ) {
    return this.execution.scheduleMessage(this.ctx.requireTenantId(), id, dto);
  }
}
