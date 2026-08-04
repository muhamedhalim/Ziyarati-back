import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { Role } from '../../entities/Auth&RBAC/Role';
import { Permission } from '../../entities/Auth&RBAC/Permission';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import { RolePermission } from '../../entities/Auth&RBAC/RolePermission';
import { RefreshToken } from '../../entities/Auth&RBAC/RefreshToken';
import { PasswordReset } from '../../entities/Auth&RBAC/PasswordReset';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Patient } from '../../entities/Patients/Patient';
import { AuditLog } from '../../entities/Auth&RBAC/AuditLog';

import { AuthService } from './auth.service';
import { RolesService } from './roles.service';
import { PermissionsService } from './permissions.service';
import { PatientService } from './patient.service';
import { CookieService } from './cookie.service';
import { LoginProtectionService } from './login-protection.service';

import { AuthController } from './auth.controller';
import { RolesController } from './roles.controller';
import { PermissionsController } from './permissions.controller';

import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';

import { SubscriptionBillingModule } from '../subscription-billing/subscription-billing.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Role,
      Permission,
      UserRole,
      RolePermission,
      RefreshToken,
      PasswordReset,
      Tenant,
      Patient,
      AuditLog,
    ]),
    PassportModule,
    // Per-operation secrets/TTLs are passed explicitly when signing (access vs
    // refresh use different secrets), so the module registration stays empty.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: () => ({}),
    }),
    ConfigModule,
    // Provides UsageService for plan-limit enforcement (max_users).
    SubscriptionBillingModule,
    // Provides SystemSettingService for registration gate (allow_tenant_registration).
    PlatformModule,
  ],
  controllers: [AuthController, RolesController, PermissionsController],
  providers: [
    AuthService,
    RolesService,
    PermissionsService,
    PatientService,
    CookieService,
    LoginProtectionService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
  ],
  exports: [AuthService, RolesService, PermissionsService],
})
export class AuthModule {}
