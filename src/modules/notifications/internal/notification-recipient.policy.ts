import type { PermissionSlug } from '../../../rbac/rbac.constants';

/**
 * WHO a notification goes to, expressed as a CLOSED union.
 *
 * This being closed is the whole point. The existing outbound listener resolves
 * its recipient with a bare ternary —
 * `context.userId ?? context.customerId ?? context.tenantId ?? tenantId` — so
 * "who gets this" is decided ad hoc at the call site, cannot be reviewed in one
 * place, and cannot be tested as a unit. Every internal notification instead
 * declares a policy value that `NotificationRecipientResolver` (and only it)
 * knows how to execute, which makes the tenant-isolation boundary a single
 * auditable function rather than a convention.
 *
 * Policies are DECLARATIVE DATA, not queries — this file deliberately imports
 * nothing from TypeORM so the catalog can depend on it without pulling in the
 * persistence layer.
 */
export type RecipientPolicy =
  /**
   * Everyone in the event's tenant holding `permission`.
   *
   * Resolves through `users → user_roles → roles → role_permissions →
   * permissions`, bounded by `users.tenantId = <event tenant>`. Because
   * `super_admin`'s `ALL_PERMISSIONS` wildcard is expanded into concrete
   * `role_permissions` rows at seed time, this needs no wildcard branch.
   */
  | { kind: 'TENANT_PERMISSION'; permission: PermissionSlug }
  /**
   * Platform operators holding `permission` — users with `tenantId IS NULL`.
   * Never returns a tenant user, whatever permissions that user happens to
   * hold.
   */
  | { kind: 'PLATFORM_PERMISSION'; permission: PermissionSlug }
  /**
   * Named users, pulled from the event context (e.g. the agent a handover was
   * assigned to). Ids are RE-VERIFIED against the event's scope before use, so
   * a stale or hostile id from another tenant is dropped rather than trusted.
   */
  | { kind: 'SPECIFIC_USERS'; userIds: readonly string[] }
  /** De-duplicated union of several policies. */
  | { kind: 'UNION'; policies: readonly RecipientPolicy[] };

/** Everyone in the event's tenant holding this permission. */
export const tenantPermission = (
  permission: PermissionSlug,
): RecipientPolicy => ({ kind: 'TENANT_PERMISSION', permission });

/** Platform operators (tenantId IS NULL) holding this permission. */
export const platformPermission = (
  permission: PermissionSlug,
): RecipientPolicy => ({ kind: 'PLATFORM_PERMISSION', permission });

/**
 * These specific users. Pass `undefined`/`null` freely — they are filtered out,
 * so a spec can write `specificUsers([ctx.assignedToUserId])` without guarding
 * a nullable field at every call site.
 */
export const specificUsers = (
  userIds: readonly (string | null | undefined)[],
): RecipientPolicy => ({
  kind: 'SPECIFIC_USERS',
  userIds: userIds.filter((id): id is string => !!id),
});

/** Union of several policies, de-duplicated by user id at resolve time. */
export const union = (
  ...policies: readonly RecipientPolicy[]
): RecipientPolicy => ({ kind: 'UNION', policies });
