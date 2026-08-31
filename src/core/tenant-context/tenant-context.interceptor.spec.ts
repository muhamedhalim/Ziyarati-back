import { of } from 'rxjs';

import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContextService } from './tenant-context.service';
import { createMockExecutionContext } from '../../../test/utils/mock-factories';

describe('TenantContextInterceptor', () => {
  let interceptor: TenantContextInterceptor;
  let context: TenantContextService;

  beforeEach(() => {
    context = new TenantContextService();
    interceptor = new TenantContextInterceptor(context);
  });

  const next = { handle: jest.fn(() => of('ok')) };

  it('populates the principal (and tenant) from the request, then proceeds', () => {
    const user = { id: 'u1', tenantId: 't1', roles: ['owner'], permissions: [] };
    const tenant = { id: 't1' };
    const setPrincipal = jest.spyOn(context, 'setPrincipal');
    const setTenant = jest.spyOn(context, 'setTenant');

    // Run within an ALS store so the setters have somewhere to write.
    context.run(() => {
      const ctx = createMockExecutionContext({ user, tenant });
      interceptor.intercept(ctx, next as any);
    });

    expect(setPrincipal).toHaveBeenCalledWith(user);
    expect(setTenant).toHaveBeenCalledWith(tenant);
    expect(next.handle).toHaveBeenCalled();
  });

  it('handles an unauthenticated request (null principal, no tenant)', () => {
    const setTenant = jest.spyOn(context, 'setTenant');
    context.run(() => {
      const ctx = createMockExecutionContext({});
      interceptor.intercept(ctx, next as any);
    });
    expect(setTenant).not.toHaveBeenCalled();
  });

  // ── 015-db-api-efficiency-audit — P10/T062 ──────────────────────────────

  it('falls back to req.path when Express has not attached a matched route (e.g. a 404)', () => {
    const setRoute = jest.spyOn(context, 'setRoute');
    context.run(() => {
      const ctx = createMockExecutionContext({ path: '/no-such-route' });
      interceptor.intercept(ctx, next as any);
    });
    expect(setRoute).toHaveBeenCalledWith('/no-such-route');
  });

  it('prefers the matched route template over the raw path when both exist', () => {
    const setRoute = jest.spyOn(context, 'setRoute');
    context.run(() => {
      const ctx = createMockExecutionContext({
        path: '/appointments/real-uuid-123',
        route: { path: '/appointments/:id' },
      });
      interceptor.intercept(ctx, next as any);
    });
    expect(setRoute).toHaveBeenCalledWith('/appointments/:id');
  });
});
