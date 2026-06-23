import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { ApiKeyService } from '../api-key.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Authenticates machine-to-machine requests with a platform API key.
 *
 * Accepts the key via `X-API-Key: zk_...` or `Authorization: ApiKey zk_...`.
 * On success it builds a synthetic principal (`request.user`) carrying the key's
 * tenant + permissions and pushes it into the tenant context, so the SAME
 * downstream stack (PermissionsGuard, tenant-scoped services, `requireTenantId`)
 * works identically to a JWT request.
 *
 * Use via {@link ApiKeyProtected} on external integration routes — it also marks
 * the route @Public() so the global JwtAuthGuard steps aside for the key.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly ctx: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const presented = this.extractKey(req);
    const auth = await this.apiKeys.authenticate(presented); // throws UNAUTHORIZED on failure

    const user: AuthenticatedUser = {
      id: `apikey:${auth.keyId}`,
      tenantId: auth.tenantId,
      email: null,
      roles: [],
      permissions: auth.permissions,
    };
    (req as Request & { user?: AuthenticatedUser }).user = user;
    this.ctx.setPrincipal(user);
    return true;
  }

  private extractKey(req: Request): string | undefined {
    const headerKey = req.header('x-api-key');
    if (headerKey) return headerKey.trim();
    const authz = req.header('authorization');
    if (authz && /^ApiKey\s+/i.test(authz)) return authz.replace(/^ApiKey\s+/i, '').trim();
    return undefined;
  }
}
