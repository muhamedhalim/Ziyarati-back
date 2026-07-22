import { applyDecorators, UseGuards } from '@nestjs/common';

import { Public } from '../../auth/decorators/public.decorator';
import { ApiKeyRoute } from '../../auth/decorators/api-key-route.decorator';
import { ActiveTenantGuard } from '../../../core/tenant-context/active-tenant.guard';
import { IntegrationScopeGuard } from '../guards/integration-scope.guard';
import { RequireScopes } from './require-scopes.decorator';
import type { IntegrationScope } from '../integration-scopes.constants';

/**
 * Protects an EXTERNAL (machine-to-machine) integration route with API-key
 * auth + integration-scope enforcement.
 *
 *   @ApiKeyProtected(INTEGRATION_SCOPE.SERVICES_READ)
 *   @Get('integrations/services')
 *   list() { ... }
 *
 * `@Public()` + `@ApiKeyRoute()` make the global JwtAuthGuard resolve the API
 * key itself (see jwt-auth.guard.ts's docstring for why authentication must
 * happen there, not in a route-level guard, for tenant-status/maintenance
 * checks to see the principal). ActiveTenantGuard then rejects a suspended,
 * unapproved, or otherwise inactive tenant's key, and IntegrationScopeGuard
 * enforces the key's granted `integration.*` scopes — never internal RBAC
 * permissions (see integration-scopes.constants.ts).
 */
export function ApiKeyProtected(...scopes: IntegrationScope[]) {
  return applyDecorators(
    Public(),
    ApiKeyRoute(),
    UseGuards(ActiveTenantGuard, IntegrationScopeGuard),
    RequireScopes(...scopes),
  );
}
