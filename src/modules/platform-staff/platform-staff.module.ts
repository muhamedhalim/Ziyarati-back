import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';

import { PlatformStaffService } from './platform-staff.service';
import { PlatformStaffController } from './platform-staff.controller';

import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';

/**
 * Super Admin management of Platform Customer Service staff.
 *
 * Reuses AuthModule (AuthService.createUserWithRole for account creation —
 * the SAME chokepoint /auth/register-user and the clinic staff flow use,
 * carrying the D7 global email-uniqueness guarantee automatically —
 * plus issuePasswordSetupToken/passwordSetupUrl/revokeAllForUser) and
 * PlatformModule (PlatformAdminAuditService, the established platform-admin
 * audit writer). EmailModule is @Global() so EmailService needs no explicit
 * import (mirrors StaffModule).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Role, UserRole, PasswordReset]),
    AuthModule,
    PlatformModule,
  ],
  controllers: [PlatformStaffController],
  providers: [PlatformStaffService],
  exports: [PlatformStaffService],
})
export class PlatformStaffModule {}
