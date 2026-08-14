import { Module } from '@nestjs/common';

import { PlatformDashboardService } from './platform-dashboard.service';
import { PlatformDashboardController } from './platform-dashboard.controller';

/**
 * Platform Control Center (super-admin).
 *
 * A composition layer, not a new domain: later phases inject
 * `MarketplaceFinanceService`, `PlatformUsageService`, `MonitoringService`,
 * `SupportTicketService` and `FinancialMetricsService` here so the dashboard
 * reuses the platform's existing analytics rather than growing a parallel copy
 * of them. Phase 1 needs only `DataSource` + `ConfigService`, both global.
 *
 * `RolesGuard` resolves from the global Reflector, exactly as in
 * `PlatformFinanceModule` / `PlatformUsageModule`.
 */
@Module({
  controllers: [PlatformDashboardController],
  providers: [PlatformDashboardService],
})
export class PlatformDashboardModule {}
