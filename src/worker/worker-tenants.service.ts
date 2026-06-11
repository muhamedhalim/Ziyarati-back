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
}
