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

import { WhatsappAccountService } from './whatsapp-account.service';
import { CreateWhatsappAccountDto } from './dto/create-whatsapp-account.dto';
import { UpdateWhatsappAccountDto } from './dto/update-whatsapp-account.dto';
import { WhatsappAccountFilterDto } from './dto/whatsapp-account-filter.dto';

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

const S_ACCOUNT = {
  type: 'object',
  description: 'WhatsApp account — `access_token` is never returned; `hasCredentials` indicates whether one is stored.',
  properties: {
    id: { type: 'string', format: 'uuid' },
    phone_number_id: { type: 'string', nullable: true, example: '1234567890' },
    waba_id: { type: 'string', nullable: true, example: '9876543210' },
    is_active: { type: 'boolean', example: true },
    hasCredentials: { type: 'boolean', example: true },
    branch: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const S_ACCOUNT_LIST = {
  type: 'object',
  properties: {
    data: { type: 'array', items: S_ACCOUNT },
    total: { type: 'number', example: 3 },
    page: { type: 'number', example: 1 },
    limit: { type: 'number', example: 20 },
  },
};

/**
 * WhatsApp business accounts (one per branch). Guarded by PermissionsGuard +
 * ActiveTenantGuard; tenant id from TenantContext. The `access_token` secret is
 * never returned in responses.
 */
@ApiTags('WhatsApp Accounts')
@ApiBearerAuth('JWT-auth')
@Controller('whatsapp/accounts')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class WhatsappAccountController {
  constructor(
    private readonly accounts: WhatsappAccountService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Create a WhatsApp account',
    description: `
**Protected — requires \`whatsapp.accounts.manage\`. Clinic must be active.**

Connects a WhatsApp business number to a branch (one account per branch). The
\`accessToken\` is write-only — stored as a secret, never returned, redacted in
logs.

**Who can call this:** Owner, Manager (\`whatsapp.accounts.manage\`).

**Tenant scoping:** Stamped with the caller's tenant; the branch is validated
against the tenant.
    `.trim(),
  })
  @ApiCreatedResponse({ description: 'Account created (token omitted).', schema: S_ACCOUNT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiConflictResponse({ description: 'This branch already has a WhatsApp account.', schema: S_ERROR })
  @ApiUnprocessableEntityResponse({ description: 'Branch not found in this tenant.', schema: S_ERROR })
  @Post()
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  create(@Body() dto: CreateWhatsappAccountDto) {
    return this.accounts.create(this.ctx.requireTenantId(), dto);
  }

  @ApiOperation({
    summary: 'List WhatsApp accounts',
    description: `**Protected — requires \`whatsapp.accounts.read\`. Clinic must be active.** Tenant-scoped, filter by branch/active; tokens omitted.`,
  })
  @ApiOkResponse({ description: 'Paginated accounts.', schema: S_ACCOUNT_LIST })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.', schema: S_ERROR })
  @Get()
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_READ)
  findAll(@Query() filter: WhatsappAccountFilterDto) {
    return this.accounts.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'Get account details',
    description: `**Protected — requires \`whatsapp.accounts.read\`. Clinic must be active.** A foreign-tenant account returns 404. Token omitted.`,
  })
  @ApiParam({ name: 'id', description: 'Account UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Account details.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Account not found in this tenant.', schema: S_ERROR })
  @Get(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Get connection status',
    description: `**Protected — requires \`whatsapp.accounts.read\`. Clinic must be active.** Derived status (active + credentials + phone/WABA configured). No live provider call.`,
  })
  @ApiParam({ name: 'id', description: 'Account UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Connection status.',
    schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', format: 'uuid' },
        isActive: { type: 'boolean' },
        phoneNumberConfigured: { type: 'boolean' },
        wabaConfigured: { type: 'boolean' },
        hasCredentials: { type: 'boolean' },
        connected: { type: 'boolean' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Get(':id/connection-status')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_READ)
  connectionStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.connectionStatus(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Update account settings',
    description: `**Protected — requires \`whatsapp.accounts.manage\`. Clinic must be active.** Updates credentials/settings (branch is immutable). Supplying \`accessToken\` rotates the stored secret.`,
  })
  @ApiParam({ name: 'id', description: 'Account UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Account updated.', schema: S_ACCOUNT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWhatsappAccountDto) {
    return this.accounts.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({ summary: 'Activate account', description: `**Protected — \`whatsapp.accounts.manage\`. Clinic active.** Sets \`is_active = true\`.` })
  @ApiParam({ name: 'id', description: 'Account UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Account activated.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({ summary: 'Deactivate account', description: `**Protected — \`whatsapp.accounts.manage\`. Clinic active.** Sets \`is_active = false\` (blocks sending from this account).` })
  @ApiParam({ name: 'id', description: 'Account UUID', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Account deactivated.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({ summary: 'Delete account (soft)', description: `**Protected — \`whatsapp.accounts.manage\`. Clinic active.** Soft-deletes the account (sets \`deleted_at\`).` })
  @ApiParam({ name: 'id', description: 'Account UUID', type: 'string', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Account deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({ description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.', schema: S_ERROR })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.remove(this.ctx.requireTenantId(), id);
  }
}
