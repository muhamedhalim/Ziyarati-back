import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User } from '../../../entities/Auth&RBAC/User';
import { PERMISSION } from '../../../rbac/rbac.constants';
import {
  createMockQueryBuilder,
  createMockRepository,
  type MockQueryBuilder,
  type MockRepository,
} from '../../../../test/utils/mock-factories';

import { NotificationRecipientResolver } from './notification-recipient.resolver';
import { NOTIFICATION_SCOPE } from './notification-keys';
import {
  platformPermission,
  specificUsers,
  tenantPermission,
  union,
} from './notification-recipient.policy';

const TENANT = 'aaaaaaaa-0000-4000-8000-00000000000a';

/**
 * The resolver's DECISIONS, unit-tested without a database.
 *
 * The SQL itself — the `roles → role_permissions → user_roles` join, the
 * `tenantId IS NULL` predicate, the soft-delete filters — is verified against
 * real Postgres in `test/internal-notifications-negative.e2e-spec.ts`, because
 * asserting join strings against a mock would prove only that the code says
 * what it says. What IS worth unit-testing is everything the resolver decides
 * BEFORE it reaches SQL: the fail-closed guards, actor exclusion, and
 * de-duplication. Those are pure logic, and each one is a security property.
 */
describe('NotificationRecipientResolver', () => {
  let resolver: NotificationRecipientResolver;
  let users: MockRepository;
  let qb: MockQueryBuilder;

  const rows = (...ids: string[]) =>
    ids.map((id) => ({ id, preferredLocale: null }));

  beforeEach(async () => {
    users = createMockRepository();
    qb = createMockQueryBuilder();
    users.createQueryBuilder.mockReturnValue(qb);
    qb.getRawMany.mockResolvedValue([]);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationRecipientResolver,
        { provide: getRepositoryToken(User), useValue: users },
      ],
    }).compile();

    resolver = moduleRef.get(NotificationRecipientResolver);
  });

  afterEach(() => jest.clearAllMocks());

  describe('fail-closed guards', () => {
    it('resolves NOBODY for a TENANT notification with no tenant, and never queries', async () => {
      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        null,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
      );

      expect(result).toEqual([]);
      // The important half: it must not fall through to a query with no tenant
      // predicate, which would resolve to EVERY user of EVERY clinic.
      expect(users.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a TENANT_PERMISSION policy on a PLATFORM notification', async () => {
      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.PLATFORM,
        null,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
      );

      expect(result).toEqual([]);
      expect(users.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a PLATFORM_PERMISSION policy on a TENANT notification', async () => {
      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        platformPermission(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ),
      );

      expect(result).toEqual([]);
      expect(users.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('actor exclusion', () => {
    it('never notifies the person who caused the event', async () => {
      qb.getRawMany.mockResolvedValue(rows('user-actor', 'user-other'));

      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
        { actorUserId: 'user-actor' },
      );

      expect(result.map((r) => r.id)).toEqual(['user-other']);
    });

    it('includes the actor when a caller explicitly opts in', async () => {
      qb.getRawMany.mockResolvedValue(rows('user-actor', 'user-other'));

      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
        { actorUserId: 'user-actor', includeActor: true },
      );

      expect(result.map((r) => r.id).sort()).toEqual([
        'user-actor',
        'user-other',
      ]);
    });

    it('is a no-op when the event had no human actor', async () => {
      qb.getRawMany.mockResolvedValue(rows('user-1'));

      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
        { actorUserId: null },
      );

      expect(result.map((r) => r.id)).toEqual(['user-1']);
    });
  });

  describe('de-duplication', () => {
    it('returns one entry per user when a union overlaps', async () => {
      // Both branches of the union resolve the same person — a realistic case
      // (the ticket's author is also a manager). Without de-duplication they
      // would get two identical notifications for one event.
      qb.getRawMany.mockResolvedValue(rows('user-1', 'user-2'));

      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        union(
          tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
          tenantPermission(PERMISSION.SUPPORT_TICKETS_REPLY),
        ),
      );

      expect(result.map((r) => r.id).sort()).toEqual(['user-1', 'user-2']);
    });
  });

  describe('specific users', () => {
    it('drops null and undefined ids instead of querying for them', async () => {
      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        specificUsers([null, undefined]),
      );

      expect(result).toEqual([]);
      expect(users.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('merges ids supplied by the event context with the policy\'s own', async () => {
      qb.getRawMany.mockResolvedValue(rows('user-ctx'));

      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        specificUsers([]),
        { targetUserIds: ['user-ctx'] },
      );

      expect(result.map((r) => r.id)).toEqual(['user-ctx']);
    });

    it('keeps only the users the scoped query returned', async () => {
      // The query applies the tenant predicate, so an id belonging to another
      // clinic simply does not come back. The resolver must return what the
      // database allowed, not what the caller asked for.
      qb.getRawMany.mockResolvedValue(rows('user-same-tenant'));

      const result = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        TENANT,
        specificUsers(['user-same-tenant', 'user-other-tenant']),
      );

      expect(result.map((r) => r.id)).toEqual(['user-same-tenant']);
    });
  });

  it('carries each recipient\'s locale through for rendering', async () => {
    qb.getRawMany.mockResolvedValue([
      { id: 'user-ar', preferredLocale: 'ar' },
      { id: 'user-none', preferredLocale: null },
    ]);

    const result = await resolver.resolve(
      NOTIFICATION_SCOPE.TENANT,
      TENANT,
      tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
    );

    expect(result).toEqual([
      { id: 'user-ar', preferredLocale: 'ar' },
      { id: 'user-none', preferredLocale: null },
    ]);
  });
});
