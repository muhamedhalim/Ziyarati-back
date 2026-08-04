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
  /**
   * True only for an anonymous guest principal minted by `GuestSessionService`
   * and verified by `WsAuthService` (signed `guest_token`, discovery tenant, no
   * roles or permissions). Set server-side after signature verification — never
   * from unverified input.
   *
   * This grants NOTHING. It exists so the orchestrator can record the guest
   * ownership binding (`AiSession.guestSubject`) when a guest starts a
   * conversation (FND-001). Authorization continues to come from `roles` /
   * `permissions`, which are re-resolved live per request.
   */
  guest?: boolean;
}
