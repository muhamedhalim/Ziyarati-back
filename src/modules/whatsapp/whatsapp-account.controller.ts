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
import { RequireActiveSubscription } from '../subscription-billing/decorators/require-active-subscription.decorator';
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

const S_ACCOUNT = {
  type: 'object',
  description:
    'WhatsApp account — `access_token` is never returned; `hasCredentials` indicates whether one is stored.',
  properties: {
    id: { type: 'string', format: 'uuid' },
    phone_number_id: { type: 'string', nullable: true, example: '1234567890' },
    waba_id: { type: 'string', nullable: true, example: '9876543210' },
    is_active: { type: 'boolean', example: true },
    hasCredentials: { type: 'boolean', example: true },
    branch: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
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
@RequireActiveSubscription()
@RequireFeature(FeatureKey.WHATSAPP)
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
  @ApiCreatedResponse({
    description: 'Account created (token omitted).',
    schema: S_ACCOUNT,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'This branch already has a WhatsApp account.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Branch not found in this tenant.',
    schema: S_ERROR,
  })
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
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @Get()
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_READ)
  findAll(@Query() filter: WhatsappAccountFilterDto) {
    return this.accounts.findAll(this.ctx.requireTenantId(), filter);
  }

  @ApiOperation({
    summary: 'List accounts eligible to send right now',
    description: `
**Protected — requires \`whatsapp.accounts.read\`. Clinic active.**

Returns only the clinic's numbers that can actually send: connected, active,
credentialed and unexpired. This is what a campaign's "send from" picker offers.

**Why a dedicated endpoint:** eligibility is decided by the SAME rule the sender
uses (\`WhatsappAccountResolver.usableAccounts\`). If the UI filtered
\`GET /whatsapp/accounts\` with its own rules the two would drift, and the user
would be offered a number the send path then rejects.

**Tenant scoping:** only the caller's own accounts. Access tokens never returned.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Accounts that can send. Empty when nothing is connected.',
    schema: { type: 'array', items: S_ACCOUNT },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  // MUST stay above `@Get(':id')`: Nest matches in declaration order, so a
  // literal route declared after the param route would be parsed as a UUID.
  @Get('eligible')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_READ)
  findEligible() {
    return this.accounts.findEligible(this.ctx.requireTenantId());
  }

  @ApiOperation({
    summary: 'Get account details',
    description: `**Protected — requires \`whatsapp.accounts.read\`. Clinic must be active.** A foreign-tenant account returns 404. Token omitted.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Account details.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Account not found in this tenant.',
    schema: S_ERROR,
  })
  @Get(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_READ)
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.findOne(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Get connection status',
    description: `**Protected — requires \`whatsapp.accounts.read\`. Clinic must be active.** Derived status (active + credentials + phone/WABA configured). No live provider call.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
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
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.read`, or clinic inactive.',
    schema: S_ERROR,
  })
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
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Account updated.', schema: S_ACCOUNT })
  @ApiBadRequestResponse({ description: 'Validation failed.', schema: S_ERROR })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Patch(':id')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWhatsappAccountDto,
  ) {
    return this.accounts.update(this.ctx.requireTenantId(), id, dto);
  }

  @ApiOperation({
    summary: 'Activate account',
    description: `**Protected — \`whatsapp.accounts.manage\`. Clinic active.** Sets \`is_active = true\`.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Account activated.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.setActive(this.ctx.requireTenantId(), id, true);
  }

  @ApiOperation({
    summary: 'Deactivate account',
    description: `**Protected — \`whatsapp.accounts.manage\`. Clinic active.** Sets \`is_active = false\` (blocks sending from this account).`,
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Account deactivated.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.setActive(this.ctx.requireTenantId(), id, false);
  }

  @ApiOperation({
    summary: 'Disconnect this WhatsApp number',
    description: `
**Protected — \`whatsapp.accounts.manage\`. Clinic active.**

Stops this number sending immediately: outgoing messages and campaign dispatch
through it are refused, and it stops being the clinic's default.

**Nothing is lost.** Conversations, messages, campaigns and audit history that
reference the account are preserved — the row is not deleted. Reconnecting is a
single Embedded Signup run (\`POST /whatsapp/onboarding/complete\` with the same
number), which re-validates the WABA with Meta, re-subscribes the webhook and
replaces the credential.

To remove the account entirely instead, use \`DELETE /whatsapp/accounts/:id\`
(soft-delete), which also frees the phone number to be connected elsewhere.

Idempotent: disconnecting an already-disconnected account succeeds.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({ description: 'Account disconnected.', schema: S_ACCOUNT })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Post(':id/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  disconnect(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.disconnect(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: "Make this the clinic's default sending number",
    description: `
**Protected — \`whatsapp.accounts.manage\`. Clinic active.**

Sets this account as the clinic's default: the number used whenever nothing more
specific applies (no explicit account on the request, and no branch-specific
number for the branch in play).

A clinic has AT MOST ONE default — setting a new one clears the previous, in a
single transaction. Making the choice explicit is what replaced the platform
implicitly guessing (oldest row wins) which number a clinic messages patients
from.

**Failure:** 422 if the account is inactive — a switched-off number cannot be
the one everything else falls back to.
    `.trim(),
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Account is now the default.',
    schema: S_ACCOUNT,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.setDefault(this.ctx.requireTenantId(), id);
  }

  @ApiOperation({
    summary: 'Delete account (soft)',
    description: `**Protected — \`whatsapp.accounts.manage\`. Clinic active.** Soft-deletes the account (sets \`deleted_at\`). Frees the phone number for reconnection.`,
  })
  @ApiParam({
    name: 'id',
    description: 'Account UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Account deleted.' })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid access token.',
    schema: S_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or clinic inactive.',
    schema: S_ERROR,
  })
  @ApiNotFoundResponse({ description: 'Account not found.', schema: S_ERROR })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.remove(this.ctx.requireTenantId(), id);
  }
}
