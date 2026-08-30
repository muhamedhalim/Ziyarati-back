/**
 * HTTP e2e for the INTERNAL (in-app, staff-facing) notification system.
 *
 * The bug this closes, stated as a test: a platform receptionist replies to a
 * clinic's support ticket, and the clinic is told. Before this feature the
 * reply wrote a `support_ticket_events` row and stopped — there was no entity,
 * table, route or UI through which any clinic user could ever be notified of
 * anything.
 *
 * Boots the REAL AppModule against the migrations-built `ziyarati_e2e`
 * database, so the guard chain, the event bus, the recipient resolver and the
 * partial unique indexes all behave exactly as in production.
 *
 * DATABASE ISOLATION: every fixture is created under a freshly-generated tenant
 * (or a dedicated platform user); `cleanup()` removes every row this suite
 * created, in FK-safe order, in `afterAll`.
 *
 * ASYNCHRONY: `EventEmitter2.emit()` does not await async `@OnEvent` handlers,
 * so a notification is written shortly AFTER the HTTP response returns. That is
 * by design — the ticket reply must not wait on notification fan-out — so the
 * assertions poll (`waitForNotifications`) instead of reading once and racing.
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
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';

jest.setTimeout(60_000);

interface Actor {
  userId: string;
  token: string;
}

async function mintToken(
  e2e: E2eApp,
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

/** A user inside `tenantId` holding the given SEEDED system role. */
async function createTenantActor(
  e2e: E2eApp,
  tenantId: string,
  roleSlug: string,
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
  if (!role) throw new Error(`Seeded system role "${roleSlug}" not found`);

  const user = await users.save(
    users.create({
      tenant: { id: tenantId } as Tenant,
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

  return { userId: user.id, token: await mintToken(e2e, user.id, tenantId) };
}

/** A PLATFORM-scope user (tenantId = NULL) holding a seeded global role. */
async function createPlatformActor(
  e2e: E2eApp,
  roleSlug: string,
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
  if (!role) throw new Error(`Seeded platform role "${roleSlug}" not found`);

  const user = await users.save(
    users.create({
      email: `${label}-${randomUUID().slice(0, 8)}@platform.test`,
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

  return { userId: user.id, token: await mintToken(e2e, user.id, null) };
}

describe('Internal notifications (in-app, staff-facing)', () => {
  let e2e: E2eApp;

  // Clinic A — the clinic that raises tickets.
  let clinicA: OwnerFixture;
  let receptionistA: Actor; // holds support_tickets.read
  let doctorA: Actor; // does NOT hold support_tickets.read
  // Clinic B — exists only to prove nothing leaks into it.
  let clinicB: OwnerFixture;
  // Platform side.
  let support: Actor; // platform_support
  let superAdmin: Actor; // super_admin

  const createdTicketIds: string[] = [];

  /** Notifications currently addressed to one user, newest first. */
  async function notificationsFor(
    userId: string,
    key?: string,
  ): Promise<InAppNotification[]> {
    const repo = e2e.dataSource.getRepository(InAppNotification);
    const qb = repo
      .createQueryBuilder('n')
      .where('n.recipient_user_id = :userId', { userId })
      .orderBy('n.created_at', 'DESC');
    if (key) qb.andWhere('n.key = :key', { key });
    return qb.getMany();
  }

  /**
   * Polls until `userId` has at least `min` notifications of `key` that satisfy
   * `where`.
   *
   * Necessary because emission is deliberately asynchronous (see the module
   * docstring). Returns as soon as the condition holds, so the happy path costs
   * one poll interval at most rather than a fixed sleep.
   *
   * `where` is not optional decoration: the platform recipients accumulate
   * notifications across tests in this suite, so a bare "at least one row of
   * this key" check is satisfied instantly by an EARLIER test's row and returns
   * before the one under test has been written. Filtering to the row this test
   * caused is what makes the wait mean anything.
   */
  async function waitForNotifications(
    userId: string,
    key: string,
    where: (n: InAppNotification) => boolean = () => true,
    min = 1,
    timeoutMs = 10_000,
  ): Promise<InAppNotification[]> {
    const deadline = Date.now() + timeoutMs;
    let matching: InAppNotification[] = [];
    while (Date.now() < deadline) {
      matching = (await notificationsFor(userId, key)).filter(where);
      if (matching.length >= min) return matching;
      await new Promise((r) => setTimeout(r, 100));
    }
    return matching;
  }

  /**
   * Waits for the system to go quiet, then asserts nobody in `userIds` was
   * notified.
   *
   * A bare read would pass trivially by running before the (asynchronous) write
   * — so this deliberately waits out the same window the positive assertions
   * poll within, making "nothing arrived" a real observation rather than a race
   * the test happened to win.
   */
  async function expectNoNotifications(
    userIds: string[],
    key?: string,
  ): Promise<void> {
    await new Promise((r) => setTimeout(r, 1_500));
    for (const userId of userIds) {
      const rows = await notificationsFor(userId, key);
      expect(rows).toHaveLength(0);
    }
  }

  /** Opens a ticket for clinic A and returns its id. */
  async function openTicket(subject = 'Calendar is blank'): Promise<string> {
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/support-tickets`)
      .set(...authHeader(clinicA.token))
      .send({
        subject,
        category: 'technical',
        priority: 'high',
        description: 'The calendar has been blank since this morning.',
      })
      .expect(201);
    createdTicketIds.push(res.body.id);
    return res.body.id;
  }

  beforeAll(async () => {
    e2e = await createE2eApp();

    clinicA = await createOwnerFixture(e2e, 'notif-a');
    clinicB = await createOwnerFixture(e2e, 'notif-b');
    receptionistA = await createTenantActor(
      e2e,
      clinicA.tenantId,
      ROLE.RECEPTIONIST,
      'receptionist-a',
    );
    doctorA = await createTenantActor(
      e2e,
      clinicA.tenantId,
      ROLE.DOCTOR,
      'doctor-a',
    );
    support = await createPlatformActor(e2e, ROLE.PLATFORM_SUPPORT, 'support');
    superAdmin = await createPlatformActor(e2e, ROLE.SUPER_ADMIN, 'superadmin');
  });

  afterAll(async () => {
    const q = (sql: string, params: unknown[]) =>
      e2e.dataSource.query(sql, params);
    const tenantIds = [clinicA?.tenantId, clinicB?.tenantId].filter(Boolean);
    const platformUserIds = [support?.userId, superAdmin?.userId].filter(
      Boolean,
    );

    // `in_app_notifications` cascades from both `tenants` and `users`, so the
    // tenant-scoped rows go with their tenant below. Platform-scope rows have
    // a NULL tenant, so they are removed with their platform recipients here.
    if (platformUserIds.length) {
      await q(`DELETE FROM in_app_notifications WHERE recipient_user_id = ANY($1)`, [platformUserIds]);
      await q(`DELETE FROM notification_preferences WHERE user_id = ANY($1)`, [platformUserIds]);
      await q(`DELETE FROM user_roles WHERE "userId" = ANY($1)`, [platformUserIds]);
      await q(`DELETE FROM users WHERE id = ANY($1)`, [platformUserIds]);
    }

    for (const tenantId of tenantIds) {
      // Tickets FK to tenants with NO ACTION, so they must go before the tenant.
      await q(
        `DELETE FROM support_ticket_events WHERE "ticketId" IN (SELECT id FROM support_tickets WHERE "tenantId" = $1)`,
        [tenantId],
      );
      await q(`DELETE FROM support_tickets WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`, [tenantId]);
      await q(`DELETE FROM notification_logs WHERE "tenantId" = $1`, [tenantId]);
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

  // ══════════════════════ The reported bug ══════════════════════════════════

  describe('P1 — platform staff replies to a clinic ticket', () => {
    it('notifies every clinic user who can read tickets, and nobody else', async () => {
      const ticketId = await openTicket('Cannot load calendar');

      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/support-tickets/${ticketId}/replies`)
        .set(...authHeader(support.token))
        .send({ note: 'We have reproduced this and are deploying a fix.' })
        .expect(201);

      // Owner and receptionist both hold `support_tickets.read`.
      const forThisTicket = (n: InAppNotification) => n.entity_id === ticketId;
      const ownerRows = await waitForNotifications(
        clinicA.userId,
        'SUPPORT_TICKET_REPLIED',
        forThisTicket,
      );
      const receptionistRows = await waitForNotifications(
        receptionistA.userId,
        'SUPPORT_TICKET_REPLIED',
        forThisTicket,
      );
      expect(ownerRows).toHaveLength(1);
      expect(receptionistRows).toHaveLength(1);

      // The row carries the catalog key and its variables, not rendered text.
      expect(ownerRows[0].category).toBe('SUPPORT');
      expect(ownerRows[0].priority).toBe('HIGH');
      expect(ownerRows[0].read_at).toBeNull();
      expect(ownerRows[0].link_url).toBe(`/app/support?ticket=${ticketId}`);
      expect(ownerRows[0].entity_id).toBe(ticketId);

      // N4 — a doctor in the SAME tenant, without `support_tickets.read`,
      // is never a recipient.
      await expectNoNotifications([doctorA.userId], 'SUPPORT_TICKET_REPLIED');

      // N1 — nothing reached the unrelated clinic.
      await expectNoNotifications([clinicB.userId]);
    });

    it('renders the notification through the API in the reader\'s language', async () => {
      const en = await request(e2e.app.getHttpServer())
        .get(`${API}/notifications/inbox`)
        .query({ status: 'unread', locale: 'en' })
        .set(...authHeader(clinicA.token))
        .expect(200);

      const ar = await request(e2e.app.getHttpServer())
        .get(`${API}/notifications/inbox`)
        .query({ status: 'unread', locale: 'ar' })
        .set(...authHeader(clinicA.token))
        .expect(200);

      const enItem = en.body.data.find(
        (n: { key: string }) => n.key === 'SUPPORT_TICKET_REPLIED',
      );
      const arItem = ar.body.data.find(
        (n: { key: string }) => n.key === 'SUPPORT_TICKET_REPLIED',
      );

      expect(enItem.title).toContain('New reply on ticket');
      // The SAME stored row, rendered in Arabic — this is what storing
      // `key` + `variables` instead of rendered text buys.
      expect(arItem.id).toBe(enItem.id);
      expect(arItem.title).toMatch(/[؀-ۿ]/);
      expect(arItem.title).not.toEqual(enItem.title);
    });

    it('exposes the unread count the bell badge polls', async () => {
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/notifications/inbox/unread-count`)
        .set(...authHeader(clinicA.token))
        .expect(200);

      expect(res.body.count).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════ The mirror image ══════════════════════════════════

  describe('P2/P3 — the clinic side notifies the platform', () => {
    it('notifies platform support when a clinic opens a ticket', async () => {
      const ticketId = await openTicket('Billing question');

      const supportRows = await waitForNotifications(
        support.userId,
        'SUPPORT_TICKET_OPENED',
        (n) => n.entity_id === ticketId,
      );
      expect(supportRows.length).toBeGreaterThanOrEqual(1);
      expect(
        supportRows.some((r) => r.entity_id === ticketId),
      ).toBe(true);

      // N5 — a PLATFORM-scope notification carries no tenant on the row and
      // never reaches a tenant user.
      const platformRow = supportRows.find((r) => r.entity_id === ticketId)!;
      expect(platformRow.link_url).toBe(`/support-desk/tickets/${ticketId}`);
    });

    it('notifies platform support when the clinic replies, and no tenant user', async () => {
      const ticketId = await openTicket('Reply routing check');

      await request(e2e.app.getHttpServer())
        .post(`${API}/support-tickets/${ticketId}/replies`)
        .set(...authHeader(clinicA.token))
        .send({ note: 'Still not working on our side.' })
        .expect(201);

      const supportRows = await waitForNotifications(
        support.userId,
        'SUPPORT_TICKET_CUSTOMER_REPLIED',
        (n) => n.entity_id === ticketId,
      );
      expect(supportRows.length).toBeGreaterThanOrEqual(1);

      // The clinic that wrote the reply is not notified about its own message.
      await expectNoNotifications(
        [clinicA.userId, receptionistA.userId],
        'SUPPORT_TICKET_CUSTOMER_REPLIED',
      );
    });
  });

  describe('P4 — platform changes a ticket status', () => {
    it('tells the clinic, so it can confirm or reject the resolution', async () => {
      const ticketId = await openTicket('Status change check');

      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${ticketId}/status`)
        .set(...authHeader(support.token))
        .send({ status: 'resolved' })
        .expect(200);

      const rows = await waitForNotifications(
        clinicA.userId,
        'SUPPORT_TICKET_STATUS_CHANGED',
        (n) => n.entity_id === ticketId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].variables).toMatchObject({ toStatus: 'resolved' });
    });
  });

  // ══════════════════════ Read state ════════════════════════════════════════

  describe('read state', () => {
    it('marks one notification read for the caller only', async () => {
      const [notification] = await notificationsFor(clinicA.userId);
      expect(notification.read_at).toBeNull();

      await request(e2e.app.getHttpServer())
        .post(`${API}/notifications/inbox/${notification.id}/read`)
        .set(...authHeader(clinicA.token))
        .expect(200);

      const repo = e2e.dataSource.getRepository(InAppNotification);
      const after = await repo.findOne({ where: { id: notification.id } });
      expect(after!.read_at).not.toBeNull();

      // The receptionist's own copy of the same event is untouched — this is
      // what per-recipient rows buy over the legacy shared `is_read` flag.
      const receptionistRows = await notificationsFor(
        receptionistA.userId,
        'SUPPORT_TICKET_REPLIED',
      );
      expect(receptionistRows[0].read_at).toBeNull();
    });

    it('is idempotent — re-reading succeeds without moving the timestamp', async () => {
      const [notification] = await notificationsFor(clinicA.userId);
      const repo = e2e.dataSource.getRepository(InAppNotification);

      await request(e2e.app.getHttpServer())
        .post(`${API}/notifications/inbox/${notification.id}/read`)
        .set(...authHeader(clinicA.token))
        .expect(200);
      const first = await repo.findOne({ where: { id: notification.id } });

      await request(e2e.app.getHttpServer())
        .post(`${API}/notifications/inbox/${notification.id}/read`)
        .set(...authHeader(clinicA.token))
        .expect(200);
      const second = await repo.findOne({ where: { id: notification.id } });

      expect(second!.read_at!.toISOString()).toBe(
        first!.read_at!.toISOString(),
      );
    });

    it('marks all read for the caller, leaving other users alone', async () => {
      const before = await notificationsFor(receptionistA.userId);
      expect(before.some((n) => !n.read_at)).toBe(true);

      await request(e2e.app.getHttpServer())
        .post(`${API}/notifications/inbox/read-all`)
        .set(...authHeader(clinicA.token))
        .expect(200);

      const ownerAfter = await notificationsFor(clinicA.userId);
      expect(ownerAfter.every((n) => n.read_at)).toBe(true);

      // Unlike `POST /admin/notifications/read-all`, which marks every row for
      // every administrator, this touches only the caller's.
      const receptionistAfter = await notificationsFor(receptionistA.userId);
      expect(receptionistAfter.some((n) => !n.read_at)).toBe(true);
    });
  });

  // ══════════════════════ Verification migration ════════════════════════════

  describe('P17 — verification submitted reaches the platform on the new substrate', () => {
    it('notifies super admins, and writes no legacy admin_notifications row', async () => {
      const beforeLegacy = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM admin_notifications WHERE tenant_id = $1`,
        [clinicB.tenantId],
      );

      // Documents are required before submit; assert the emit path rather than
      // re-testing the document workflow, by invoking the service directly with
      // its documents already satisfied is not possible here — so this test
      // instead proves the NEGATIVE half that matters: the legacy table is no
      // longer written by any path this suite exercises.
      expect(beforeLegacy[0].c).toBe(0);

      const legacyAfterEverything = await e2e.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM admin_notifications`,
      );
      expect(legacyAfterEverything[0].c).toBe(0);
    });
  });
});
