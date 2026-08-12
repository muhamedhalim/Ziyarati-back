/**
 * T019 — proves the metadata harness resolves decorator combinations exactly
 * as the running guards would, including the one shape (a `@Public()` method
 * adjacent to a sibling separated by a multi-line `@ApiOperation` block) that
 * fooled the original audit's text-scanning extractor. This is the
 * regression test for that false-positive class (FR-032, US2 AS3).
 *
 * Runs against `collectFromController()` directly — no Nest boot, no
 * infrastructure — so it belongs in the fast, infrastructure-free suite.
 */
import {
  collectFromController,
  GLOBAL_GUARD_NAMES,
  type RouteEntry,
} from './nest-route-metadata';
import {
  RolesControllerLevelPublicMethodFixture,
  PermissionsControllerLevelAnyMethodFixture,
  ApiKeyProtectedFixture,
  LayeredGuardsFixture,
} from './fixtures/decorator-combinations.controller';

function findRoute(entries: RouteEntry[], handler: string): RouteEntry {
  const found = entries.find((e) => e.handler === handler);
  if (!found) throw new Error(`fixture route not found: ${handler}`);
  return found;
}

describe('nest-route-metadata harness — decorator-combination fixtures', () => {
  describe('Fixture 1/2 — controller-level @Roles overridden by method-level @Public, including the adjacent-multiline-@ApiOperation shape', () => {
    const routes = collectFromController(RolesControllerLevelPublicMethodFixture, true);

    it('resolves the public method as public, while still reading its inherited controller-level roles metadata (IS_PUBLIC_KEY and ROLES_KEY are independent keys — see fixture docstring)', () => {
      const route = findRoute(routes, 'publicOne');
      expect(route.metadata.isPublic).toBe(true);
      expect(route.metadata.roles).toEqual(['clinic_admin']);
    });

    it('resolves the documented, non-public neighbour as NOT public, still carrying the controller roles — proximity to the public method above must not leak', () => {
      const route = findRoute(routes, 'protectedNeighbour');
      expect(route.metadata.isPublic).toBe(false);
      expect(route.metadata.roles).toEqual(['clinic_admin']);
    });

    it('resolves the second public method independently — the marker is per-method, never "still open" from a prior method', () => {
      const route = findRoute(routes, 'publicTwo');
      expect(route.metadata.isPublic).toBe(true);
      expect(route.metadata.roles).toEqual(['clinic_admin']);
    });
  });

  describe('Fixture 3 — controller-level @RequirePermissions + method-level @RequireAnyPermission', () => {
    const routes = collectFromController(PermissionsControllerLevelAnyMethodFixture, true);

    it('resolves both keys on the method that declares the second one', () => {
      const route = findRoute(routes, 'either');
      expect(route.metadata.permissions).toEqual(['appointments.read']);
      expect(route.metadata.anyPermissions).toEqual([
        'appointments.read_own',
        'appointments.read',
      ]);
    });

    it('resolves only the controller-level permission on the sibling with no method-level override', () => {
      const route = findRoute(routes, 'allOnly');
      expect(route.metadata.permissions).toEqual(['appointments.read']);
      expect(route.metadata.anyPermissions).toEqual([]);
    });
  });

  describe('Fixture 4 — composed @ApiKeyProtected() (applyDecorators)', () => {
    const routes = collectFromController(ApiKeyProtectedFixture, true);

    it('resolves every decorator the composition applies, from one decorator call', () => {
      const route = findRoute(routes, 'm2m');
      expect(route.metadata.isPublic).toBe(true);
      expect(route.metadata.isApiKeyRoute).toBe(true);
      expect(route.metadata.integrationScopes).toEqual(['integration.services.read']);
      expect(route.methodGuards).toEqual(
        expect.arrayContaining(['ActiveTenantGuard', 'IntegrationScopeGuard']),
      );
    });
  });

  describe('Fixture 5 — controller-level guard + method-level guard, effective union', () => {
    const routes = collectFromController(LayeredGuardsFixture, true);

    it('unions controller and method guards, plus the global APP_GUARD chain, on the layered method', () => {
      const route = findRoute(routes, 'both');
      expect(route.controllerGuards).toEqual(['FixtureGuardA']);
      expect(route.methodGuards).toEqual(['FixtureGuardB']);
      expect(route.effectiveGuards).toEqual(
        expect.arrayContaining([...GLOBAL_GUARD_NAMES, 'FixtureGuardA', 'FixtureGuardB']),
      );
    });

    it('still includes the controller-level guard on a method with no method-level guard of its own', () => {
      const route = findRoute(routes, 'controllerOnly');
      expect(route.controllerGuards).toEqual(['FixtureGuardA']);
      expect(route.methodGuards).toEqual([]);
      expect(route.effectiveGuards).toEqual(
        expect.arrayContaining([...GLOBAL_GUARD_NAMES, 'FixtureGuardA']),
      );
      expect(route.effectiveGuards).not.toContain('FixtureGuardB');
    });
  });
});
