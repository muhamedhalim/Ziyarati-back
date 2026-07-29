import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnrecoverableError } from 'bullmq';

import { User } from '../entities/Auth&RBAC/User';
import { TenantApprovalStatus } from '../entities/enums';
import { TenantLookupService } from '../core/tenant-context/tenant-lookup.service';
import { BaseJobData } from './job-data.interface';

interface CacheEntry {
  ok: boolean;
  expiresAt: number;
}

/**
 * Tiered authorization for background jobs (Phase 0 — see
 * docs/CACHING_QUEUES_AUDIT.md §0.5 item 6 / original audit H7).
 *
 * Before this, `runInTenantContext` built a synthetic principal straight from
 * the job payload with NO verification — a job for a tenant suspended AFTER
 * the job was enqueued kept executing until the queue drained, and a forged or
 * stale `actorId` became an unvalidated attribution identity written into
 * audit columns (`booked_by`, `cancelled_by`, ...).
 *
 * Three tiers, by what the job payload actually carries:
 *  - SYSTEM jobs (`tenantId: null` — platform-wide sweeps: analytics,
 *    settlements, subscriptions, etc.) skip entirely. There is no tenant or
 *    actor to check.
 *  - TENANT jobs (`tenantId` set, no real `actorId`) verify the tenant is
 *    APPROVED and active.
 *  - ACTOR jobs (`tenantId` + a real `actorId`) additionally verify the actor
 *    exists, is active, and belongs to that tenant.
 *
 * Deliberately does NOT build a full `AuthenticatedUser` (roles/permissions) —
 * that would mean an extra join/lookup on every single job for a permission
 * set nothing currently checks (no job type declares a required permission
 * today; `runInTenantContext` already stamps `permissions: []` on the restored
 * context, so any downstream check fails closed regardless). This service
 * only proves existence/membership/active-status, which is what attribution
 * integrity actually depends on.
 *
 * Both tenant and actor results are cached briefly (mirrors
 * `SystemSettingService`'s TTL-cache pattern) — a queue processing hundreds of
 * jobs/second for the same tenant must not turn into hundreds of DB round
 * trips/second just to re-confirm the same fact.
 */
@Injectable()
export class WorkerAuthorizationService {
  private readonly logger = new Logger('WorkerAuthorization');
  private static readonly CACHE_TTL_MS = 30_000;

  private readonly tenantCache = new Map<string, CacheEntry>();
  private readonly actorCache = new Map<string, CacheEntry>();

  constructor(
    private readonly tenantLookup: TenantLookupService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * Throws `UnrecoverableError` (BullMQ: fail permanently, no retry, no DLQ —
   * matches the convention already used for permanent failures elsewhere in
   * the worker) when the job's tenant/actor is not currently valid.
   */
  async assertAuthorized(data: BaseJobData): Promise<void> {
    if (!data.tenantId) return; // SYSTEM job — nothing to check

    await this.assertTenantActive(data.tenantId);

    if (data.actorId && data.actorId !== 'system') {
      await this.assertActorValid(data.tenantId, data.actorId);
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

  private rejectTenant(tenantId: string): never {
    this.logger.warn(`Rejecting job: tenant ${tenantId} is not APPROVED+active`);
    throw new UnrecoverableError(`Tenant ${tenantId} is not active — job permanently rejected`);
  }

  private rejectActor(tenantId: string, actorId: string): never {
    this.logger.warn(`Rejecting job: actor ${actorId} is not an active member of tenant ${tenantId}`);
    throw new UnrecoverableError(`Actor ${actorId} is not a valid, active member of tenant ${tenantId} — job permanently rejected`);
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
