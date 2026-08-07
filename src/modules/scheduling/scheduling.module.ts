import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Owned scheduling entities
import { CalendarSlot } from '../../entities/Calendar&Appointments/CalendarSlot';
import { BlockedSlot } from '../../entities/Calendar&Appointments/BlockedSlot';
import { Holiday } from '../../entities/Calendar&Appointments/Holiday';

// Read-only references used by the availability engine / validators
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';

import { StaffModule } from '../staff/staff.module';

import { SchedulingRefService } from './scheduling-ref.service';
import { CalendarSlotService } from './calendar-slot.service';
import { BlockedSlotService } from './blocked-slot.service';
import { HolidayService } from './holiday.service';
import { AvailabilityService } from './availability.service';

import { CalendarSlotController } from './calendar-slot.controller';
import { BlockedSlotController } from './blocked-slot.controller';
import { HolidayController } from './holiday.controller';
import { AvailabilityController } from './availability.controller';

/**
 * Scheduling Domain — the availability engine for appointments.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService, and the global JwtAuthGuard. Every
 * query is tenant-scoped via relations; the tenant always comes from
 * TenantContext, never from request input.
 *
 * Composition:
 *  - CalendarSlot = positive availability (per staff+branch datetime windows),
 *  - BlockedSlot  = subtractive blocks (tenant/branch/staff-wide),
 *  - Holiday      = full-day exclusions (company-wide or branch),
 *  - Appointment  = occupancy (read-only; active statuses occupy time).
 *
 * AvailabilityService composes all four to answer check / windows / summary /
 * validate. Appointment / Branch / StaffProfile are registered read-only for
 * occupancy and tenant-ownership validation; this module never mutates them.
 * AvailabilityService is exported so the Appointment module can validate a
 * booking before creating it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CalendarSlot,
      BlockedSlot,
      Holiday,
      Appointment,
      Branch,
      StaffProfile,
      // Read-only: the branch⇄doctor link (`assertStaffAtBranch`). This module
      // never writes schedules — the Staff domain owns them.
      StaffSchedule,
    ]),
    // Reuse the Staff domain's recurring-schedule availability + time-off logic
    // instead of re-implementing it in the engine.
    StaffModule,
  ],
  controllers: [
    CalendarSlotController,
    BlockedSlotController,
    HolidayController,
    AvailabilityController,
  ],
  providers: [
    SchedulingRefService,
    CalendarSlotService,
    BlockedSlotService,
    HolidayService,
    AvailabilityService,
  ],
  exports: [AvailabilityService],
})
export class SchedulingModule {}
