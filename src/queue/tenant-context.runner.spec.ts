import { UnrecoverableError } from 'bullmq';

import { runInTenantContext } from './tenant-context.runner';
import { TenantContextService } from '../core/tenant-context/tenant-context.service';

describe('runInTenantContext', () => {
  let ctx: TenantContextService;
  let authz: { assertAuthorized: jest.Mock };

  beforeEach(() => {
    ctx = new TenantContextService();
    authz = { assertAuthorized: jest.fn().mockResolvedValue(undefined) };
  });

  it('runs the authorization check BEFORE restoring the tenant context or calling fn', async () => {
    const order: string[] = [];
    authz.assertAuthorized.mockImplementationOnce(async () => {
      order.push('authz');
    });
    const fn = jest.fn(async () => {
      order.push('fn');
      return 'ok';
    });

    const result = await runInTenantContext(
      ctx,
      authz as never,
      'test.job',
      { tenantId: 't1' },
      fn,
    );

    expect(order).toEqual(['authz', 'fn']);
    expect(result).toBe('ok');
  });

  it('passes the job name through to authz.assertAuthorized (job-name-driven tiering — gap-closure pass)', async () => {
    await runInTenantContext(
      ctx,
      authz as never,
      'notifications.dispatch',
      { tenantId: 't1' },
      jest.fn(),
    );
    expect(authz.assertAuthorized).toHaveBeenCalledWith(
      'notifications.dispatch',
      { tenantId: 't1' },
    );
  });

  it('restores the principal from the job payload when tenantId is set', async () => {
    const fn = jest.fn(async () => {
      expect(ctx.getUser()).toMatchObject({ id: 'actor-1', tenantId: 't1' });
      return 'ok';
    });
    await runInTenantContext(
      ctx,
      authz as never,
      'test.job',
      { tenantId: 't1', actorId: 'actor-1' },
      fn,
    );
    expect(fn).toHaveBeenCalled();
  });

  it('does not set a principal for a system job (tenantId: null)', async () => {
    const fn = jest.fn(async () => {
      expect(ctx.getUser()).toBeNull();
      return 'ok';
    });
    await runInTenantContext(
      ctx,
      authz as never,
      'test.job',
      { tenantId: null },
      fn,
    );
    expect(fn).toHaveBeenCalled();
  });

  it('propagates an UnrecoverableError from authz WITHOUT ever calling fn', async () => {
    authz.assertAuthorized.mockRejectedValueOnce(
      new UnrecoverableError('tenant suspended'),
    );
    const fn = jest.fn();

    await expect(
      runInTenantContext(
        ctx,
        authz as never,
        'test.job',
        { tenantId: 't1' },
        fn,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws SYNCHRONOUSLY (not a rejected promise from an async-function context) when authz is missing — regression test for the crash this caused in all-functions.spec.ts', () => {
    // A non-async function that throws before returning does so synchronously;
    // an `async function` would instead return an (unhandled, if the caller
    // doesn't await/catch) rejected promise for the exact same mistake.
    expect(() =>
      runInTenantContext(
        ctx,
        undefined as never,
        'test.job',
        { tenantId: 't1' },
        jest.fn(),
      ),
    ).toThrow();
  });
});
