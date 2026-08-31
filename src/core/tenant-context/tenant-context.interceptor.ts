import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Request } from 'express';

import { TenantContextService } from './tenant-context.service';
import { AuthenticatedUser } from '../../modules/auth/interfaces/authenticated-user.interface';
import { Tenant } from '../../entities/SaaS-Core/Tenant';

/**
 * Populates the per-request TenantContext from the authenticated principal.
 *
 * Runs after the guard phase (so `request.user` is already set by JwtAuthGuard)
 * and before the controller/services, giving the whole downstream a ready
 * context. The ALS store itself is opened earlier by the request middleware.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly context: TenantContextService) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<Request>();
    const user = (request.user as AuthenticatedUser | undefined) ?? null;

    this.context.setPrincipal(user);

    // ActiveTenantGuard may have already loaded + stashed the tenant.
    const tenant = (request as { tenant?: Tenant }).tenant;
    if (tenant) {
      this.context.setTenant(tenant);
    }

    // 015-db-api-efficiency-audit — P10/T062. Same value (and same
    // `req.route.path` fallback-to-`req.path` shape) `ApiLoggingInterceptor`
    // already uses for `api_logs.endpoint` — set here, once, so every DB
    // query fired downstream of this interceptor can be attributed to it via
    // `getCurrentRequestRoute()`.
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;
    this.context.setRoute(route ?? null);

    return next.handle();
  }
}
