import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';

/**
 * Owns persistence access to the Tenant aggregate for the runtime layer.
 *
 * It exists so that globally-consumed infrastructure (e.g. ActiveTenantGuard)
 * can depend on a GLOBAL provider instead of a feature-scoped repository.
 *
 * Why this matters (DI mechanics):
 *  - A guard referenced via `@UseGuards(Class)` is re-instantiated inside EACH
 *    consuming module, with its constructor resolved from THAT module's
 *    injector. So every dependency it has must be resolvable everywhere.
 *  - `TenantRepository` (from `TypeOrmModule.forFeature([Tenant])`) is scoped to
 *    this module only — it is NOT global, even though TenantContextModule is.
 *  - This service is a normal provider exported by the @Global() module, so it
 *    is instantiated ONCE here (where the repo lives) and the same singleton is
 *    injected everywhere. The repository never leaks past this module boundary.
 */
@Injectable()
export class TenantLookupService {
  constructor(
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
  ) {}

  /** Loads a tenant by id, or null if it does not exist. */
  findById(tenantId: string): Promise<Tenant | null> {
    return this.tenants.findOne({ where: { id: tenantId } });
  }
}
