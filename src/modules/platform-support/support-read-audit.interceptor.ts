import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import {
  PLATFORM_ADMIN_AUDIT_ACTION,
  PlatformAdminAuditService,
} from '../platform/platform-admin-audit.service';
import { SUPPORT_AUDIT_ENTITY } from './platform-support.constants';

/**
 * TSF-09 — records every Support diagnostic READ (actor, target clinic, route).
 *
 * Support is cross-tenant by design, so a read of another clinic's data must
 * leave an accountability trail like Support's writes already do. Only the
 * ROUTE TEMPLATE is stored — never query strings (clinic search terms can be
 * contact details) or path values other than the clinic id.
 * Best-effort: `PlatformAdminAuditService.record` never throws.
 */
@Injectable()
export class SupportReadAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: PlatformAdminAuditService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{
      user?: { id?: string };
      params?: Record<string, string>;
      route?: { path?: string };
    }>();
    const tenantId = req.params?.tenantId ?? null;
    await this.audit.record({
      action: PLATFORM_ADMIN_AUDIT_ACTION.SUPPORT_CLINIC_READ,
      userId: req.user?.id ?? null,
      entityType: SUPPORT_AUDIT_ENTITY,
      entityId: tenantId,
      tenantId,
      after: { route: req.route?.path ?? null },
    });
    return next.handle();
  }
}
