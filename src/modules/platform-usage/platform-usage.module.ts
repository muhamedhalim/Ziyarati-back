import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';
import { UsageReportSchedule } from '../../entities/System/UsageReportSchedule';
import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';

import { PlatformUsageService } from './platform-usage.service';
import { PlatformUsageController } from './platform-usage.controller';
import { UsageAuditService } from './usage-audit.service';
import { UsageReportService } from './usage-report.service';
import { UsageReportController } from './usage-report.controller';
import { OVERAGE_PRICING } from './usage-forecast';
import { NoopOveragePricing } from './noop-overage-pricing';

/**
 * Super-admin Platform Usage dashboard.
 *
 * Read-only cross-tenant aggregation layered on the Subscription Module (the
 * single source of truth): it imports `SubscriptionBillingModule` to reuse
 * `UsageService` / `SubscriptionService` / `AccessControlService` rather than
 * re-implementing quota logic. `QueueService` (queue depths) is global. Batched
 * SQL over existing domain tables supplies activity counts + drill-down series.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, UsageReportSchedule]),
    SubscriptionBillingModule,
  ],
  controllers: [PlatformUsageController, UsageReportController],
  providers: [
    PlatformUsageService,
    UsageAuditService,
    UsageReportService,
    // Overage pricing is pluggable — swap this binding for a real price book to
    // switch on cost projection without touching any dashboard code (PART 4).
    { provide: OVERAGE_PRICING, useClass: NoopOveragePricing },
  ],
  exports: [PlatformUsageService, UsageReportService],
})
export class PlatformUsageModule {}
