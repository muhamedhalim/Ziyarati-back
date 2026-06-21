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

import { CampaignRecipientService } from './campaign-recipient.service';
import { AddCampaignRecipientsDto } from './dto/add-campaign-recipients.dto';
import { RemoveCampaignRecipientsDto } from './dto/remove-campaign-recipients.dto';
import { CampaignRecipientFilterDto } from './dto/campaign-recipient-filter.dto';

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

const S_RECIPIENT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED'], example: 'QUEUED' },
    sent_at: { type: 'string', format: 'date-time', nullable: true },
    customer: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, full_name: { type: 'string', nullable: true }, phone: { type: 'string' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_RECIPIENT_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_RECIPIENT },
    total: { type: 'number', example: 540 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 50 },
  },
};

/**
 * Campaign recipients (nested under a campaign). Guarded by PermissionsGuard +
 * ActiveTenantGuard.
 *
 * `campaign_recipients` has no tenant column, so tenant isolation is enforced
 * THROUGH the campaign: each operation verifies the campaign belongs to the
 * caller's tenant before touching recipients.
 */
@ApiTags('Campaign Recipients')
@ApiBearerAuth('JWT-auth')
@Controller('campaigns/:campaignId/recipients')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@RequireActiveSubscription()
@RequireFeature('campaigns')
export class CampaignRecipientController {
  constructor(
    private readonly recipients: CampaignRecipientService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Add recipients (bulk)',
    description: `
**Protected — requires \`campaign_recipients.manage\`. Clinic must be active.**

Enrolls customers into the campaign. Idempotent — customers already enrolled
are skipped (unique constraint). Every customer is validated to belong to the
tenant (422 otherwise). Allowed only while the campaign is editable
(\`DRAFT\`/\`SCHEDULED\`/\`PAUSED\`).

**Who can call this:** Owner, Manager (\`campaign_recipients.manage\`).

**Tenant scoping:** Campaign ownership verified; customers validated against
the tenant.
    `.trim(),
  })
  @ApiParam({ name: 'campaignId', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiCreatedResponse({
    description: 'Recipients added.',
    schema: { type: 'object', properties: { requested: { type: 'number' }, added: { type: 'number' }, skipped: { type: 'number' } } },
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_recipients.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Campaign is not in an editable status.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'One or more customers not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.CAMPAIGN_RECIPIENTS_MANAGE)
  add(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: AddCampaignRecipientsDto,
  ) {
    return this.recipients.addRecipients(this.ctx.requireTenantId(), campaignId, dto);
  }

  @ApiOperation({
    summary: 'List recipients',
    description: `
**Protected — requires \`campaign_recipients.read\`. Clinic must be active.**

Returns the campaign's recipients with optional \`status\`/\`customerId\` filters
and pagination.

**Who can call this:** Owner, Manager, Receptionist (\`campaign_recipients.read\`).
    `.trim(),
  })
  @ApiParam({ name: 'campaignId', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Paginated recipients.', schema: S_RECIPIENT_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_recipients.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found in this tenant.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.CAMPAIGN_RECIPIENTS_READ)
  list(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Query() filter: CampaignRecipientFilterDto,
  ) {
    return this.recipients.list(this.ctx.requireTenantId(), campaignId, filter);
  }

  @ApiOperation({
    summary: 'Recipient statistics',
    description: `
**Protected — requires \`campaign_recipients.read\`. Clinic must be active.**

Returns recipient counts grouped by status for the campaign (total + per
status).

**Who can call this:** Owner, Manager, Receptionist (\`campaign_recipients.read\`).
    `.trim(),
  })
  @ApiParam({ name: 'campaignId', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Recipient status counts.',
    schema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', format: 'uuid' },
        total: { type: 'number', example: 540 },
        byStatus: { type: 'object', additionalProperties: { type: 'number' }, example: { QUEUED: 40, SENT: 480, FAILED: 20 } },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_recipients.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found in this tenant.', schema: S_ERROR })
  @Get('statistics')
  @RequirePermissions(PERMISSION.CAMPAIGN_RECIPIENTS_READ)
  statistics(@Param('campaignId', ParseUUIDPipe) campaignId: string) {
    return this.recipients.statistics(this.ctx.requireTenantId(), campaignId);
  }

  @ApiOperation({
    summary: 'Remove recipients',
    description: `
**Protected — requires \`campaign_recipients.manage\`. Clinic must be active.**

Removes the given customers from the campaign's recipient list. Allowed only
while the campaign is editable (\`DRAFT\`/\`SCHEDULED\`/\`PAUSED\`).

**Who can call this:** Owner, Manager (\`campaign_recipients.manage\`).
    `.trim(),
  })
  @ApiParam({ name: 'campaignId', description: 'Campaign UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Recipients removed.',
    schema: { type: 'object', properties: { removed: { type: 'number', example: 3 } } },
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `campaign_recipients.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Campaign not found in this tenant.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'Campaign is not in an editable status.', schema: S_ERROR })
  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.CAMPAIGN_RECIPIENTS_MANAGE)
  remove(
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() dto: RemoveCampaignRecipientsDto,
  ) {
    return this.recipients.removeRecipients(this.ctx.requireTenantId(), campaignId, dto);
  }
}
