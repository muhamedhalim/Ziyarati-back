import { Module } from '@nestjs/common';

import { PlatformDashboardService } from './platform-dashboard.service';
import { DashboardAlertsService } from './dashboard-alerts.service';
import { PlatformDashboardController } from './platform-dashboard.controller';
import { PlatformMonitoringModule } from '../platform-monitoring/platform-monitoring.module';
import { SupportTicketsModule } from '../support-tickets/support-tickets.module';
import { PlatformUsageModule } from '../platform-usage/platform-usage.module';

/**
 * Platform Control Center (super-admin).
 *
 * A composition layer, not a new domain. It imports the modules that already own
 * each answer — infrastructure health, ticket counts, quota classification — so
 * the dashboard REUSES their logic rather than growing a second copy that can
 * drift. The only queries written here are the ones no existing service
 * expresses: platform-wide lifecycle counts, growth series, plan mix, renewals,
 * tenant-health evidence, and the activity projection.
 *
 * `RolesGuard` resolves from the global Reflector, exactly as in
 * `PlatformFinanceModule` / `PlatformUsageModule`. `DataSource` and
 * `ConfigService` are global.
 */
@Module({
  imports: [PlatformMonitoringModule, SupportTicketsModule, PlatformUsageModule],
  controllers: [PlatformDashboardController],
  providers: [PlatformDashboardService, DashboardAlertsService],
})
export class PlatformDashboardModule {}
