/**
 * Framework-native route/guard metadata harness for the permanent security
 * invariant suite (Phase 7, FR-029…FR-034). Boots the real `AppModule` in
 * Nest's `preview` mode — providers are never instantiated, so this needs no
 * Postgres and no Redis (evidence/invariant-mechanism.md) — then reads route
 * path, HTTP method, guard and RBAC/permission/API-key/CSRF-skip metadata the
 * exact way the real guards read it: `Reflect.getMetadata` on controller
 * prototypes and handler functions via the framework's own exported metadata
 * keys, and `@nestjs/core`'s own `Reflector.getAllAndOverride` (the same
 * method `JwtAuthGuard`/`RolesGuard`/`PermissionsGuard` call). No regex, no
 * line-proximity or upward-line-walk source-text parsing, anywhere (FR-032).
 *
 * `ModulesContainer` is read directly rather than through `DiscoveryService`:
 * `DiscoveryService`'s own constructor does not run under `preview: true` in
 * `@nestjs/core@11.1.24` (evidence/invariant-mechanism.md); `ModulesContainer`
 * is the lower-level class it wraps and is preview-safe because it is
 * registered inside `InternalCoreModule`, the one module `@nestjs/core`
 * always preview-initializes.
 */
import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { IS_PUBLIC_KEY } from '../../src/modules/auth/decorators/public.decorator';
import { ROLES_KEY } from '../../src/modules/auth/decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../../src/modules/auth/decorators/permissions.decorator';
import { ANY_PERMISSIONS_KEY } from '../../src/modules/auth/decorators/require-any-permission.decorator';
import { IS_API_KEY_ROUTE_KEY } from '../../src/modules/auth/decorators/api-key-route.decorator';
import { REQUIRE_SCOPES_KEY } from '../../src/modules/platform/decorators/require-scopes.decorator';
import { IS_SKIP_CSRF_KEY } from '../../src/modules/auth/decorators/skip-csrf.decorator';
import { NotificationWebhookController } from '../../src/modules/notifications/notification-webhook.controller';

type Ctor = new (...args: unknown[]) => unknown;
type HandlerFn = (...args: unknown[]) => unknown;

/**
 * The six global `APP_GUARD` providers registered in `app.module.ts`, in
 * their execution order. Reflect metadata never names them — they are never
 * `@UseGuards()`'d onto anything, so a handler's *effective* guard set is
 * this chain unioned with its own controller/method-level guards. Omitting
 * them produces a false positive on every single route (research.md R8) —
 * the single most likely way to rebuild the original audit's defect.
 */
export const GLOBAL_GUARD_NAMES = [
  'ThrottlerGuard',
  'JwtAuthGuard',
  'CsrfGuard',
  'MaintenanceGuard',
  'SubscriptionAccessGuard',
  'FeatureGuard',
] as const;

/**
 * Controllers that are declared in source but deliberately absent from every
 * module's `controllers` array (O1). `collectRoutes()` still reports their
 * routes, with `mounted: false`, because FR-039's constant-time invariant
 * must cover the *source* set, not just what Nest's own module graph would
 * ever serve. This list is intentionally small and named — it is not a
 * general "find every unmounted controller" source scan (that would need the
 * AST fallback this feature does not use); it names exactly the one
 * controller the spec/plan identify.
 */
const DECLARED_BUT_UNMOUNTED: readonly Ctor[] = [NotificationWebhookController];

export interface RouteDecoratorMetadata {
  isPublic: boolean;
  roles: string[];
  permissions: string[];
  anyPermissions: string[];
  isApiKeyRoute: boolean;
  integrationScopes: string[];
  isSkipCsrf: boolean;
}

export interface RouteEntry {
  controller: string;
  handler: string;
  httpMethod: string;
  path: string;
  mounted: boolean;
  metadata: RouteDecoratorMetadata;
  controllerGuards: string[];
  methodGuards: string[];
  /** global APP_GUARD chain ∪ controller-level __guards__ ∪ method-level __guards__ */
  effectiveGuards: string[];
}

const reflector = new Reflector();

function guardNames(target: object): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
  return guards
    .map((g) => (typeof g === 'function' ? (g as { name?: string }).name : undefined))
    .filter((name): name is string => !!name);
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function httpMethodName(methodEnum: number | undefined): string {
  if (methodEnum === undefined) return 'UNKNOWN';
  const name = RequestMethod[methodEnum];
  return typeof name === 'string' ? name : String(methodEnum);
}

