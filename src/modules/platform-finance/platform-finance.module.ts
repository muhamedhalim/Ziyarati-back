import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Payment } from '../../entities/Payments/Payment';
import { Transaction } from '../../entities/Payments/Transaction';
import { Refund } from '../../entities/Payments/Refund';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { MarketplaceFinanceService } from './marketplace-finance.service';
import { FinancialAuditService } from './financial-audit.service';
import { PlatformFinanceController } from './platform-finance.controller';

/**
 * Platform-owner Marketplace Financial Operations (super-admin).
 *
 * Read-only reporting layer over the existing payments ledger — no parallel
 * financial system. RolesGuard resolves from the global Reflector; tenant
 * context is global. Reuses `audit_logs` for view/export auditing.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Payment, Transaction, Refund, AuditLog])],
  controllers: [PlatformFinanceController],
  providers: [MarketplaceFinanceService, FinancialAuditService],
  // Exported so the Platform Control Center reuses the marketplace ledger
  // aggregation rather than writing a second one over the same tables.
  exports: [MarketplaceFinanceService],
})
export class PlatformFinanceModule {}
