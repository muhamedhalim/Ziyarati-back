import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { MetaEmbeddedSignupService } from './meta-embedded-signup.service';
import { WhatsappTemplateSyncService } from './whatsapp-template-sync.service';
import { CompleteEmbeddedSignupDto } from '../dto/complete-embedded-signup.dto';
import { SyncTemplatesDto } from '../dto/sync-templates.dto';

import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';

// `complete` and `templates/sync` each trigger several outbound Meta Graph
// API calls per request. Authenticated (unlike the webhook endpoints), but a
// malicious or malfunctioning tenant client could still hammer either one to
// burn the shared platform app's Graph API quota. Relaxed under Jest for the
// same reason as the app-wide default in app.module.ts.
const META_GRAPH_THROTTLE = {
  default: { limit: process.env.NODE_ENV === 'test' ? 1_000_000 : 20, ttl: 60_000 },
};

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

/**
 * Meta Embedded Signup — how a clinic connects its OWN WhatsApp Business
 * Account to the platform.
 *
 * ZiyaraTech is an Independent Tech Provider: one Meta App, many tenant-owned
 * WABAs. The browser opens Meta's dialog with the public ids from `/config`,
 * the clinic picks its assets, and Meta returns a short-lived authorization
 * code — the ONLY thing `/complete` accepts. The permanent access token is
 * minted, validated and stored server-side and never reaches the frontend.
 *
 * Both endpoints are authenticated + tenant-scoped: the connection is always
 * persisted under the caller's own tenant, never a tenant id from the body.
 */