/** Mirrors Nest's own path-joining: collapse duplicate slashes, no trailing slash except root. */
function joinPath(prefix: string | undefined, methodPath: string | undefined): string {
  const combined = `/${prefix ?? ''}/${methodPath ?? ''}`.replace(/\/+/g, '/');
  return combined.length > 1 ? combined.replace(/\/$/, '') : combined;
}

function readDecoratorMetadata(handler: HandlerFn, controllerClass: Ctor): RouteDecoratorMetadata {
  const targets = [handler, controllerClass] as unknown as Parameters<
    Reflector['getAllAndOverride']
  >[1];
  return {
    isPublic: !!reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets),
    roles: reflector.getAllAndOverride<string[]>(ROLES_KEY, targets) ?? [],
    permissions: reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [],
    anyPermissions: reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets) ?? [],
    isApiKeyRoute: !!reflector.getAllAndOverride<boolean>(IS_API_KEY_ROUTE_KEY, targets),
    integrationScopes: reflector.getAllAndOverride<string[]>(REQUIRE_SCOPES_KEY, targets) ?? [],
    isSkipCsrf: !!reflector.getAllAndOverride<boolean>(IS_SKIP_CSRF_KEY, targets),
  };
}

/**
 * Reads route/guard/decorator metadata off a single controller class via
 * pure `Reflect`/`Reflector` calls — no Nest boot required. Exported so the
 * harness's own fixture tests (T018/T019) can assert against synthetic
 * controllers without paying for `collectRoutes()`'s app boot, and reused by
 * `collectRoutes()` itself for both the real module graph and the
 * declared-but-unmounted set.
 */
export function collectFromController(metatype: Ctor, mounted: boolean): RouteEntry[] {
  const entries: RouteEntry[] = [];
  const controllerPrefix: string | undefined = Reflect.getMetadata(PATH_METADATA, metatype);
  const controllerGuards = guardNames(metatype);
  const prototype = metatype.prototype as Record<string, unknown>;

  for (const propertyName of Object.getOwnPropertyNames(prototype)) {
    if (propertyName === 'constructor') continue;
    const handler = prototype[propertyName];
    if (typeof handler !== 'function') continue;

    const methodPath: string | undefined = Reflect.getMetadata(PATH_METADATA, handler);
    if (methodPath === undefined) continue; // not an HTTP route handler — a plain method

    const methodEnum: number | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
    const methodGuards = guardNames(handler as HandlerFn as unknown as object);
    const metadata = readDecoratorMetadata(handler as HandlerFn, metatype);

    entries.push({
      controller: metatype.name,
      handler: propertyName,
      httpMethod: httpMethodName(methodEnum),
      path: joinPath(controllerPrefix, methodPath),
      mounted,
      metadata,
      controllerGuards,
      methodGuards,
      effectiveGuards: dedupe([...GLOBAL_GUARD_NAMES, ...controllerGuards, ...methodGuards]),
    });
  }
  return entries;
}

interface BuildResult {
  routes: RouteEntry[];
  mountedControllerTypes: Set<Ctor>;
}

let cached: Promise<BuildResult> | null = null;

async function build(): Promise<BuildResult> {
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });

  const modulesContainer = app.get(ModulesContainer, { strict: false });
  const routes: RouteEntry[] = [];
  const mountedControllerTypes = new Set<Ctor>();

  for (const moduleRef of modulesContainer.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const metatype = wrapper.metatype as Ctor | undefined;
      if (typeof metatype !== 'function') continue;
      mountedControllerTypes.add(metatype);
      routes.push(...collectFromController(metatype, true));
    }
  }

  for (const metatype of DECLARED_BUT_UNMOUNTED) {
    if (mountedControllerTypes.has(metatype)) continue; // became mounted — not this harness's concern to hide it
    routes.push(...collectFromController(metatype, false));
  }

  await app.close();
  return { routes, mountedControllerTypes };
}

/** Every route this harness can see — real (mounted) and declared-but-unmounted. */
export async function collectRoutes(): Promise<RouteEntry[]> {
  if (!cached) cached = build();
  return (await cached).routes;
}

/** Route/public-route invariants must use only what would actually serve traffic. */
export async function collectMountedRoutes(): Promise<RouteEntry[]> {
  return (await collectRoutes()).filter((r) => r.mounted);
}

export async function isControllerMounted(controllerClass: Ctor): Promise<boolean> {
  if (!cached) cached = build();
  return (await cached).mountedControllerTypes.has(controllerClass);
}
