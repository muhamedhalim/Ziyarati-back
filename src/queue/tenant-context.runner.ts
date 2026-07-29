import { TenantContextService } from '../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from './worker-authorization.service';
import { BaseJobData } from './job-data.interface';

/**
 * Runs job logic inside a RESTORED tenant context (AsyncLocalStorage), after
 * verifying the job's tenant/actor are still valid.
 *
 * Reuses the existing TenantContextService so any domain code that reads
 * `requireTenantId()` / `getUser()` behaves exactly as under an HTTP request.
 * The worker holds no tenant state between jobs — each job opens its own ALS
 * store keyed by the job's `tenantId`, then tears it down. This is what keeps
 * workers stateless and safe to run on many replicas.
 *
 * `authz.assertAuthorized` runs FIRST (Phase 0 — see
 * docs/CACHING_QUEUES_AUDIT.md §0.5 item 6 / original audit H7): previously a
 * job's `tenantId`/`actorId` were trusted outright from the payload with no
 * re-check, so a tenant suspended after enqueue kept having work executed on
 * its behalf, and a forged/stale `actorId` became an unvalidated attribution
 * identity. A failed check throws `UnrecoverableError`, which BullMQ treats as
 * a permanent failure — no retry, since a suspended tenant or invalid actor
 * will not become valid by retrying the same job a few seconds later.
 *
 * `jobName` (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.8.10) is
 * threaded through to `assertAuthorized` so authorization is tiered by the
 * JOB'S declared policy (job-authorization.constants.ts), not inferred from
 * whether `data.tenantId` happens to be null on this particular invocation.
 *
 * Deliberately NOT declared `async`: this function must preserve the original
 * contract of throwing SYNCHRONOUSLY for a malformed call (e.g. a missing
 * `authz`/`ctx` argument) rather than returning a rejected promise — an
 * `async function` converts every throw, even one before the first `await`,
 * into a promise rejection, which turns a caller mistake into an unhandled
 * rejection if the caller doesn't `await`/`.catch()` the result (this is
 * exactly what broke `all-functions.spec.ts`'s generic smoke coverage, which
 * calls every exported function with several argument shapes inside a
 * try/catch that only catches SYNCHRONOUS throws). `.then()` chaining keeps
 * `authz.assertAuthorized(...)` itself throwing synchronously when `authz` is
 * not a real object, exactly like calling `ctx.run` on an invalid `ctx` always did.
 */
export function runInTenantContext<T>(
  ctx: TenantContextService,
  authz: WorkerAuthorizationService,
  jobName: string,
  data: BaseJobData,
  fn: () => Promise<T>,
): Promise<T> {
  return authz.assertAuthorized(jobName, data).then(() =>
    ctx.run(() => {
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
    }),
  );
}
