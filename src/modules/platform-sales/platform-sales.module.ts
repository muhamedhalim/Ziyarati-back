import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { PlatformStaffModule } from '../platform-staff/platform-staff.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { TenantModule } from '../tenant/tenant.module';

import { ClinicImportController } from './clinic-import.controller';
import { ClinicImportService } from './clinic-import.service';
import { SalesActivitiesController } from './sales-activities.controller';
import { SalesActivityService } from './sales-activity.service';
import { SalesAssignmentImportController } from './sales-assignment-import.controller';
import { SalesAssignmentImportService } from './sales-assignment-import.service';
import { SalesAssignmentService } from './sales-assignment.service';
import { SalesAssignmentsController } from './sales-assignments.controller';
import { SalesBonusesController } from './sales-bonuses.controller';
import { SalesBonusService } from './sales-bonus.service';
import { SalesEmployeeService } from './sales-employee.service';
import { SalesEmployeesController } from './sales-employees.controller';
import { SalesProgressService } from './sales-progress.service';
import { SalesSelfController } from './sales-self.controller';
import { SalesSelfService } from './sales-self.service';
import { SalesTargetService } from './sales-target.service';
import { SalesTargetsController } from './sales-targets.controller';

/**
 * Sales Staff Management.
 *
 * Owns NO employee table and no authentication: a sales employee is a
 * `platform_sales` platform user managed through `/platform/staff`
 * (PlatformStaffModule). This module adds clinic ownership (with history) and
 * the read models around it: monthly targets, bonuses (server-computed, approved into
 * an immutable record) and the manually logged field-activity trail.
 *
 * Every query goes through the shared DataSource as set-based SQL — the
 * listings are page-first and the bulk writes are single statements — so no
 * TypeORM repositories are registered here.
 */
@Module({
  imports: [
    AuthModule,
    PlatformModule,
    PlatformStaffModule,
    SubscriptionBillingModule,
    TenantModule,
  ],
  controllers: [
    SalesEmployeesController,
    // Static `clinic-import/*` paths, kept ahead of the parameterised routes.
    ClinicImportController,
    // Static `assignments/import|export` paths first; there is no `assignments/:id`
    // today, but a future param route must not be able to shadow them.
    SalesAssignmentImportController,
    SalesAssignmentsController,
    SalesTargetsController,
    SalesBonusesController,
    SalesActivitiesController,
    SalesSelfController,
  ],
  providers: [
    SalesEmployeeService,
    ClinicImportService,
    SalesAssignmentService,
    SalesAssignmentImportService,
    SalesProgressService,
    SalesTargetService,
    SalesBonusService,
    SalesActivityService,
    SalesSelfService,
  ],
  exports: [SalesEmployeeService],
})
export class PlatformSalesModule {}
