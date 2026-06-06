import { SetMetadata } from '@nestjs/common';

export const ALLOW_INACTIVE_TENANT_KEY = 'allowInactiveTenant';

/**
 * Exempts a route from ActiveTenantGuard. Use on tenant self-service endpoints
 * that must remain reachable while a tenant is pending/suspended — e.g. viewing
 * tenant status, uploading verification documents to get re-approved, or
 * account actions (change password / logout).
 */
export const AllowInactiveTenant = () =>
  SetMetadata(ALLOW_INACTIVE_TENANT_KEY, true);
