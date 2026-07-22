import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Staff aggregate + children
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffService as StaffServiceEntity } from '../../entities/Staff/StaffService';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import { StaffTimeOff } from '../../entities/Staff/StaffTimeOff';
import { StaffCommission } from '../../entities/Staff/StaffCommission';
import { StaffRating } from '../../entities/Staff/StaffRating';

// Referenced resources (read/validation: same-tenant checks + reports)
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { User } from '../../entities/Auth&RBAC/User';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { Service } from '../../entities/Services/Service';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';

import { StaffService } from './staff.service';
import { StaffAccessService } from './staff-access.service';
import { StaffScheduleService } from './staff-schedule.service';
import { StaffTimeOffService } from './staff-time-off.service';
import { StaffCommissionService } from './staff-commission.service';
import { StaffRatingService } from './staff-rating.service';

import { StaffController } from './staff.controller';
import { WorkingHoursController } from './working-hours.controller';

import { AuthModule } from '../auth/auth.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { StorageModule } from '../storage/storage.module';

/**
 * Staff Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions)
 * from AuthModule, ActiveTenantGuard + TenantContextService from the global core
 * layer, and the global JwtAuthGuard.
 *
 * `forFeature` registers the staff aggregate + children, plus the referenced
 * resources the services re-load with a tenant filter (user, service, branch,
 * branch_users, appointments for commission/rating).
 *
 * Services are split by concern (SRP): profiles, scheduling/working-hours/
 * availability, time off, commissions, ratings.
 *
 * Imports AuthModule (StaffService.createWithNewUser reuses
 * AuthService.createUserWithRole — the same account/role creation logic
 * `POST /auth/register-user` uses — and RolesService for dynamic staff-role
 * assignability), SubscriptionBillingModule (UsageService, for the same
 * `max_users` plan-limit check), and StorageModule (StorageService, to
 * validate/resolve R2-backed avatar uploads via `POST /uploads`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      StaffProfile,
      StaffServiceEntity,
      StaffSchedule,
      WorkingHour,
      StaffTimeOff,
      StaffCommission,
      StaffRating,
      BranchUser,
      User,
      UserRole,
      PasswordReset,
      AuditLog,
      Service,
      Branch,
      Appointment,
    ]),
    AuthModule,
    SubscriptionBillingModule,
    StorageModule,
  ],
  controllers: [StaffController, WorkingHoursController],
  providers: [
    StaffService,
    StaffAccessService,
    StaffScheduleService,
    StaffTimeOffService,
    StaffCommissionService,
    StaffRatingService,
  ],
  exports: [
    StaffService,
    StaffAccessService,
    StaffScheduleService,
    StaffTimeOffService,
    StaffCommissionService,
    StaffRatingService,
  ],
})
export class StaffModule {}
