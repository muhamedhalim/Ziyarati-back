import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { User } from '../../../entities/Auth&RBAC/User';
import { NOTIFICATION_SCOPE, type NotificationScope } from './notification-keys';
import type { RecipientPolicy } from './notification-recipient.policy';

/** The minimum a recipient needs: who they are and what language to render in. */
export interface ResolvedRecipient {
  readonly id: string;
  readonly preferredLocale: string | null;
}

/**
 * ============================================================================
 *  THE TENANT-ISOLATION BOUNDARY FOR INTERNAL NOTIFICATIONS
 * ============================================================================
 *
 * Every internal notification's recipient set is produced here and nowhere
 * else. That concentration is the point: cross-tenant leakage is the
 * highest-severity failure this subsystem can have, so it gets exactly one
 * implementation, one set of stated invariants, and one negative test suite
 * (`test/internal-notifications-negative.e2e-spec.ts`) aimed squarely at it.
 *
 * INVARIANTS — each has a dedicated test:
 *
 *  1. A TENANT-scope notification resolves ONLY users whose own
 *     `users.tenantId` equals the event's tenant. The USER's own tenant column
 *     is the boundary — never the role's, never the request's, never an id
 *     supplied by a caller.
 *  2. A PLATFORM-scope notification resolves ONLY users with
 *     `users.tenantId IS NULL`. A tenant user cannot receive one however many
 *     permissions they hold.
 *  3. `SPECIFIC_USERS` ids are RE-VERIFIED against the scope. An id from
 *     another tenant is dropped silently rather than trusted or thrown on, so
 *     one stale id cannot suppress the notification for everyone else.
 *  4. Inactive (`is_active = false`) and soft-deleted (`deleted_at IS NOT
 *     NULL`) users are never recipients.
 *  5. Soft-deleted roles (`roles.deleted_at IS NOT NULL`) never grant
 *     recipiency — matching how `PermissionsAuditService` counts effective
 *     users.
 *  6. The actor is excluded by default. Nobody is notified of their own
 *     action.
 *  7. No wildcard branch is needed for `super_admin`: `ALL_PERMISSIONS` is
 *     expanded into concrete `role_permissions` rows by
 *     `role-permissions.seed.ts`, so the permission join finds platform
 *     operators naturally. A test asserts this so a future seeder change
 *     cannot silently drop every platform recipient.
 *
 * A TENANT-scope resolve with a null `tenantId` returns nothing rather than
 * falling back to "all users" — the failure mode of a bug here must be silence,
 * never a broadcast.
 */
@Injectable()
export class NotificationRecipientResolver {
  private readonly logger = new Logger('NotificationRecipientResolver');

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /**
   * Resolves a policy to a de-duplicated recipient list.
   *
   * @param scope    TENANT or PLATFORM — decides which isolation rule applies.
   * @param tenantId The event's clinic. Required for TENANT scope, ignored for PLATFORM.
   * @param policy   The catalog spec's declared recipient policy.
   * @param opts.actorUserId    Excluded from the result unless `includeActor`.
   * @param opts.targetUserIds  Feeds `SPECIFIC_USERS` policies.
   */
  async resolve(
    scope: NotificationScope,
    tenantId: string | null,
    policy: RecipientPolicy,
    opts: {
      actorUserId?: string | null;
      targetUserIds?: readonly (string | null | undefined)[];
      includeActor?: boolean;
    } = {},
  ): Promise<ResolvedRecipient[]> {
    if (scope === NOTIFICATION_SCOPE.TENANT && !tenantId) {
      // Fail silent, never broad. A TENANT notification with no tenant is a
      // producer bug; resolving it as "everyone" would turn that bug into a
      // cross-tenant disclosure.
      this.logger.error(
        'TENANT-scope notification resolved with no tenantId — refusing to resolve any recipient',
      );
      return [];
    }

    const found = await this.execute(scope, tenantId, policy, opts.targetUserIds);

    const byId = new Map<string, ResolvedRecipient>();
    for (const recipient of found) {
      byId.set(recipient.id, recipient);
    }
    if (!opts.includeActor && opts.actorUserId) {
      byId.delete(opts.actorUserId);
    }
    return [...byId.values()];
  }

