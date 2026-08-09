import type { Request } from 'express';
import type { Tenant } from '../../entities/SaaS-Core/Tenant';

/**
 * `JwtStrategy` stashes the `Tenant` row its own principal-resolution query
 * already loaded here so `ActiveTenantGuard` can reuse it instead of
 * re-querying the same tenant by id a second time (PERF-BE-003). HTTP-only,
 * request-scoped, never part of the `AuthenticatedUser` principal returned
 * to clients (e.g. `GET /auth/me`). `undefined` means "no hint available"
 * (e.g. API-key-authenticated requests, which never go through
 * `JwtStrategy`) — guards must fall back to their own lookup in that case,
 * never treat `undefined` as "tenant not found".
 */
export type PreloadedTenantRequest = Request & { preloadedTenant?: Tenant | null };
