import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';

import { User } from '../entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../entities/enums';
import { TenantLookupService } from '../core/tenant-context/tenant-lookup.service';
import { AuthService } from '../modules/auth/auth.service';
import { ROLE } from '../rbac/rbac.constants';
import { BaseJobData } from './job-data.interface';
import { JOB_AUTHZ_POLICY, resolveJobAuthzPolicy } from './job-authorization.constants';

interface CacheEntry {
  ok: boolean;
  expiresAt: number;
}

/**
 * Tiered authorization for background jobs (Phase 0 — see
 * docs/CACHING_QUEUES_AUDIT.md §0.5 item 6 / original audit H7; job-name-driven
 * tiering added in the gap-closure pass, §0.8.10).
 *
 * Before Phase 0, `runInTenantContext` built a synthetic principal straight
 * from the job payload with NO verification — a job for a tenant suspended
 * AFTER the job was enqueued kept executing until the queue drained, and a
 * forged or stale `actorId` became an unvalidated attribution identity written
 * into audit columns (`booked_by`, `cancelled_by`, ...).
 *
 * Tiering is now keyed by the JOB NAME (`job-authorization.constants.ts`), not
 * inferred from `!data.tenantId` — see that file's docstring for the full
 * rationale (a job type's own payload shape, not its instantaneous value,
 * decides what "no tenant" means for it).
 *
 * CACHE STALENESS (documented explicitly, not left implicit): tenant/actor
 * validity is cached for 30s. A tenant or actor suspended mid-window can still
 * have UP TO ~30s of jobs execute before the next lookup observes the
 * suspension — an accepted, bounded staleness window, not a real-time
 * revocation guarantee. A queue processing many jobs/second for the same
 * tenant must not turn into one DB round trip per job just to re-confirm the
 * same fact; closing this window fully would require an event-driven
 * cache-bust on suspend/deactivate, which is a reasonable Phase 1 follow-on,
 * not implemented here.
 *
 * Deliberately does NOT build a full `AuthenticatedUser` for every job — that
 * would mean an extra join/lookup for a permission set nothing checks. The
 * ONE exception (`workflow.action`, see job-authorization.constants.ts) calls
 * `AuthService.buildAuthenticatedUser` — the SAME method HTTP guards rely on —
 * only when that job's policy declares a `requiredPermission` AND the job
 * actually carries an actor.
 */
@Injectable()
export class WorkerAuthorizationService {
  private readonly logger = new Logger('WorkerAuthorization');
  private static readonly CACHE_TTL_MS = 30_000;

  private readonly tenantCache = new Map<string, CacheEntry>();
  private readonly actorCache = new Map<string, CacheEntry>();
  private readonly permissionCache = new Map<string, CacheEntry>();

  constructor(
    private readonly tenantLookup: TenantLookupService,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly authService: AuthService,
  ) {}

  /**
   * Throws `UnrecoverableError` (BullMQ: fail permanently, no retry, no DLQ —
   * matches the convention already used for permanent failures elsewhere in
   * the worker) when the job's tenant/actor/permission is not currently valid.
   */
  async assertAuthorized(jobName: string, data: BaseJobData): Promise<void> {
    // FAIL CLOSED (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md
    // §0.8.7): a job name missing from JOB_AUTHZ_POLICY is rejected
    // permanently rather than silently inferred as the most permissive tier.
    // A new job type someone forgets to register here must be loud (a failed
    // job an operator investigates), never a quiet unchecked execution.
    if (!(jobName in JOB_AUTHZ_POLICY)) {
      this.logger.error(
        `FAIL-CLOSED: no authorization policy registered for job "${jobName}" — rejecting permanently. ` +
          'Register it in job-authorization.constants.ts before this job type can run.',
      );
      throw new UnrecoverableError(
        `No authorization policy registered for job "${jobName}" — job permanently rejected (fail-closed)`,
      );
    }
    const policy = resolveJobAuthzPolicy(jobName);

    if (policy.tier === 'system') {
      if (data.tenantId) {
        this.logger.debug(`system-tier job "${jobName}" unexpectedly carries tenantId=${data.tenantId} — proceeding anyway`);
      }
      return;
    }

    if (policy.tier === 'system-or-tenant' && !data.tenantId) {
      return; // the sweep/system-level invocation of a dual-purpose job name
    }

    // 'tenant' tier, or 'system-or-tenant' WITH a real tenantId: a tenantId is
    // now REQUIRED — a 'tenant'-tier job's own data type guarantees one, so a
    // null value at runtime means data corruption or a misconfigured caller,
    // not a legitimate system invocation (that silent-downgrade is exactly
    // the bug this tiering closes).
    if (!data.tenantId) {
      this.logger.warn(`Rejecting job "${jobName}": tier "${policy.tier}" requires a tenantId but none was present`);
      throw new UnrecoverableError(`Job "${jobName}" is tenant-scoped but carries no tenantId — job permanently rejected`);
    }

    await this.assertTenantActive(data.tenantId);

    if (data.actorId && data.actorId !== 'system') {
      await this.assertActorValid(data.tenantId, data.actorId);
      if (policy.requiredPermission) {
        await this.assertActorHasPermission(data.tenantId, data.actorId, policy.requiredPermission);
      }
    }
  }

