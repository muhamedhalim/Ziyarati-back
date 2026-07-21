import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantApprovalStatus } from '../../entities/enums';
import { AuthenticatedUser } from '../../modules/auth/interfaces/authenticated-user.interface';
import { TenantContextService } from './tenant-context.service';
import { TenantLookupService } from './tenant-lookup.service';
import { ALLOW_INACTIVE_TENANT_KEY } from './allow-inactive-tenant.decorator';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Layer 3 of the runtime stack: "is this tenant allowed to use the system?"
 *
 * Opt-in guard for tenant BUSINESS endpoints (branches, appointments, billing,
 * …). Apply with `@UseGuards(ActiveTenantGuard)` at controller/handler level.
 * Runs after authentication, so `request.user` is populated.
 *
 * Rules:
 *  - super-admins / non-tenant principals (tenantId === null) bypass;
 *  - routes marked @AllowInactiveTenant() bypass (onboarding / self-service);
 *  - otherwise the tenant must be APPROVED and is_active === true, else 403.
 *
 * The loaded tenant is cached on the request + TenantContext so downstream code
 * never re-queries it.
 */
@Injectable()
export class ActiveTenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantLookup: TenantLookupService,
    private readonly context: TenantContextService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const allowInactive = this.reflector.getAllAndOverride<boolean>(
      ALLOW_INACTIVE_TENANT_KEY,
      [executionContext.getHandler(), executionContext.getClass()],
    );
    if (allowInactive) {
      return true;
    }

    const request = executionContext.switchToHttp().getRequest<Request>();
    const user = request.user as AuthenticatedUser | undefined;

    // No principal → authentication is enforced by JwtAuthGuard, not here.
    if (!user) {
      return true;
    }

    // Platform users (super-admin) and any non-tenant principal: nothing to gate.
    if (!user.tenantId) {
      return true;
    }

    const tenant = await this.tenantLookup.findById(user.tenantId);
    if (!tenant) {
      throw new AppError(ErrorCode.TENANT_NOT_FOUND);
    }

    if (
      tenant.approval_status !== TenantApprovalStatus.APPROVED ||
      !tenant.is_active
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        message: 'Your clinic is not currently allowed to access this resource.',
        publicContext: { tenantStatus: tenant.approval_status, isActive: tenant.is_active },
      });
    }

    // Cache for the interceptor / services.
    (request as { tenant?: Tenant }).tenant = tenant;
    this.context.setTenant(tenant);
    return true;
  }
}
