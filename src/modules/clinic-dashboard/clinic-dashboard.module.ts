import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { HandoverRequest } from '../../entities/AI Agent/HandoverRequest';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Branch } from '../../entities/SaaS-Core/Branch';

import { AnalyticsModule } from '../analytics/analytics.module';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';

import { DashboardSummaryController } from './dashboard-summary.controller';
import { DashboardSummaryService } from './dashboard-summary.service';

/**
 * The clinic/reception dashboard's own read surface.
 *
 * A LEAF module by design: it owns no entities, mutates nothing, and is
 * imported by nobody. It registers the four source entities read-only so it
 * can COUNT them (plus `Branch`, read-only, to confirm a requested
 * `?branchId=` filter belongs to the tenant), and pulls in the two existing
 * authorities it must not re-implement — `AnalyticsCacheService` (the
 * per-tenant Redis read-through, already used by the KPI snapshot and target
 * progress) and `AccessControlService` (the single feature/subscription
 * decision point). `BranchScopeService`/`StaffScopeService` are global
 * providers and need no import here.
 *
 * Deliberately NOT folded into `AnalyticsModule`: these counts are not
 * analytics data and must not inherit that module's `@RequireFeature(ANALYTICS)`
 * posture — see `DashboardSummaryController`'s docstring.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Appointment,
      Customer,
      StaffProfile,
      HandoverRequest,
      Tenant,
      Branch,
    ]),
    AnalyticsModule,
    SubscriptionBillingModule,
  ],
  controllers: [DashboardSummaryController],
  providers: [DashboardSummaryService],
})
export class ClinicDashboardModule {}
