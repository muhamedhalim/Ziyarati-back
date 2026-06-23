import { applyDecorators, UseGuards } from '@nestjs/common';

import { Public } from '../../auth/decorators/public.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PermissionSlug } from '../../../rbac/rbac.constants';
import { ApiKeyAuthGuard } from '../guards/api-key-auth.guard';

/**
 * Protects an EXTERNAL integration route with API-key auth + RBAC scopes.
 *
 *   @ApiKeyProtected(PERMISSION.CRM_READ)
 *   @Get('partner/customers')
 *   list() { ... }
 *
 * `@Public()` makes the global JwtAuthGuard step aside; ApiKeyAuthGuard then
 * authenticates the key and populates the principal, and PermissionsGuard
 * enforces the key's permission scopes (the key's `permissions` array).
 */
export function ApiKeyProtected(...permissions: PermissionSlug[]) {
  return applyDecorators(
    Public(),
    UseGuards(ApiKeyAuthGuard, PermissionsGuard),
    RequirePermissions(...permissions),
  );
}