  private async execute(
    scope: NotificationScope,
    tenantId: string | null,
    policy: RecipientPolicy,
    targetUserIds: readonly (string | null | undefined)[] | undefined,
  ): Promise<ResolvedRecipient[]> {
    switch (policy.kind) {
      case 'TENANT_PERMISSION':
        // A TENANT_PERMISSION policy on a PLATFORM-scope notification is a
        // catalog authoring mistake. Resolving it against `tenantId IS NULL`
        // would quietly do something nobody intended, so refuse instead.
        if (scope !== NOTIFICATION_SCOPE.TENANT) {
          this.logger.error(
            `TENANT_PERMISSION policy used on a ${scope}-scope notification — ignored`,
          );
          return [];
        }
        return this.byPermission(policy.permission, tenantId);

      case 'PLATFORM_PERMISSION':
        if (scope !== NOTIFICATION_SCOPE.PLATFORM) {
          this.logger.error(
            `PLATFORM_PERMISSION policy used on a ${scope}-scope notification — ignored`,
          );
          return [];
        }
        return this.byPermission(policy.permission, null);

      case 'SPECIFIC_USERS': {
        const ids = [
          ...new Set(
            [...policy.userIds, ...(targetUserIds ?? [])].filter(
              (id): id is string => !!id,
            ),
          ),
        ];
        if (ids.length === 0) return [];
        return this.verifiedUsers(ids, scope, tenantId);
      }

      case 'UNION': {
        const groups = await Promise.all(
          policy.policies.map((p) =>
            this.execute(scope, tenantId, p, targetUserIds),
          ),
        );
        return groups.flat();
      }
    }
  }

  /**
   * Active users in one scope holding `permissionSlug`.
   *
   * The join mirrors `PermissionsAuditService`'s effective-user count
   * (`roles → role_permissions → user_roles`) rather than inventing a second
   * interpretation of what "holds a permission" means.
   *
   * `tenantId === null` selects platform operators (`u."tenantId" IS NULL`) —
   * expressed as an explicit IS NULL test, never as a parameter comparison,
   * because `= NULL` is never true in SQL and would silently return nobody.
   */
  private async byPermission(
    permissionSlug: string,
    tenantId: string | null,
  ): Promise<ResolvedRecipient[]> {
    const qb = this.users
      .createQueryBuilder('u')
      .innerJoin('user_roles', 'ur', 'ur."userId" = u.id')
      .innerJoin('roles', 'r', 'r.id = ur."roleId" AND r.deleted_at IS NULL')
      .innerJoin('role_permissions', 'rp', 'rp."roleId" = r.id')
      .innerJoin(
        'permissions',
        'p',
        'p.id = rp."permissionId" AND p.slug = :permissionSlug',
        { permissionSlug },
      )
      .where('u.is_active = true')
      .andWhere('u.deleted_at IS NULL');

    if (tenantId === null) {
      qb.andWhere('u."tenantId" IS NULL');
    } else {
      qb.andWhere('u."tenantId" = :tenantId', { tenantId });
    }

    // `.distinct(true)`, not `.select('DISTINCT u.id', …)`: the string form
    // puts the keyword inside the first selected EXPRESSION, so TypeORM emits
    // it after the alias list rather than after SELECT and Postgres rejects the
    // statement. A user can match the permission join more than once (two roles
    // both granting it), so the de-duplication is required, not cosmetic.
    const rows = await qb
      .distinct(true)
      .select('u.id', 'id')
      .addSelect('u.preferred_locale', 'preferredLocale')
      .getRawMany<{ id: string; preferredLocale: string | null }>();

    return rows.map((r) => ({
      id: r.id,
      preferredLocale: r.preferredLocale ?? null,
    }));
  }

  /**
   * Loads named users, keeping only those that genuinely belong to the
   * notification's scope.
   *
   * The scope predicate is applied IN THE QUERY, not checked afterwards, so
   * there is no window in which a foreign user is held in memory as a
   * candidate. An id that does not survive is dropped and logged — never
   * thrown on, because one bad id must not suppress the notification for the
   * legitimate recipients alongside it.
   */
  private async verifiedUsers(
    ids: string[],
    scope: NotificationScope,
    tenantId: string | null,
  ): Promise<ResolvedRecipient[]> {
    const qb = this.users
      .createQueryBuilder('u')
      .where({ id: In(ids) })
      .andWhere('u.is_active = true')
      .andWhere('u.deleted_at IS NULL');

    if (scope === NOTIFICATION_SCOPE.PLATFORM) {
      qb.andWhere('u."tenantId" IS NULL');
    } else {
      qb.andWhere('u."tenantId" = :tenantId', { tenantId });
    }

    const rows = await qb
      .select('u.id', 'id')
      .addSelect('u.preferred_locale', 'preferredLocale')
      .getRawMany<{ id: string; preferredLocale: string | null }>();

    if (rows.length !== ids.length) {
      const kept = new Set(rows.map((r) => r.id));
      const dropped = ids.filter((id) => !kept.has(id));
      this.logger.warn(
        `Dropped ${dropped.length} recipient id(s) that are not eligible for this ` +
          `${scope} notification (inactive, deleted, or belonging to another tenant)`,
      );
    }

    return rows.map((r) => ({
      id: r.id,
      preferredLocale: r.preferredLocale ?? null,
    }));
  }
}
