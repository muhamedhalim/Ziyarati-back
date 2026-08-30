import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Owned analytics entities
import { AnalyticsEvent } from '../../entities/Analytics/AnalyticsEvent';
import { DailyReport } from '../../entities/Analytics/DailyReport';
import { MonthlyReport } from '../../entities/Analytics/MonthlyReport';
import { DashboardMetric } from '../../entities/Analytics/DashboardMetric';

// Read-only source entities used by the aggregation engine
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';
import { Payment } from '../../entities/Payments/Payment';
import { Customer } from '../../entities/CRM/Customer';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Conversation } from '../../entities/Conversations/Conversation';
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
// Spec 014 (Clinic Platform Completion) — T145 (US11). Read-only here too:
// AdvancedAnalyticsService only READS `branch_users` (to scope a
// branch-restricted caller, FR-A016) and `tenant_settings` (the clinic's
// configured currency, FR-A021) — it never mutates either.
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';

import { AnalyticsEventService } from './analytics-event.service';
import { DashboardMetricService } from './dashboard-metric.service';
import { DailyReportService } from './daily-report.service';
import { MonthlyReportService } from './monthly-report.service';
import { StaffPerformanceService } from './staff-performance.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AnalyticsCacheService } from './analytics-cache.service';
import { AnalyticsRetentionService } from './analytics-retention.service';
import { AnalyticsSchemaBootstrap } from './analytics-schema.bootstrap';
import { AdvancedAnalyticsService } from './advanced-analytics.service';

import { AnalyticsEventController } from './analytics-event.controller';
import { DashboardController } from './dashboard.controller';
import { DailyReportController } from './daily-report.controller';
import { MonthlyReportController } from './monthly-report.controller';
import { StaffPerformanceController } from './staff-performance.controller';
import { AdvancedAnalyticsController } from './advanced-analytics.controller';

/**
 * Analytics Domain.
 *
 * Builds on existing infrastructure: RBAC (PermissionsGuard / @RequirePermissions),
 * ActiveTenantGuard + TenantContextService (tenant scope), and the global
 * JwtAuthGuard. Every query is tenant-scoped via relations; the tenant always
 * comes from TenantContext, never from request input.
 *
 * Pipeline:
 *  1. Ingestion      — AnalyticsEventService writes raw events.
 *  2. Aggregation    — AnalyticsAggregationService (the ONLY heavy-compute unit;
 *                      reads source domains read-only).
 *  3. Materialization — DailyReportService / MonthlyReportService precompute and
 *                      upsert per-branch report rows (immutable to clients).
 *  4. Fast read      — DashboardMetricService serves a precomputed KPI snapshot
 *                      with no computation on the request path.
 *
 * Source entities are registered read-only so the aggregation engine can query
 * them; this module never mutates other domains' data.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AnalyticsEvent,
      DailyReport,
      MonthlyReport,
      DashboardMetric,
      Branch,
      Appointment,
      AppointmentService,
      Payment,
      Customer,
      AiMessage,
      Conversation,
      CustomerReview,
      StaffProfile,
      AppointmentCancellation,
      BranchUser,
      TenantSetting,
    ]),
  ],
  controllers: [
    AnalyticsEventController,
    DashboardController,
    DailyReportController,
    MonthlyReportController,
    StaffPerformanceController,
    AdvancedAnalyticsController,
  ],
  providers: [
    AnalyticsEventService,
    DashboardMetricService,
    DailyReportService,
    MonthlyReportService,
    StaffPerformanceService,
    AnalyticsAggregationService,
    AnalyticsCacheService,
    AnalyticsRetentionService,
    AnalyticsSchemaBootstrap,
    AdvancedAnalyticsService,
  ],
  exports: [
    AnalyticsEventService,
    AnalyticsAggregationService,
    // Exposed so the background worker's analytics processor can reuse them.
    DashboardMetricService,
    DailyReportService,
    MonthlyReportService,
    AnalyticsRetentionService,
    // Exposed so TenantModule can cache the dashboard target-progress read
    // under the same per-tenant `dashboard` cache namespace.
    AnalyticsCacheService,
    StaffPerformanceService,
    // T181 (spec 014, US13) — ReportExportModule reuses `resolveScope` (the
    // ONE branch-scope resolution, FR-A016) and the row-returning query
    // methods; never a second implementation.
    AdvancedAnalyticsService,
  ],
})
export class AnalyticsModule {}
