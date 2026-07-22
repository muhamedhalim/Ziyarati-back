import { SetMetadata } from '@nestjs/common';
import type { IntegrationScope } from '../integration-scopes.constants';

export const REQUIRE_SCOPES_KEY = 'integrationScopes';

/**
 * Restricts an external-integration route to API keys that carry ALL of the
 * given scopes. Enforced by IntegrationScopeGuard. Distinct from
 * `@RequirePermissions` — that guards internal dashboard routes against a JWT
 * principal's RBAC permissions; this guards M2M routes against an API key's
 * granted integration scopes. The two are never mixed on the same route.
 */
export const RequireScopes = (...scopes: IntegrationScope[]) =>
  SetMetadata(REQUIRE_SCOPES_KEY, scopes);
