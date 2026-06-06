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
  private readonly als = new AsyncLocalStorage<TenantContextStore>();

  /** Opens an isolated context for the lifetime of one request. */
  run<T>(callback: () => T): T {
    return this.als.run({ user: null, tenant: null }, callback);
  }

  setPrincipal(user: AuthenticatedUser | null): void {
    const store = this.als.getStore();
    if (store) store.user = user;
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
