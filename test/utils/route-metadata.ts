import { GUARDS_METADATA } from '@nestjs/common/constants';

import { ROLES_KEY } from '../../src/modules/auth/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../../src/modules/auth/decorators/permissions.decorator';

/**
 * Test helpers that read the authorization metadata a controller actually declares, so a controller
 * spec can pin "this route needs X" without booting the app. They read the same keys the guards read
 * (`ROLES_KEY`, `PERMISSIONS_KEY`, Nest's `GUARDS_METADATA`), so a refactor that drops a decorator
 * fails the spec instead of silently opening a route.
 */
type Ctor = abstract new (...args: never[]) => object;

export function guardNames(controller: Ctor): string[] {
  const guards: { name: string }[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
  return guards.map((g) => g.name);
}

export function classRoles(controller: Ctor): string[] {
  return Reflect.getMetadata(ROLES_KEY, controller) ?? [];
}

/** Permissions required by one handler (`@RequirePermissions`). */
export function handlerPermissions(controller: Ctor, handler: string): string[] {
  const fn = (controller.prototype as Record<string, unknown>)[handler];
  return Reflect.getMetadata(PERMISSIONS_KEY, fn as object) ?? [];
}
