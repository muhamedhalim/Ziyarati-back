/**
 * Phase 7 permanent route-authorization invariants (FR-029…FR-034, US2).
 * Converts the frozen audit's point-in-time clean result (656 routes, 0
 * RBAC-without-guard, 20 public routes) into a permanent, semantic,
 * infrastructure-free guarantee. Reads framework metadata via
 * `nest-route-metadata.ts` — never source text (FR-032).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectMountedRoutes, type RouteEntry } from './nest-route-metadata';
import { TENANT_SCOPED_CONTROLLERS } from './tenant-scoped-controllers';

interface AllowlistEntry {
  method: string;
  path: string;
  reason: string;
}

// Read via fs rather than a static `import ... .json` — the repo's
// tsconfig.json does not set `resolveJsonModule`, and enabling it
// build-wide is outside this feature's scope for one test-only read.
const publicRoutesAllowlist: AllowlistEntry[] = JSON.parse(
  readFileSync(join(__dirname, 'public-routes.allowlist.json'), 'utf8'),
);

// Authenticated routes that deliberately declare NO role/permission (self-service, scope-keyed, ...).
const authenticatedNoPermissionAllowlist: AllowlistEntry[] = JSON.parse(
  readFileSync(join(__dirname, 'authenticated-no-permission.allowlist.json'), 'utf8'),
);

const ALLOWLIST_TIMEOUT = 30_000;

function routeLabel(r: RouteEntry): string {
  return `${r.httpMethod} ${r.path} (${r.controller}.${r.handler})`;
}

/** A route with no principal at all — @Public() and not authenticated by an API key either. */
function isGenuinelyPublic(r: RouteEntry): boolean {
  return r.metadata.isPublic && !r.metadata.isApiKeyRoute;
}

/**
 * Fails with every violating route named, plus the broken invariant — never
 * a bare `expect(violations).toHaveLength(0)` (FR-034).
 */
function expectNoViolations(invariantName: string, violations: string[]): void {
  if (violations.length > 0) {
    throw new Error(
      `[${invariantName}] ${violations.length} violation(s):\n` + violations.map((v) => `  - ${v}`).join('\n'),
    );
  }
}

