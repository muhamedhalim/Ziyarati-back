import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tenant } from '../entities/SaaS-Core/Tenant';
import { TenantApprovalStatus } from '../entities/enums';

/**
 * Worker-side directory of active tenants. Scheduled (repeatable) sweep jobs use
 * it to fan out per-tenant jobs, so each tenant's work runs tenant-scoped and
 * retries independently.
 */
@Injectable()
export class WorkerTenantsService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenants: Repository<Tenant>,
  ) {}

  async activeTenantIds(): Promise<string[]> {
    const rows = await this.tenants.find({
      where: {
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      },
      select: { id: true },
    });
    return rows.map((t) => t.id);
  }

  /**
   * One PAGE of active tenant ids, ordered deterministically by `id` (gap-closure
   * — see docs/CACHING_QUEUES_AUDIT.md M7): `activeTenantIds()` above loads every
   * active tenant in one unbounded query, which a large-tenant-count sweep
   * (5 000+ tenants) turns into an expensive single round trip. Sweep fan-outs
   * page through this instead, `limit` at a time, so both the DB read and the
   * resulting `addBulk` calls stay bounded regardless of tenant count.
   */
  async activeTenantIdsPage(offset: number, limit: number): Promise<string[]> {
    const rows = await this.tenants.find({
      where: {
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      },
      select: { id: true },
      order: { id: 'ASC' },
      skip: offset,
      take: limit,
    });
    return rows.map((t) => t.id);
  }
}
