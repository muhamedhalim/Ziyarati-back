import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';

import { IntegrationOAuthService } from './integration-oauth.service';
import { OAuthCallbackDto } from '../dto/oauth.dto';
import { RequireFeature } from '../../subscription-billing/decorators/require-feature.decorator';
import { FeatureKey } from '../../subscription-billing/feature-registry';

/**
 * OAuth2 Authorization-Code + PKCE CLIENT endpoints (Phase 4).
 *
 * The platform is the client — these routes drive a handshake against a provider
 * whose endpoints come from compiled/backend configuration. Tokens are never
 * returned by any route: only presence, scope and expiry.
 *
 * NO PRODUCTION PROVIDER IS CONFIGURED. `GET providers` reports
 * `enabled: false` unless the deterministic test provider is switched on by the
 * backend, and every other route then 422s — so the feature stays off in
 * production UI rather than half-working.
 */
@ApiTags('Integration OAuth')
@ApiBearerAuth('JWT-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@Controller('platform/integrations/oauth')
@UseGuards(PermissionsGuard, ActiveTenantGuard)
export class IntegrationOAuthController {
  constructor(
    private readonly oauth: IntegrationOAuthService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'OAuth providers available to this deployment',
    description:
      '**Protected — `platform.integrations.read`.** `enabled: false` means no OAuth provider is configured; the UI must keep the OAuth flow hidden.',
  })
  @Get('providers')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  providers() {
    return this.oauth.listProviders();
  }

  @ApiOperation({
    summary: 'Start the authorization handshake',
    description:
      '**Protected — `platform.integrations.manage`.** Returns the provider authorization URL carrying a single-use `state` and an S256 PKCE challenge. The verifier never leaves the backend.',
  })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  @Post(':connectionId/authorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  authorize(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.oauth.authorize(this.ctx.requireTenantId(), connectionId, {
      userId,
      ip,
    });
  }

  @ApiOperation({
    summary: 'Complete the authorization handshake',
    description:
      '**Protected — `platform.integrations.manage`.** Validates `state` (ownership, expiry, single use), exchanges the code with the PKCE verifier, and stores the tokens encrypted. Never returns a token.',
  })
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  callback(
    @Body() dto: OAuthCallbackDto,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.oauth.callback(this.ctx.requireTenantId(), dto, { userId, ip });
  }

  @ApiOperation({
    summary: 'Token status',
    description:
      '**Protected — `platform.integrations.read`.** Presence, scope and expiry only — token values are never exposed.',
  })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  @Get(':connectionId/status')
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_READ)
  status(@Param('connectionId', ParseUUIDPipe) connectionId: string) {
    return this.oauth.status(this.ctx.requireTenantId(), connectionId);
  }

  @ApiOperation({
    summary: 'Force a token refresh',
    description:
      '**Protected — `platform.integrations.manage`.** Rotates the refresh token. Concurrency-locked so two refreshes cannot redeem the same single-use token. `invalid_grant` clears the stored tokens and asks for a reconnect.',
  })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  @Post(':connectionId/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  async refresh(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    const tenantId = this.ctx.requireTenantId();
    await this.oauth.refresh(tenantId, connectionId, { userId, ip });
    // Return STATUS, not the token.
    return this.oauth.status(tenantId, connectionId);
  }

  @ApiOperation({
    summary: 'Disconnect from the provider',
    description:
      '**Protected — `platform.integrations.manage`.** Revokes at the provider when supported (best-effort) and always clears the locally stored tokens.',
  })
  @ApiParam({ name: 'connectionId', format: 'uuid' })
  @Post(':connectionId/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION.PLATFORM_INTEGRATIONS_MANAGE)
  disconnect(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @CurrentUser('id') userId: string,
    @Ip() ip: string,
  ) {
    return this.oauth.disconnect(this.ctx.requireTenantId(), connectionId, {
      userId,
      ip,
    });
  }
}