  private async assertTenantActive(tenantId: string): Promise<void> {
    const cached = this.readCache(this.tenantCache, tenantId);
    if (cached !== undefined) {
      if (!cached) this.rejectTenant(tenantId);
      return;
    }

    const tenant = await this.tenantLookup.findById(tenantId);
    const ok = !!tenant && tenant.approval_status === TenantApprovalStatus.APPROVED && tenant.is_active;
    this.writeCache(this.tenantCache, tenantId, ok);
    if (!ok) this.rejectTenant(tenantId);
  }

  private async assertActorValid(tenantId: string, actorId: string): Promise<void> {
    const key = `${tenantId}:${actorId}`;
    const cached = this.readCache(this.actorCache, key);
    if (cached !== undefined) {
      if (!cached) this.rejectActor(tenantId, actorId);
      return;
    }

    const user = await this.users.findOne({ where: { id: actorId }, relations: { tenant: true } });
    const ok = !!user && user.is_active && user.tenant?.id === tenantId;
    this.writeCache(this.actorCache, key, ok);
    if (!ok) this.rejectActor(tenantId, actorId);
  }

  /**
   * Reuses `AuthService.buildAuthenticatedUser` (the same permission
   * resolution HTTP's `PermissionsGuard` relies on) rather than a second RBAC
   * join. `super_admin` bypasses, mirroring `PermissionsGuard`'s own rule.
   */
  private async assertActorHasPermission(tenantId: string, actorId: string, permission: string): Promise<void> {
    const key = `${actorId}:${permission}`;
    const cached = this.readCache(this.permissionCache, key);
    if (cached !== undefined) {
      if (!cached) this.rejectPermission(tenantId, actorId, permission);
      return;
    }

    let ok: boolean;
    try {
      const principal = await this.authService.buildAuthenticatedUser(actorId);
      ok = principal.roles.includes(ROLE.SUPER_ADMIN) || principal.permissions.includes(permission as never);
    } catch {
      ok = false; // inactive/missing user — treated as lacking the permission
    }
    this.writeCache(this.permissionCache, key, ok);
    if (!ok) this.rejectPermission(tenantId, actorId, permission);
  }

  private rejectTenant(tenantId: string): never {
    this.logger.warn(`Rejecting job: tenant ${tenantId} is not APPROVED+active`);
    throw new UnrecoverableError(`Tenant ${tenantId} is not active — job permanently rejected`);
  }

  private rejectActor(tenantId: string, actorId: string): never {
    this.logger.warn(`Rejecting job: actor ${actorId} is not an active member of tenant ${tenantId}`);
    throw new UnrecoverableError(`Actor ${actorId} is not a valid, active member of tenant ${tenantId} — job permanently rejected`);
  }

  private rejectPermission(tenantId: string, actorId: string, permission: string): never {
    this.logger.warn(`Rejecting job: actor ${actorId} (tenant ${tenantId}) lacks required permission "${permission}"`);
    throw new UnrecoverableError(`Actor ${actorId} lacks required permission "${permission}" — job permanently rejected`);
  }

  private readCache(cache: Map<string, CacheEntry>, key: string): boolean | undefined {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.ok;
    return undefined;
  }

  private writeCache(cache: Map<string, CacheEntry>, key: string, ok: boolean): void {
    cache.set(key, { ok, expiresAt: Date.now() + WorkerAuthorizationService.CACHE_TTL_MS });
  }
}
