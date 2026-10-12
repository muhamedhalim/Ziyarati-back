import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ApiKeyService } from '../platform/api-key.service';
import { ApiKeyProtected } from '../platform/decorators/api-key-protected.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AppError, ErrorCode } from '../../common/errors';
import { RequireFeature } from '../subscription-billing/decorators/require-feature.decorator';
import { ApiIntegrationMeErrors } from './integration-api-docs';
import { FeatureKey } from '../subscription-billing/feature-registry';

/** `ApiKeyAuthGuard` builds the principal id as `apikey:<keyId>`. */
const API_KEY_PRINCIPAL_PREFIX = 'apikey:';

/**
 * Credential self-check for a partner: "is this key valid, which clinic is it
 * bound to, and what may it do?" — answered without any side effect on clinic
 * data, so an integrator can verify a freshly issued key before writing code
 * against real endpoints.
 *
 * Needs a valid key but NO particular scope (every key may describe itself),
 * so a read-only key and a write key both succeed. The key is resolved from the
 * authenticated principal — never from a path/query/body value — and looked up
 * within the tenant the guard derived from that same key, so it can only ever
 * describe the caller's own credential. The response carries no secret, no
 * hash, and no tenant id.
 */
@ApiTags('Integration API')
@ApiSecurity('ApiKey-auth')
@RequireFeature(FeatureKey.INTEGRATIONS)
@ApiIntegrationMeErrors()
@Controller('integrations/me')
export class IntegrationMeController {
  constructor(
    private readonly keys: ApiKeyService,
    private readonly ctx: TenantContextService,
  ) {}

  @ApiOperation({
    summary: 'Describe the API key in use',
    description:
      'Requires a valid API key; no particular scope is needed. Returns the key id and prefix, its granted scopes, its expiry, and the clinic name it is bound to. Never returns the key itself.',
  })
  @ApiOkResponse({
    description:
      '`{ keyId, keyPrefix, name, tenantName, scopes, expiresAt, lastUsedAt }`.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, expired or revoked API key.',
  })
  @ApiKeyProtected()
  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    if (!user.id.startsWith(API_KEY_PRINCIPAL_PREFIX)) {
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: 'API key required',
      });
    }
    const keyId = user.id.slice(API_KEY_PRINCIPAL_PREFIX.length);
    const tenantId = this.ctx.requireTenantId();
    const own = await this.keys.describeOwn(tenantId, keyId);
    return { ...own, tenantName: this.ctx.getTenant()?.name ?? null };
  }
}
