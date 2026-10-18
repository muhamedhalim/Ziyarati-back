import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantVerificationDocument } from '../../entities/SaaS-Core/TenantVerificationDocument';
import { TenantApprovalEvent } from '../../entities/SaaS-Core/TenantApprovalEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';

import { TenantTarget } from '../../entities/SaaS-Core/TenantTarget';
import { TenantTargetHistory } from '../../entities/SaaS-Core/TenantTargetHistory';
import { BranchScopeModule } from '../../core/branch-scope/branch-scope.module';
import { TenantService } from './tenant.service';
import { TenantTargetsService } from './tenant-targets.service';
import { BranchService } from './branch.service';
import { BranchCityService } from './branch-city.service';
import { TenantVerificationService } from './tenant-verification.service';

import { TenantController } from './tenant.controller';
import { BranchController } from './branch.controller';
import { TenantVerificationController } from './tenant-verification.controller';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { StorageModule } from '../storage/storage.module';
import { VerificationAuditModule } from '../verification-audit/verification-audit.module';
import { AdminNotificationModule } from '../admin-notifications/admin-notification.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';

/**
 * Tenant aggregate root: the clinic and everything it directly owns —
 * settings (1:1), verification documents, approval events (audit), and
 * branches. RBAC guards/decorators are reused from AuthModule (which exports
 * them); RolesGuard depends only on the global JwtAuthGuard having populated
 * `request.user`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantSetting,
      TenantVerificationDocument,
      TenantApprovalEvent,
      TenantTarget,
      TenantTargetHistory,
      Branch,
      // Read-only here: BranchService only counts these to enforce safe
      // deletion (staff assignments / upcoming appointments), it never
      // mutates them — StaffModule/AppointmentModule own the write paths.
      BranchUser,
      Appointment,
    ]),
    // Provides UsageService for plan-limit enforcement (max_branches).
    SubscriptionBillingModule,
    // Provides StorageService so verification can validate/sign R2 objects.
    StorageModule,
    // Append-only audit trail + super-admin notifications for verification.
    VerificationAuditModule,
    AdminNotificationModule,
    // Provides AnalyticsAggregationService/AnalyticsCacheService for the
    // dashboard target-progress read (GET/PATCH /tenants/me/targets).
    AnalyticsModule,
    // Audit record when the clinic switches the WhatsApp AI on or off.
    ActivityLogModule,
    // Branch-scope authority for the per-branch targets.
    BranchScopeModule,
  ],
  controllers: [
    TenantController,
    BranchController,
    TenantVerificationController,
  ],
  providers: [
    TenantService,
    TenantTargetsService,
    BranchService,
    BranchCityService,
    TenantVerificationService,
  ],
  exports: [TenantService, BranchService, TenantVerificationService],
})
export class TenantModule {}
