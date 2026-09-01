import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { BranchScopeService } from './branch-scope.service';

/**
 * `@Global` for the same reason {@link TenantContextModule} is: this is a
 * cross-cutting SCOPE authority, injected by modules that have no other
 * relationship with each other (appointments, staff, activity-log,
 * clinic-dashboard, analytics, patient-queue, tenant). Threading an explicit
 * import through all seven would add module-graph edges that carry no meaning
 * beyond "needs the scope", and risks a cycle the moment one of them is
 * imported back.
 *
 * `AppRedisService` (the membership cache) comes from the `@Global`
 * QueueModule, so this module needs no imports of its own beyond the
 * `branch_users` repository.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BranchUser])],
  providers: [BranchScopeService],
  exports: [BranchScopeService],
})
export class BranchScopeModule {}
