import { TenantContextService } from '../core/tenant-context/tenant-context.service';
import { BaseJobData } from './job-data.interface';

/**
 * Runs job logic inside a RESTORED tenant context (AsyncLocalStorage).
 *
 * Reuses the existing TenantContextService so any domain code that reads
 * `requireTenantId()` / `getUser()` behaves exactly as under an HTTP request.
 * The worker holds no tenant state between jobs — each job opens its own ALS
 * store keyed by the job's `tenantId`, then tears it down. This is what keeps
 * workers stateless and safe to run on many replicas.
 */
export function runInTenantContext<T>(
  ctx: TenantContextService,
  data: BaseJobData,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.run(() => {
    if (data.tenantId) {
      ctx.setPrincipal({
        id: data.actorId ?? 'system',
        tenantId: data.tenantId,
        email: null,
        roles: [],
        permissions: [],
      });
    }
    if (data.correlationId) ctx.setCorrelationId(data.correlationId);
    return fn();
  });
}
