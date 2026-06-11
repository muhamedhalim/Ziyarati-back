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
import { Payment } from '../../entities/Payments/Payment';
import { Customer } from '../../entities/CRM/Customer';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Conversation } from '../../entities/Conversations/Conversation';
import { CustomerReview } from '../../entities/CRM/CustomerReview';

import { AnalyticsEventService } from './analytics-event.service';
import { DashboardMetricService } from './dashboard-metric.service';
import { DailyReportService } from './daily-report.service';
import { MonthlyReportService } from './monthly-report.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';

import { AnalyticsEventController } from './analytics-event.controller';
import { DashboardController } from './dashboard.controller';
import { DailyReportController } from './daily-report.controller';
import { MonthlyReportController } from './monthly-report.controller';

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
    ]),
  ],
  controllers: [
    AnalyticsEventController,
    DashboardController,
    DailyReportController,
    MonthlyReportController,
  ],
  providers: [
    AnalyticsEventService,
    DashboardMetricService,
    DailyReportService,
    MonthlyReportService,
    AnalyticsAggregationService,
  ],
  exports: [
    AnalyticsEventService,
    AnalyticsAggregationService,
    // Exposed so the background worker's analytics processor can reuse them.
    DashboardMetricService,
    DailyReportService,
    MonthlyReportService,
  ],
})
export class AnalyticsModule {}