describe('Route-authorization invariants (FR-029…FR-034)', () => {
  let routes: RouteEntry[];

  beforeAll(async () => {
    routes = await collectMountedRoutes();
  }, ALLOWLIST_TIMEOUT);

  it('boots via the metadata harness and sees a non-trivial route surface', () => {
    // Sanity floor, not a snapshot: the frozen baseline recorded 656 routes.
    // A number far below that would mean the harness silently failed to
    // discover most of the app rather than that the app shrank.
    expect(routes.length).toBeGreaterThan(500);
  });

  describe('FR-029 — no route declares a role or permission requirement without its enforcing guard', () => {
    it('every route requiring roles has RolesGuard in its effective guard set', () => {
      const violations = routes
        .filter((r) => r.metadata.roles.length > 0 && !r.effectiveGuards.includes('RolesGuard'))
        .map(
          (r) =>
            `${routeLabel(r)} declares roles ${JSON.stringify(r.metadata.roles)} but RolesGuard is not in its effective guard set (${r.effectiveGuards.join(', ')})`,
        );
      expectNoViolations('FR-029 roles-without-guard', violations);
    });

    it('every route requiring permissions (all-of or any-of) has PermissionsGuard in its effective guard set', () => {
      const violations = routes
        .filter(
          (r) =>
            (r.metadata.permissions.length > 0 || r.metadata.anyPermissions.length > 0) &&
            !r.effectiveGuards.includes('PermissionsGuard'),
        )
        .map(
          (r) =>
            `${routeLabel(r)} declares permissions ${JSON.stringify(r.metadata.permissions)}/anyPermissions ${JSON.stringify(r.metadata.anyPermissions)} but PermissionsGuard is not in its effective guard set (${r.effectiveGuards.join(', ')})`,
        );
      expectNoViolations('FR-029 permissions-without-guard', violations);
    });

    it('every API-key route requiring integration scopes has IntegrationScopeGuard in its effective guard set', () => {
      const violations = routes
        .filter(
          (r) =>
            r.metadata.integrationScopes.length > 0 &&
            !r.effectiveGuards.includes('IntegrationScopeGuard'),
        )
        .map(
          (r) =>
            `${routeLabel(r)} declares integrationScopes ${JSON.stringify(r.metadata.integrationScopes)} but IntegrationScopeGuard is not in its effective guard set (${r.effectiveGuards.join(', ')})`,
        );
      expectNoViolations('FR-029 integration-scopes-without-guard', violations);
    });

    it('reproduces the frozen baseline: 0 RBAC-without-guard violations across the mounted route set', () => {
      const violations = routes
        .filter((r) => r.metadata.roles.length > 0 && !r.effectiveGuards.includes('RolesGuard'))
        .concat(
          routes.filter(
            (r) =>
              (r.metadata.permissions.length > 0 || r.metadata.anyPermissions.length > 0) &&
              !r.effectiveGuards.includes('PermissionsGuard'),
          ),
        );
      expect(violations).toHaveLength(0);
    });
  });

  describe('FR-030 — the intentionally-public route set matches the checked-in allow-list', () => {
    it('every mounted, genuinely-public route is on the allow-list', () => {
      const allowed = new Set(publicRoutesAllowlist.map((e) => `${e.method} ${e.path}`));
      const violations = routes
        .filter(isGenuinelyPublic)
        .filter((r) => !allowed.has(`${r.httpMethod} ${r.path}`))
        .map(
          (r) =>
            `${routeLabel(r)} is public but is NOT on public-routes.allowlist.json — a route was made public without a deliberate allow-list edit`,
        );
      expectNoViolations('FR-030 public-route-not-allowlisted', violations);
    });

    it('every allow-list entry still corresponds to a real, mounted, public route (no stale entries)', () => {
      const live = new Set(
        routes.filter(isGenuinelyPublic).map((r) => `${r.httpMethod} ${r.path}`),
      );
      const violations = publicRoutesAllowlist
        .filter((e) => !live.has(`${e.method} ${e.path}`))
        .map((e) => `${e.method} ${e.path} is on the allow-list but no longer a live, mounted, public route`);
      expectNoViolations('FR-030 stale-allowlist-entry', violations);
    });

    it('reproduces the frozen baseline shape: the allow-list is exactly the live public-route set', () => {
      const allowed = new Set(publicRoutesAllowlist.map((e) => `${e.method} ${e.path}`));
      const live = new Set(routes.filter(isGenuinelyPublic).map((r) => `${r.httpMethod} ${r.path}`));
      expect(allowed).toEqual(live);
    });
  });

  describe('FR-031 — tenant-sensitive routes retain their tenant enforcement', () => {
    /**
     * Tenant-enforcement criterion (documented here per T023's requirement):
     * a route is "tenant-sensitive" when its controller is listed in
     * `tenant-scoped-controllers.ts` (a reviewed, checked-in snapshot of
     * controllers that currently enforce ActiveTenantGuard on every one of
     * their non-genuinely-public routes — see that file's own docstring for
     * why the reference set must be checked-in data rather than derived from
     * the same live run this test inspects, which would be circular). Every
     * such route — excluding genuinely-public ones, which have no principal
     * to scope — must carry ActiveTenantGuard in its effective guard set.
     */
    it('every non-public route on a tenant-scoped controller has ActiveTenantGuard in its effective guard set', () => {
      const tenantScoped = new Set(TENANT_SCOPED_CONTROLLERS);
      const violations = routes
        .filter((r) => tenantScoped.has(r.controller) && !isGenuinelyPublic(r))
        .filter((r) => !r.effectiveGuards.includes('ActiveTenantGuard'))
        .map(
          (r) =>
            `${routeLabel(r)} is on a tenant-scoped controller but ActiveTenantGuard is not in its effective guard set (${r.effectiveGuards.join(', ')})`,
        );
      expectNoViolations('FR-031 tenant-enforcement-missing', violations);
    });
  });

  describe('FR-035 — every authenticated route declares who may call it', () => {
    /**
     * A route behind the global JwtAuthGuard that carries no @Roles / @RequirePermissions /
     * @RequireAnyPermission is open to ANY signed-in user of ANY tenant role. That is correct for a handful of
     * self-service routes (the caller reads their own profile or inbox) and a vulnerability anywhere else, so
     * the set is checked-in and reviewed: a new authenticated route without an authorization decision fails
     * here until it declares one, or is added to the allow-list WITH a reason a reviewer accepts.
     * API-key routes are excluded: their authority is the key's scopes (IntegrationScopeGuard, asserted above).
     */
    const key = (r: { httpMethod: string; path: string }) => `${r.httpMethod} ${r.path}`;
    const declaresAuthorization = (r: RouteEntry) =>
      r.metadata.roles.length > 0 ||
      r.metadata.permissions.length > 0 ||
      r.metadata.anyPermissions.length > 0;

    const undeclared = () =>
      routes.filter((r) => !r.metadata.isPublic && !r.metadata.isApiKeyRoute && !declaresAuthorization(r));

    it('every authenticated, non-API-key route declares roles/permissions or is on the reviewed allow-list', () => {
      const allowed = new Set(authenticatedNoPermissionAllowlist.map((e) => `${e.method} ${e.path}`));
      const violations = undeclared()
        .filter((r) => !allowed.has(key(r)))
        .map(
          (r) =>
            `${routeLabel(r)} is reachable by ANY authenticated user: add @RequirePermissions/@Roles, or add it to authenticated-no-permission.allowlist.json with a reason`,
        );
      expectNoViolations('FR-035 authenticated-route-without-authorization', violations);
    });

    it('every allow-list entry still corresponds to a live authenticated route without a declaration (no stale entries)', () => {
      const live = new Set(undeclared().map(key));
      const violations = authenticatedNoPermissionAllowlist
        .filter((e) => !live.has(`${e.method} ${e.path}`))
        .map(
          (e) =>
            `${e.method} ${e.path} is on authenticated-no-permission.allowlist.json but is no longer such a route (removed, now public, or now declares authorization)`,
        );
      expectNoViolations('FR-035 stale-authenticated-allowlist-entry', violations);
    });

    it('every allow-list entry carries a real reason', () => {
      const violations = authenticatedNoPermissionAllowlist
        .filter((e) => !e.reason || e.reason.trim().length < 15)
        .map((e) => `${e.method} ${e.path} has no meaningful reason`);
      expectNoViolations('FR-035 allowlist-reason', violations);
    });

    if (process.env.PRINT_UNDECLARED === '1') {
      it('prints the undeclared set (diagnostic, enabled by PRINT_UNDECLARED=1)', () => {
        console.log(
          'UNDECLARED_START\n' +
            JSON.stringify(
              undeclared().map((r) => ({ method: r.httpMethod, path: r.path, controller: r.controller, handler: r.handler })),
              null,
              2,
            ) +
            '\nUNDECLARED_END',
        );
      });
    }
  });
});