@ApiTags('WhatsApp Onboarding')
@Controller('whatsapp/onboarding')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
@ApiBearerAuth('JWT-auth')
export class WhatsappOnboardingController {
  constructor(
    private readonly signup: MetaEmbeddedSignupService,
    private readonly templateSync: WhatsappTemplateSyncService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Get the public Meta config needed to launch Embedded Signup',
    description: `
**Protected — requires \`whatsapp.accounts.manage\`. Clinic must be active.**

Returns ONLY the platform Meta App's public identifiers, which the frontend
needs to open the Embedded Signup dialog.

**Security:** this deliberately exposes nothing but \`appId\`, \`configId\` and
\`graphVersion\`. The App Secret and every tenant access token stay server-side —
the browser has no use for them and no way to obtain them.

**Failure:** 422 when the platform Meta App is not configured.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Public Meta App identifiers.',
    schema: {
      type: 'object',
      properties: {
        appId: { type: 'string', example: '1234567890123456' },
        configId: { type: 'string', example: '9876543210987654' },
        graphVersion: { type: 'string', example: 'v21.0' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or the clinic is not active.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'The platform Meta App is not configured.',
    schema: S_ERROR,
  })
  @Get('config')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  config() {
    return this.signup.publicConfig();
  }

  @ApiOperation({
    summary: 'Whether Meta WhatsApp onboarding is configured',
    description: `
**Protected — requires \`whatsapp.accounts.manage\`. Clinic must be active.**

A single boolean the frontend uses to disable the "Connect WhatsApp" button and
show a clear message, without treating an unconfigured platform as an error to
retry (which \`GET config\` does, by design — it must fail loudly for the dialog
that actually depends on those values).

**Security:** returns \`configured\` only. Never the app id, config id, or any
secret — this endpoint exists purely so the UI has a stable value to branch on.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Onboarding configuration status.',
    schema: { type: 'object', properties: { configured: { type: 'boolean', example: false } } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.accounts.manage`, or the clinic is not active.',
    schema: S_ERROR,
  })
  @Get('status')
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  status() {
    return this.signup.status();
  }

  @ApiOperation({
    summary: 'Complete Embedded Signup and connect the clinic\'s WhatsApp number',
    description: `
**Protected — requires \`whatsapp.accounts.manage\`. Clinic must be active.**

Exchanges the dialog's short-lived authorization code for the clinic's own
WhatsApp credential and connects it.

**What the backend does (each step is a gate):**
1. exchanges the code for an access token using the platform App Secret;
2. introspects the token and rejects it unless it was issued for THIS Meta app
   with the required messaging/management scopes;
3. re-reads the WABA and phone number FROM META with that token — the ids in the
   request body are untrusted and prove nothing on their own;
4. subscribes the WABA to the platform webhook (without this no inbound message
   would ever arrive);
5. stores the credential encrypted under the caller's tenant, and syncs the
   WABA's templates.

**Tenant scoping:** the connection is always saved under the authenticated
tenant. A phone number already connected to a different tenant is rejected.

**Failure scenarios:** 403 if the token was minted for another app; 409 if the
number is already connected elsewhere; 422 for an invalid/expired code, missing
scopes, a WABA with no phone number, or an ambiguous multi-number WABA (the
response then lists the numbers so the user can choose).
    `.trim(),
  })
  @ApiOkResponse({
    description: 'WhatsApp account connected. The access token is never returned.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        wabaId: { type: 'string', example: '102290129340398' },
        phoneNumberId: { type: 'string', example: '106540352242922' },
        displayPhoneNumber: { type: 'string', example: '+966 50 123 4567' },
        verifiedName: { type: 'string', example: 'Smile Dental Clinic' },
        connectionStatus: { type: 'string', example: 'CONNECTED' },
        isDefault: { type: 'boolean', example: true },
        connectedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description:
      'Caller lacks `whatsapp.accounts.manage`, the clinic is not active, or the authorization was issued for a different Meta app.',
    schema: S_ERROR,
  })
  @ApiConflictResponse({
    description: 'This WhatsApp phone number is already connected to another tenant.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Invalid/expired code, missing scopes, no phone number on the WABA, or several numbers and none selected.',
    schema: S_ERROR,
  })
  @Throttle(META_GRAPH_THROTTLE)
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_ACCOUNTS_MANAGE)
  async complete(@Body() dto: CompleteEmbeddedSignupDto) {
    const tenantId = this.ctx.requireTenantId();
    const account = await this.signup.complete(tenantId, dto);

    // Pull the clinic's templates immediately so campaigns are usable right
    // away. Best-effort by design: a sync failure must not undo a valid
    // connection — the clinic can re-sync from the UI.
    await this.templateSync.syncAfterOnboarding(tenantId, account.id);

    return {
      id: account.id,
      wabaId: account.waba_id,
      phoneNumberId: account.phone_number_id,
      displayPhoneNumber: account.display_phone_number,
      verifiedName: account.verified_name,
      connectionStatus: account.connection_status,
      isDefault: account.is_default,
      connectedAt: account.connected_at,
    };
  }

  @ApiOperation({
    summary: 'Re-sync message templates from Meta',
    description: `
**Protected — requires \`whatsapp.templates.manage\`. Clinic must be active.**

Re-downloads the WABA's templates and reconciles the local mirror: approval
status, language, category, components and rejection reasons.

Meta owns template review, so Meta always wins on conflict — this is how a
template that Meta has since rejected or paused stops being used by campaigns.
Runs automatically after onboarding; call this to refresh on demand.
    `.trim(),
  })
  @ApiOkResponse({
    description: 'Sync result.',
    schema: {
      type: 'object',
      properties: {
        wabaId: { type: 'string' },
        fetched: { type: 'number', example: 12 },
        created: { type: 'number', example: 3 },
        updated: { type: 'number', example: 9 },
        syncedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.', schema: S_ERROR })
  @ApiForbiddenResponse({
    description: 'Caller lacks `whatsapp.templates.manage`, or the clinic is not active.',
    schema: S_ERROR,
  })
  @ApiUnprocessableEntityResponse({
    description: 'No connected WhatsApp account, or Meta rejected the request.',
    schema: S_ERROR,
  })
  @Throttle(META_GRAPH_THROTTLE)
  @Post('templates/sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.WHATSAPP_TEMPLATES_MANAGE)
  syncTemplates(@Query() dto: SyncTemplatesDto) {
    return this.templateSync.syncAccount(this.ctx.requireTenantId(), dto.accountId);
  }
}
