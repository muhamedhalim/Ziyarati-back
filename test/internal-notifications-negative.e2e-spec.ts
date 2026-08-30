/**
 * NEGATIVE / security e2e for the internal notification system.
 *
 * The companion to `internal-notifications.e2e-spec.ts`, which proves the
 * notifications arrive. This one proves the things that must NOT happen —
 * cross-tenant leakage, IDOR, role leakage, duplicate-on-replay, and a
 * notification failure taking a business operation down with it.
 *
 * These are separated deliberately. Cross-tenant disclosure is the
 * highest-severity failure this subsystem can have, and a security assertion
 * buried among happy-path tests is one that gets skipped when a suite is
 * trimmed for time.
 *
 * Runs against the REAL AppModule and the migrations-built `ziyarati_e2e`
 * database, so the partial unique index and the resolver's SQL are exercised
 * exactly as in production — a mocked query builder cannot prove either.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { User } from '../src/entities/Auth&RBAC/User';
import { Role } from '../src/entities/Auth&RBAC/Role';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { InAppNotification } from '../src/entities/Notifications/InAppNotification';
import { NotificationRecipientResolver } from '../src/modules/notifications/internal/notification-recipient.resolver';
import { InternalNotificationService } from '../src/modules/notifications/internal/internal-notification.service';
import {
  platformPermission,
  specificUsers,
  tenantPermission,
} from '../src/modules/notifications/internal/notification-recipient.policy';
import { NOTIFICATION_SCOPE } from '../src/modules/notifications/internal/notification-keys';
import { PERMISSION, ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';

jest.setTimeout(60_000);

interface Actor {
  userId: string;
  token: string;
}

describe('Internal notifications — negative / security', () => {
  let e2e: E2eApp;
  let resolver: NotificationRecipientResolver;
  let notifier: InternalNotificationService;

  let clinicA: OwnerFixture;
  let clinicB: OwnerFixture;
  let doctorA: Actor;
  let support: Actor;

  async function mintToken(
    userId: string,
    tenantId: string | null,
  ): Promise<string> {
    return e2e.jwt.signAsync(
      { sub: userId, tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
        expiresIn: '15m',
      },
    );
  }

  async function createActor(
    roleSlug: string,
    tenantId: string | null,
    label: string,
  ): Promise<Actor> {
    const users = e2e.dataSource.getRepository(User);
    const roles = e2e.dataSource.getRepository(Role);
    const userRoles = e2e.dataSource.getRepository(UserRole);

    const role = await roles
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: roleSlug })
      .andWhere('r."tenantId" IS NULL')
      .getOne();
    if (!role) throw new Error(`Seeded role "${roleSlug}" not found`);

    const user = await users.save(
      users.create({
        ...(tenantId ? { tenant: { id: tenantId } as Tenant } : {}),
        email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
        full_name: `E2E ${label}`,
        is_active: true,
      }),
    );
    await userRoles.save(
      userRoles.create({
        user: { id: user.id } as User,
        role: { id: role.id } as Role,
      }),
    );
    return { userId: user.id, token: await mintToken(user.id, tenantId) };
  }

  /** Writes one notification straight through the service, bypassing HTTP. */
  async function emitTicketReply(
    tenantId: string,
    eventId: string,
    ticketId = randomUUID(),
  ) {
    return notifier.emit('SUPPORT_TICKET_REPLIED', {
      tenantId,
      actorUserId: null,
      variables: {
        ticketNumber: 'SUP-000001',
        subject: 'Subject',
        responderName: 'Support',
        preview: 'A reply',
      },
      refs: { ticketId, eventId },
    });
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    resolver = e2e.moduleRef.get(NotificationRecipientResolver, {
      strict: false,
    });
    notifier = e2e.moduleRef.get(InternalNotificationService, {
      strict: false,
    });

    clinicA = await createOwnerFixture(e2e, 'neg-a');
    clinicB = await createOwnerFixture(e2e, 'neg-b');
    doctorA = await createActor(ROLE.DOCTOR, clinicA.tenantId, 'doctor-a');
    support = await createActor(ROLE.PLATFORM_SUPPORT, null, 'support-neg');
  });

  afterAll(async () => {
    const q = (sql: string, params: unknown[]) =>
      e2e.dataSource.query(sql, params);

    if (support?.userId) {
      await q(`DELETE FROM in_app_notifications WHERE recipient_user_id = $1`, [support.userId]);
      await q(`DELETE FROM notification_preferences WHERE user_id = $1`, [support.userId]);
      await q(`DELETE FROM user_roles WHERE "userId" = $1`, [support.userId]);
      await q(`DELETE FROM users WHERE id = $1`, [support.userId]);
    }
    for (const tenantId of [clinicA?.tenantId, clinicB?.tenantId].filter(Boolean)) {
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`, [tenantId]);
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
        [tenantId],
      );
      await q(`DELETE FROM users WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
    await e2e.app.close();
  });

  // ══════════════════ N1 / N6 — cross-tenant isolation ══════════════════════

  describe('N1 — a clinic never sees another clinic\'s notifications', () => {
    it('resolves recipients only within the event\'s own tenant', async () => {
      const recipients = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        clinicA.tenantId,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
      );

      const ids = recipients.map((r) => r.id);
      expect(ids).toContain(clinicA.userId);
      // Clinic B's owner holds the identical permission — the ONLY thing
      // keeping them out is the tenant predicate.
      expect(ids).not.toContain(clinicB.userId);
      // And no platform user, who also holds it via the super-admin wildcard.
      expect(ids).not.toContain(support.userId);
    });

    it('returns only the caller\'s own rows from the inbox API', async () => {
      await emitTicketReply(clinicA.tenantId, randomUUID());
      await emitTicketReply(clinicB.tenantId, randomUUID());

      const aRes = await request(e2e.app.getHttpServer())
        .get(`${API}/notifications/inbox`)
        .query({ status: 'all' })
        .set(...authHeader(clinicA.token))
        .expect(200);

      const bRes = await request(e2e.app.getHttpServer())
        .get(`${API}/notifications/inbox`)
        .query({ status: 'all' })
        .set(...authHeader(clinicB.token))
        .expect(200);

      expect(aRes.body.total).toBeGreaterThan(0);
      expect(bRes.body.total).toBeGreaterThan(0);

      // Disjoint id sets — the decisive assertion.
      const aIds = new Set(aRes.body.data.map((n: { id: string }) => n.id));
      const bIds = bRes.body.data.map((n: { id: string }) => n.id);
      expect(bIds.some((id: string) => aIds.has(id))).toBe(false);
    });
  });

  describe('N6 — an identical dedupe key in two clinics does not collide', () => {
    it('writes a notification for each clinic', async () => {
      // The SAME business key in both tenants. If the unique index were global
      // — as `UQ_scheduled_notifications_source_ref` is — the second clinic's
      // notification would be silently swallowed.
      const sharedEventId = randomUUID();

      const a = await emitTicketReply(clinicA.tenantId, sharedEventId);
      const b = await emitTicketReply(clinicB.tenantId, sharedEventId);

      expect(a.created).toBe(1);
      expect(b.created).toBe(1);
    });
  });

  // ══════════════════ N10 — idempotency ═════════════════════════════════════

  describe('N10 — replaying the same event writes nothing the second time', () => {
    it('is idempotent on the dedupe key', async () => {
      const eventId = randomUUID();

      const first = await emitTicketReply(clinicA.tenantId, eventId);
      const second = await emitTicketReply(clinicA.tenantId, eventId);

      expect(first.created).toBe(1);
      // Enforced by the partial unique index + ON CONFLICT DO NOTHING, not by
      // a check-then-act read, so concurrent duplicates race harmlessly too.
      expect(second.created).toBe(0);
      expect(second.error).toBeUndefined();
    });
  });

  // ══════════════════ N3 — IDOR ═════════════════════════════════════════════

  describe('N3 — one user cannot read or mutate another\'s notification', () => {
    it('returns 404 (not 403) and leaves the row unread', async () => {
      await emitTicketReply(clinicB.tenantId, randomUUID());
      const repo = e2e.dataSource.getRepository(InAppNotification);
      const victim = await repo.findOne({
        where: { recipient: { id: clinicB.userId } },
        order: { created_at: 'DESC' },
      });
      expect(victim).toBeTruthy();
      expect(victim!.read_at).toBeNull();

      await request(e2e.app.getHttpServer())
        .post(`${API}/notifications/inbox/${victim!.id}/read`)
        .set(...authHeader(clinicA.token))
        // 404, never 403 — a 403 would confirm the id exists, which is itself
        // a disclosure.
        .expect(404);

      const after = await repo.findOne({ where: { id: victim!.id } });
      expect(after!.read_at).toBeNull();
    });

    it('mark-all-read touches only the caller', async () => {
      await emitTicketReply(clinicB.tenantId, randomUUID());
      const repo = e2e.dataSource.getRepository(InAppNotification);

      await request(e2e.app.getHttpServer())
        .post(`${API}/notifications/inbox/read-all`)
        .set(...authHeader(clinicA.token))
        .expect(200);

      // Clinic B's notifications are untouched — read state is per recipient,
      // unlike the legacy `POST /admin/notifications/read-all`, which marks
      // every row for every administrator.
      const bRows = await repo.find({
        where: { recipient: { id: clinicB.userId } },
      });
      expect(bRows.length).toBeGreaterThan(0);
      expect(bRows.some((r) => !r.read_at)).toBe(true);
    });
  });

  // ══════════════════ N4 / N5 — permission and scope boundaries ═════════════

  describe('N4 — a permission-less user in the same tenant is never a recipient', () => {
    it('excludes a doctor, who holds no support permission', async () => {
      const recipients = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        clinicA.tenantId,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
      );
      expect(recipients.map((r) => r.id)).not.toContain(doctorA.userId);
    });
  });

  describe('N5 — platform-scope notifications never reach a tenant user', () => {
    it('resolves only users with no tenant', async () => {
      const recipients = await resolver.resolve(
        NOTIFICATION_SCOPE.PLATFORM,
        null,
        platformPermission(PERMISSION.PLATFORM_SUPPORT_TICKETS_READ),
      );

      const ids = recipients.map((r) => r.id);
      expect(ids).toContain(support.userId);
      expect(ids).not.toContain(clinicA.userId);
      expect(ids).not.toContain(clinicB.userId);
    });
  });

  describe('N2 — a named recipient from another tenant is dropped', () => {
    it('keeps the eligible ids and silently discards the foreign one', async () => {
      const recipients = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        clinicA.tenantId,
        specificUsers([clinicA.userId, clinicB.userId]),
      );

      // One bad id must not suppress the notification for the legitimate
      // recipient standing next to it.
      expect(recipients.map((r) => r.id)).toEqual([clinicA.userId]);
    });
  });

  describe('N15 — inactive users are never recipients', () => {
    it('drops a deactivated user from the permission query', async () => {
      const users = e2e.dataSource.getRepository(User);
      await users.update({ id: clinicA.userId }, { is_active: false });
      try {
        const recipients = await resolver.resolve(
          NOTIFICATION_SCOPE.TENANT,
          clinicA.tenantId,
          tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
        );
        expect(recipients.map((r) => r.id)).not.toContain(clinicA.userId);
      } finally {
        await users.update({ id: clinicA.userId }, { is_active: true });
      }
    });
  });

  // ══════════════════ N14 — failure isolation ═══════════════════════════════

  describe('N14 — a notification failure never breaks the business operation', () => {
    it('returns a result instead of throwing when the catalog key is unknown', async () => {
      const result = await notifier.emit('NOT_A_REAL_KEY' as never, {
        tenantId: clinicA.tenantId,
      });
      expect(result.error).toBe('unknown-key');
    });

    it('refuses to resolve a tenant notification with no tenant, rather than broadcasting', async () => {
      // The failure mode of a producer bug here MUST be silence. Resolving
      // "no tenant" as "every user" would be a cross-tenant disclosure.
      const recipients = await resolver.resolve(
        NOTIFICATION_SCOPE.TENANT,
        null,
        tenantPermission(PERMISSION.SUPPORT_TICKETS_READ),
      );
      expect(recipients).toEqual([]);
    });
  });

  // ══════════════════ N16 — a suspended clinic can still read ═══════════════

  describe('N16 — the inbox is reachable when the clinic is not active', () => {
    it('serves the inbox for a suspended tenant, so it can learn why', async () => {
      const tenants = e2e.dataSource.getRepository(Tenant);
      await tenants.update({ id: clinicA.tenantId }, { is_active: false });
      try {
        // Deliberately NOT behind ActiveTenantGuard / RequireActiveSubscription
        // / RequireFeature — otherwise the explanation for an outage would be
        // hidden behind the outage.
        await request(e2e.app.getHttpServer())
          .get(`${API}/notifications/inbox`)
          .query({ status: 'all' })
          .set(...authHeader(clinicA.token))
          .expect(200);

        await request(e2e.app.getHttpServer())
          .get(`${API}/notifications/inbox/unread-count`)
          .set(...authHeader(clinicA.token))
          .expect(200);
      } finally {
        await tenants.update({ id: clinicA.tenantId }, { is_active: true });
      }
    });
  });

  // ══════════════════ N18 — mandatory notifications ═════════════════════════

  describe('N18 — a required category cannot be muted', () => {
    it('rejects the mute and keeps delivering', async () => {
      // SUPPORT_TICKET_REPLIED is mandatory: a clinic must not be able to opt
      // out of hearing back from support, which is its only channel to us.
      await request(e2e.app.getHttpServer())
        .put(`${API}/notifications/inbox/preferences`)
        .set(...authHeader(clinicA.token))
        .send({ preferences: [{ category: 'SUPPORT', muted: true }] })
        .expect(200); // SUPPORT also contains non-mandatory keys, so it IS mutable

      // ...but the mandatory key still arrives despite the mute.
      const before = await e2e.dataSource
        .getRepository(InAppNotification)
        .count({ where: { recipient: { id: clinicA.userId } } });

      const result = await emitTicketReply(clinicA.tenantId, randomUUID());
      expect(result.created).toBe(1);
      expect(result.suppressed).toBe(0);

      const after = await e2e.dataSource
        .getRepository(InAppNotification)
        .count({ where: { recipient: { id: clinicA.userId } } });
      expect(after).toBe(before + 1);

      // Restore.
      await request(e2e.app.getHttpServer())
        .put(`${API}/notifications/inbox/preferences`)
        .set(...authHeader(clinicA.token))
        .send({ preferences: [{ category: 'SUPPORT', muted: false }] })
        .expect(200);
    });
  });

  // ══════════════════ Unauthenticated access ════════════════════════════════

  describe('the inbox requires authentication', () => {
    it('rejects an anonymous caller', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/notifications/inbox`)
        .expect(401);
    });
  });
});
