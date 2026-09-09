import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffScopeService } from './staff-scope.service';

/**
 * `@Global` for the same reason `BranchScopeModule` is: this is a
 * cross-cutting SCOPE authority, injected by modules with no other
 * relationship to each other (appointments, clinic-dashboard, patient-queue,
 * staff). `AppRedisService` (the cache) comes from the `@Global` QueueModule,
 * so this module needs no imports beyond the `StaffProfile` repository.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([StaffProfile])],
  providers: [StaffScopeService],
  exports: [StaffScopeService],
})
export class StaffScopeModule {}
