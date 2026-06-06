import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { TenantVerificationDocument } from '../../entities/SaaS-Core/TenantVerificationDocument';
import { TenantApprovalEvent } from '../../entities/SaaS-Core/TenantApprovalEvent';
import { Branch } from '../../entities/SaaS-Core/Branch';

import { TenantService } from './tenant.service';
import { BranchService } from './branch.service';
import { TenantVerificationService } from './tenant-verification.service';

import { TenantController } from './tenant.controller';
import { BranchController } from './branch.controller';
import { TenantVerificationController } from './tenant-verification.controller';

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
      Branch,
    ]),
  ],
  controllers: [
    TenantController,
    BranchController,
    TenantVerificationController,
  ],
  providers: [TenantService, BranchService, TenantVerificationService],
  exports: [TenantService, BranchService, TenantVerificationService],
})
export class TenantModule {}
