import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../../modules/auth/interfaces/authenticated-user.interface';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { ROLE } from '../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../common/errors';

interface TenantContextStore {
  user: AuthenticatedUser | null;
  /** The loaded tenant entity, cached by ActiveTenantGuard to avoid re-querying. */
  tenant: Tenant | null;
  /** Request/job correlation id — propagated into enqueued jobs + logs. */
  correlationId: string | null;
  /**
   * Express-matched route pattern for the current request (e.g.
   * `/appointments/:id`) — the same value `ApiLoggingInterceptor` uses for
   * `api_logs.endpoint`. Set by `TenantContextInterceptor`, once routing has
   * matched but before the handler runs, so every DB query the request
   * fires can be attributed to it. `null` outside an HTTP request (a worker
   * job) or before routing has matched.
   */
  route: string | null;
}

/**
 * The ALS instance itself, exported as a plain module binding (015-db-api-
 * efficiency-audit — P10/T062) so `typeorm.config.ts`'s query logger can read
 * the current route WITHOUT going through Nest DI. Injecting
 * `TenantContextService` into `TypeOrmModule.forRootAsync`'s factory would be
 * circular: `TenantContextModule` imports `TypeOrmModule.forFeature([Tenant])`,
 * which itself depends on the root `TypeOrmModule.forRootAsync` connection
 * existing first. A plain function import has no such module-graph edge.
 * Still exactly ONE store per request — `TenantContextService` reads/writes
 * this SAME instance, never a second one.
 */
const tenantContextAls = new AsyncLocalStorage<TenantContextStore>();

/** DI-free reader for `typeorm.config.ts` — see `tenantContextAls`'s docstring. */
export function getCurrentRequestRoute(): string | null {
  return tenantContextAls.getStore()?.route ?? null;
}

/** The trusted identity fields a log line may carry — see {@link getTenantLogContext}. */
export interface TenantLogContext {
  requestId: string | null;
  userId: string | null;
  tenantId: string | null;
  platformAdmin: boolean;
}

/**
 * DI-free reader for the structured logger (`common/logging`), for the same
 * module-graph reason as `getCurrentRequestRoute`. Only reads what
 * authentication (or `runInTenantContext`, after its authorization check)
 * already put in the store — never a header or a body — so a log line can
 * never carry a tenant id the caller merely claimed. Returns `null` outside a
 * request or job.
 */
export function getTenantLogContext(): TenantLogContext | null {
  const store = tenantContextAls.getStore();
  if (!store) return null;
  const user = store.user;
  return {
    requestId: store.correlationId,
    userId: user?.id ?? null,
    tenantId: user?.tenantId ?? null,
    platformAdmin:
      !!user && user.tenantId === null && (user.roles ?? []).includes(ROLE.SUPER_ADMIN),
  };
}

/**
 * Single source of truth for "which tenant is this request running under?".
 *
 * Backed by AsyncLocalStorage rather than a Nest request-scoped provider, so it
 * stays a singleton (no scope cascade / per-request instantiation of every
 * consumer) while still giving each request an isolated store. It can therefore
 * be injected anywhere — services, guards, interceptors — with zero overhead.
 *
 * The store is opened once per request by a thin middleware (see main.ts) and
 * populated by TenantContextInterceptor after authentication has run.
 */
@Injectable()
export class TenantContextService {
  private readonly als = tenantContextAls;

  /** Opens an isolated context for the lifetime of one request (or one job). */
  run<T>(callback: () => T): T {
    return this.als.run(
      { user: null, tenant: null, correlationId: null, route: null },
      callback,
    );
  }

  setPrincipal(user: AuthenticatedUser | null): void {
    const store = this.als.getStore();
    if (store) store.user = user;
  }

  setCorrelationId(correlationId: string | null): void {
    const store = this.als.getStore();
    if (store) store.correlationId = correlationId;
  }

  getCorrelationId(): string | null {
    return this.als.getStore()?.correlationId ?? null;
  }

  /** See `TenantContextStore.route`'s docstring. */
  setRoute(route: string | null): void {
    const store = this.als.getStore();
    if (store) store.route = route;
  }

  setTenant(tenant: Tenant | null): void {
    const store = this.als.getStore();
    if (store) store.tenant = tenant;
  }

  getUser(): AuthenticatedUser | null {
    return this.als.getStore()?.user ?? null;
  }

  getTenantId(): string | null {
    return this.als.getStore()?.user?.tenantId ?? null;
  }

  /** The tenant entity if it was loaded this request (e.g. by ActiveTenantGuard). */
  getTenant(): Tenant | null {
    return this.als.getStore()?.tenant ?? null;
  }

  isSuperAdmin(): boolean {
    const user = this.getUser();
    return (
      !!user && user.tenantId === null && user.roles.includes(ROLE.SUPER_ADMIN)
    );
  }

  /**
   * Returns the current tenantId or throws. Replaces the per-controller
   * `requireTenant(user.tenantId)` helpers — one enforcement point for all.
   */
  requireTenantId(): string {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'A tenant context is required for this operation',
      });
    }
    return tenantId;
  }
}
