import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { StaffScopeService } from './staff-scope.service';

/**
 * `@Global` for the same reason `BranchScopeModule` is: this is a
 * cross-cutting SCOPE authority, injected by modules with no other
 * relationship to each other (appointments, clinic-dashboard, patient-queue,
 * staff). `AppRedisService` (the cache) comes from the `@Global` QueueModule
 * and `TenantContextService` from the `@Global` TenantContextModule, so this
 * module needs no imports beyond the `StaffProfile` and `Appointment`
 * repositories.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([StaffProfile, Appointment])],
  providers: [StaffScopeService],
  exports: [StaffScopeService],
})
export class StaffScopeModule {}
