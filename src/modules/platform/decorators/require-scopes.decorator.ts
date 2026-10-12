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

export const REQUIRE_ANY_SCOPE_KEY = 'integrationAnyScope';

/**
 * Like `RequireScopes` but satisfied by ANY ONE of the given scopes. Used by
 * read-only discovery routes (e.g. branch ids) that several unrelated workflows
 * need, so no new scope has to be issued. Combine with `@ApiKeyProtected()`
 * (no scopes) so the key is still authenticated and tenant-checked.
 */
export const RequireAnyScope = (...scopes: IntegrationScope[]) =>
  SetMetadata(REQUIRE_ANY_SCOPE_KEY, scopes);
