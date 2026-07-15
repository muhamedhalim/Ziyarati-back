import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Permission } from '../../entities/Auth&RBAC/Permission';
import { Role } from '../../entities/Auth&RBAC/Role';

import { PermissionsAuditService } from './permissions-audit.service';
import { RbacAuditService } from './rbac-audit.service';
import { RbacAuditController } from './rbac-audit.controller';

/**
 * Permissions & Access-Control Audit Center (super-admin).
 *
 * Read-only reporting/audit layer over the existing RBAC entities — introduces
 * no parallel roles/permissions system and never mutates grants. `RolesGuard`
 * resolves from the global Reflector (registered app-wide), so no extra guard
 * wiring is needed here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Permission, Role])],
  controllers: [RbacAuditController],
  providers: [PermissionsAuditService, RbacAuditService],
})
export class RbacAuditModule {}
