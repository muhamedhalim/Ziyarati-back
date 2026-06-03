/**
 * The principal attached to `request.user` after the JwtStrategy validates a
 * request. Carries everything guards need to make authorization decisions
 * without hitting the database again on every request.
 */
export interface AuthenticatedUser {
  id: string;
  tenantId: string | null;
  email?: string | null;
  roles: string[]; // role slugs
  permissions: string[]; // permission slugs
}
