import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRE_ACTIVE_SUBSCRIPTION_KEY } from '../decorators/require-active-subscription.decorator';
import { AccessControlService } from '../access-control.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';

/**
 * Enforces platform access on routes annotated with `@RequireActiveSubscription()`.
 *
 * Delegates the decision to AccessControlService (global mode → free override →
 * paid subscription), so enforcement is centralized and consistent everywhere.
 *
 * No tenant in context (e.g. a super-admin/platform call) is not gated here —
 * platform operators are never blocked by tenant billing state.
 *
 * To use it in another module, export AccessControlService + this guard from the
 * SubscriptionBillingModule and import that module where the guard is applied.
 */
@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessControlService,
    private readonly ctx: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRE_ACTIVE_SUBSCRIPTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // route not gated

    const tenantId = this.ctx.getTenantId();
    if (!tenantId) return true; // platform/super-admin context — nothing to gate

    await this.access.assertUsable(tenantId); // throws 403 when denied
    return true;
  }
}
