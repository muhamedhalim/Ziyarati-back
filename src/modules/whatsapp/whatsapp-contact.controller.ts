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

import { WhatsappContactService } from './whatsapp-contact.service';
import { CreateWhatsappContactDto } from './dto/create-whatsapp-contact.dto';
import { UpdateWhatsappContactDto } from './dto/update-whatsapp-contact.dto';
import { WhatsappContactFilterDto } from './dto/whatsapp-contact-filter.dto';
import { BulkImportWhatsappContactsDto } from './dto/bulk-import-whatsapp-contacts.dto';

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

const S_CONTACT = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    wa_id: { type: 'string', nullable: true, example: '966501234567' },
    display_name: { type: 'string', nullable: true, example: 'Sara Al-Amin' },
    customer: { type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_CONTACT_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_CONTACT },
    total: { type: 'number', example: 1200 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 50 },
  },
};

/**
 * WhatsApp contacts. Guarded by PermissionsGuard + ActiveTenantGuard; tenant id
 * from TenantContext.
 *
 * Schema note: there is no status / opt-in column on `whatsapp_contacts`, so
 * contact-status & subscription tracking are not exposed by this module.
 */
@ApiTags('WhatsApp Contacts')
@ApiBearerAuth('JWT-auth')
@Controller('whatsapp/contacts')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WhatsappContactController {
  constructor(
    private readonly contacts: WhatsappContactService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Add a contact',
    description: `**Protected — requires \`whatsapp.contacts.manage\`. Clinic must be active.** Creates a contact for the tenant; a linked customer is validated against the tenant.`,
  })
  @ApiCreatedResponse({ description: 'Contact created.', schema: S_CONTACT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.contacts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Linked customer not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.WHATSAPP_CONTACTS_MANAGE)
  create(@Body() dto: CreateWhatsappContactDto) {
    return this.contacts.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'Bulk import contacts',
    description: `
**Protected — requires \`whatsapp.contacts.manage\`. Clinic must be active.**

Imports up to 1000 contacts. Idempotent — \`wa_id\`s already present for the
tenant are skipped. Any linked customers are validated against the tenant.

**Who can call this:** Owner, Manager, Receptionist (\`whatsapp.contacts.manage\`).
    `.trim(),
  })
  @ApiCreatedResponse({
    description: 'Import result.',
    schema: { type: 'object', properties: { requested: { type: 'number' }, imported: { type: 'number' }, skipped: { type: 'number' } } },
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.contacts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'A linked customer was not found in this tenant.', schema: S_ERROR })
  @Post('bulk-import')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(PERMISSION.WHATSAPP_CONTACTS_MANAGE)
  bulkImport(@Body() dto: BulkImportWhatsappContactsDto) {
    return this.contacts.bulkImport(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List / filter contacts',
    description: `**Protected — requires \`whatsapp.contacts.read\`. Clinic must be active.** Tenant-scoped; filter by search (name/wa_id), customerId, hasCustomer.`,
  })
  @ApiOkResponse({ description: 'Paginated contacts.', schema: S_CONTACT_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.contacts.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.WHATSAPP_CONTACTS_READ)
  findAll(@Query() filter: WhatsappContactFilterDto) {
    return this.contacts.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({ summary: 'Get contact details', description: `**Protected — \`whatsapp.contacts.read\`. Clinic active.** Foreign-tenant contact returns 404.` })
  @ApiParam({ name: 'id', description: 'Contact UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Contact details.', schema: S_CONTACT })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.contacts.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Contact not found.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_CONTACTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({ summary: 'Update a contact', description: `**Protected — \`whatsapp.contacts.manage\`. Clinic active.** Partial update; a new linked customer is validated against the tenant.` })
  @ApiParam({ name: 'id', description: 'Contact UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Contact updated.', schema: S_CONTACT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.contacts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Contact not found.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Linked customer not found in this tenant.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_CONTACTS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWhatsappContactDto) {
    return this.contacts.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Delete a contact', description: `**Protected — \`whatsapp.contacts.manage\`. Clinic active.** Permanently removes the contact.` })
  @ApiParam({ name: 'id', description: 'Contact UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Contact deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.contacts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Contact not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.WHATSAPP_CONTACTS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.contacts.remove(this.ctx.requireTenantId(), id);
  }
}
