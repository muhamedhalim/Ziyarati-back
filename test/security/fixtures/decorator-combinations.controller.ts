/**
 * Synthetic controllers exercising decorator combinations the route-metadata
 * harness (`nest-route-metadata.ts`) must resolve correctly. Never imported
 * by any real module — these exist only for `nest-route-metadata.spec.ts`
 * (T019) to assert against via `collectFromController()`, which reads
 * metadata directly off a class reference with no Nest boot involved.
 */
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Public } from '../../../src/modules/auth/decorators/public.decorator';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { RequirePermissions } from '../../../src/modules/auth/decorators/permissions.decorator';
import { RequireAnyPermission } from '../../../src/modules/auth/decorators/require-any-permission.decorator';
import { ApiKeyProtected } from '../../../src/modules/platform/decorators/api-key-protected.decorator';
import { INTEGRATION_SCOPE } from '../../../src/modules/platform/integration-scopes.constants';

class FixtureGuardA implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}
class FixtureGuardB implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

/**
 * Fixture 1 — controller-level `@Roles()` alongside a method-level
 * `@Public()`. `IS_PUBLIC_KEY` and `ROLES_KEY` are independent metadata
 * keys — `@Public()` does not clear an inherited `@Roles()`, it only makes
 * the *global* `JwtAuthGuard` bypass (verified against the real pattern in
 * `tenant.controller.ts`: `@UseGuards(RolesGuard)` at controller level,
 * `@Roles()` per method — `RolesGuard` itself is not a global guard and
 * always runs regardless of `@Public()`). So the public method here
 * correctly resolves `isPublic: true` **and** the controller's inherited
 * `roles: ['clinic_admin']` — this fixture proves the harness reads
 * `Reflector.getAllAndOverride` semantics faithfully rather than assuming
 * `@Public()` clears everything else; T020's actual invariant is what
 * decides whether that combination is safe (it is here: `RolesGuard` is
 * never attached in this fixture, so the inherited `roles` metadata is
 * inert either way).
 *
 * Fixture 2 — the SAME shape that fooled the original text-scanning
 * extractor: a `@Public()` method immediately followed by a sibling method
 * separated only by a multi-line `@ApiOperation({...})` block. An
 * upward-line-walk parser can leak the marker across that block onto the
 * neighbour; framework reflection cannot, because the metadata is attached
 * to the exact function object the decorator wrapped, never inferred from
 * source position.
 */
@Roles('clinic_admin')
@Controller('fixture/roles-and-public')
export class RolesControllerLevelPublicMethodFixture {
  @Public()
  @Get('public-one')
  publicOne(): void {
    // Fixture 2 continues below: this method is immediately followed by a
    // sibling separated by a multi-line @ApiOperation block, then a second
    // @Public() method — the exact adjacency that fooled the original
    // extractor's upward line-walk.
  }

  @ApiOperation({
    summary: 'A neighbouring, non-public operation',
    description: `
      Multi-line documentation block, deliberately long enough to span
      several lines — this is the exact shape ("an upward line-walk leaked a
      public-route marker across a multi-line documentation block into
      neighbouring methods") the spec's Edge Cases section names as the
      original audit's false-positive mechanism. A framework-metadata reader
      must not be fooled by it.
    `,
  })
  @Get('protected-neighbour')
  protectedNeighbour(): void {
    // Must resolve isPublic: false and roles: ['clinic_admin'] (inherited
    // from the controller) — proximity to `publicOne` above must not matter.
  }

  @Public()
  @Get('public-two')
  publicTwo(): void {
    // A second public method, immediately after the documented neighbour —
    // confirms the marker is read per-method, not "still open" from above.
  }
}

/**
 * Fixture 3 — `@RequirePermissions` on the controller, `@RequireAnyPermission`
 * on one method. Both keys are independent (PermissionsGuard combines them
 * with AND when both are present), so both must resolve on the method that
 * declares the second one, and only the controller-level one on its sibling.
 */
@RequirePermissions('appointments.read')
@Controller('fixture/permissions-and-any')
export class PermissionsControllerLevelAnyMethodFixture {
  @RequireAnyPermission('appointments.read_own', 'appointments.read')
  @Get('either')
  either(): void {}

  @Get('all-only')
  allOnly(): void {}
}

/**
 * Fixture 4 — the real, composed `@ApiKeyProtected()` decorator
 * (`applyDecorators(Public(), ApiKeyRoute(), UseGuards(...), RequireScopes(...))`).
 * Must resolve isPublic, isApiKeyRoute, integrationScopes and both guards
 * from ONE composed decorator application — proving `collectFromController`
 * handles `applyDecorators` composition, not just single decorators.
 */
@Controller('fixture/api-key-protected')
export class ApiKeyProtectedFixture {
  @ApiKeyProtected(INTEGRATION_SCOPE.SERVICES_READ)
  @Get('m2m')
  m2m(): void {}
}

/**
 * Fixture 5 — a controller-level guard plus a method-level guard on the same
 * method. `UseGuards` uses `extendArrayMetadata` (append, not overwrite) when
 * applied more than once at the SAME target, but controller-level and
 * method-level are two DIFFERENT targets — Nest unions them at runtime, and
 * so must this harness (T016's effective-guard-set requirement).
 */
@UseGuards(FixtureGuardA)
@Controller('fixture/layered-guards')
export class LayeredGuardsFixture {
  @UseGuards(FixtureGuardB)
  @Post('both')
  both(): void {}

  @Post('controller-only')
  controllerOnly(): void {}
}
