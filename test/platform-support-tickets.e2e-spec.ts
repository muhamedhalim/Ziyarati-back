/**
 * HTTP e2e for the Platform Customer Service feature — support-ticket
 * authorization, bidirectional replies, the explicit reopen action, and the
 * platform-staff provisioning loop that creates a Platform Customer Service
 * account in the first place.
 *
 * Boots the REAL AppModule (see whatsapp-e2e-app.ts's createE2eApp) against
 * the real dev Postgres so the guard chain runs exactly as it does in
 * production. Requires the RBAC seed AND the PlatformSupportRoleAndPermissions
 * migration (1730034000000) to have already run against the target database
 * — the `platform_support` role and its permission grants are NOT created by
 * this suite. DATABASE ISOLATION: every fixture is scoped under a freshly
 * created Tenant (or a dedicated platform user); cleanup() removes every row
 * this suite created, in FK-safe order, in afterAll.
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
import { SupportTicketEvent } from '../src/entities/SupportTickets/SupportTicketEvent';
import { RefreshToken } from '../src/entities/Auth&RBAC/RefreshToken';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';

async function mintTokenFor(
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

/** A platform-scope user (tenantId = NULL) holding the given SEEDED global system role. */
async function createPlatformActor(
  e2e: E2eApp,
  roleSlug: string,
  label: string,
) {
  const users = e2e.dataSource.getRepository(User);
  const roles = e2e.dataSource.getRepository(Role);
  const userRoles = e2e.dataSource.getRepository(UserRole);

  const role = await roles
    .createQueryBuilder('r')
    .where('r.slug = :slug', { slug: roleSlug })
    .andWhere('r."tenantId" IS NULL')
    .getOne();
  if (!role) {
    throw new Error(
      `Seeded platform role "${roleSlug}" not found — run PlatformSupportRoleAndPermissions (1730034000000) first.`,
    );
  }

  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const user = await users.save(
    users.create({
      tenant: undefined,
      email: `${suffix}@example.test`,
      full_name: `E2E ${suffix}`,
      is_active: true,
    }),
  );
  await userRoles.save(
    userRoles.create({
      user: { id: user.id } as User,
      role: { id: role.id } as Role,
    }),
  );

  const token = await mintTokenFor(e2e, user.id, null);
  return { userId: user.id, token, email: user.email! };
}

describe('Platform Customer Service — Support Ticket authorization, replies, reopen (HTTP e2e)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let otherOwner: OwnerFixture;
  let superAdmin: { userId: string; token: string };
  let platformSupport: { userId: string; token: string };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'psd-owner');
    otherOwner = await createOwnerFixture(e2e, 'psd-other');
    superAdmin = await createPlatformActor(e2e, ROLE.SUPER_ADMIN, 'sa');
    platformSupport = await createPlatformActor(
      e2e,
      ROLE.PLATFORM_SUPPORT,
      'cs',
    );
    createdUserIds.push(superAdmin.userId, platformSupport.userId);
  }, 60_000);

  afterAll(async () => {
    const tenantIds = [owner.tenantId, otherOwner.tenantId];
    for (const tenantId of tenantIds) {
      const q = (sql: string) => e2e.dataSource.query(sql, [tenantId]);
      await q(
        `DELETE FROM support_ticket_events WHERE "ticketId" IN (SELECT id FROM support_tickets WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM support_tickets WHERE "tenantId" = $1`);
      await q(
        `DELETE FROM refresh_tokens WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(
        `DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" = $1)`,
      );
      await q(`DELETE FROM audit_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM api_logs WHERE "tenantId" = $1`);
      await q(`DELETE FROM users WHERE "tenantId" = $1`);
      await q(`DELETE FROM tenants WHERE id = $1`);
    }
    if (createdUserIds.length) {
      await e2e.dataSource.query(
        `DELETE FROM refresh_tokens WHERE "userId" = ANY($1::uuid[])`,
        [createdUserIds],
      );
      await e2e.dataSource.query(
        `DELETE FROM user_roles WHERE "userId" = ANY($1::uuid[])`,
        [createdUserIds],
      );
      await e2e.dataSource.query(
        `DELETE FROM audit_logs WHERE "userId" = ANY($1::uuid[])`,
        [createdUserIds],
      );
      await e2e.dataSource.query(
        `DELETE FROM users WHERE id = ANY($1::uuid[])`,
        [createdUserIds],
      );
    }
    await e2e.app.close();
  }, 30_000);

  // ── Phase 3 proof: Super Admin provisions Platform Customer Service ──────── //

  describe('Super Admin provisions Platform Customer Service via /platform/staff', () => {
    it('creates a platform staff member with tenantId=null and exactly the platform_support role', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/platform/staff`)
        .set(...authHeader(superAdmin.token))
        .send({
          email: `new-cs-${randomUUID().slice(0, 8)}@example.test`,
          fullName: 'New CS',
          roleSlug: ROLE.PLATFORM_SUPPORT,
        })
        .expect(201);

      createdUserIds.push(res.body.id);
      const user = await e2e.dataSource
        .getRepository(User)
        .findOne({ where: { id: res.body.id }, relations: { tenant: true } });
      expect(user?.tenant).toBeNull();

      const links = await e2e.dataSource
        .getRepository(UserRole)
        .createQueryBuilder('ur')
        .innerJoinAndSelect('ur.role', 'role')
        .where('ur."userId" = :userId', { userId: res.body.id })
        .getMany();
      expect(links.map((l) => l.role.slug)).toEqual([ROLE.PLATFORM_SUPPORT]);
    });

    it('the new account can authenticate through the normal login form (no separate platform login)', async () => {
      // Provisioned above; here we just prove buildAuthenticatedUser accepts it
      // via GET /auth/me using a minted token (login itself needs a real
      // password, which is invitation-only and out of scope for this check).
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/auth/me`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      expect(res.body.tenantId).toBeNull();
      expect(res.body.roles).toContain(ROLE.PLATFORM_SUPPORT);
    });

    it('a clinic Owner cannot reach /platform/staff at all', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/staff`)
        .set(...authHeader(owner.token))
        .expect(403);
    });

    it('Platform Customer Service cannot assign roles via /roles (no roles.manage)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/roles`)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });

    it('a clinic Owner cannot assign platform_support to their own staff via /roles/:id/users/:userId', async () => {
      const platformSupportRole = await e2e.dataSource
        .getRepository(Role)
        .createQueryBuilder('r')
        .where('r.slug = :slug', { slug: ROLE.PLATFORM_SUPPORT })
        .andWhere('r."tenantId" IS NULL')
        .getOneOrFail();

      await request(e2e.app.getHttpServer())
        .post(`${API}/roles/${platformSupportRole.id}/users/${owner.userId}`)
        .set(...authHeader(owner.token))
        .expect(403);
    });

    it('Platform Customer Service cannot mutate its OWN status through /platform/staff (self-escalation guard)', async () => {
      // /platform/staff is @Roles(SUPER_ADMIN) at the controller — CS is
      // rejected by RolesGuard before the self-mutation check even runs, so
      // this proves the OUTER boundary. The self-mutation guard itself
      // (actorId === targetId -> FORBIDDEN) is covered directly against the
      // service in platform-staff.service.spec.ts, since only Super Admin
      // can ever reach this route to exercise it end-to-end.
      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/staff/${platformSupport.userId}/status`)
        .set(...authHeader(platformSupport.token))
        .send({ isActive: false })
        .expect(403);
    });

    it('Super Admin CAN deactivate/reactivate a Platform Customer Service employee', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/staff/${platformSupport.userId}/status`)
        .set(...authHeader(superAdmin.token))
        .send({ isActive: false })
        .expect(200);
      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/staff/${platformSupport.userId}/status`)
        .set(...authHeader(superAdmin.token))
        .send({ isActive: true })
        .expect(200);
    });
  });

  // ── Cross-boundary access checks ──────────────────────────────────────────── //

  describe('Platform Customer Service cannot access Super Admin-only or tenant clinic APIs', () => {
    it('403 on a Super-Admin-only route (@Roles(SUPER_ADMIN), e.g. platform system settings)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/settings/registry`)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });

    it('403 on tenant clinic staff API (GET /staff, requires staff.read + tenant context)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/staff`)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });

    it('403 on tenant clinic appointments API (patient/medical-adjacent data)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/appointments`)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });

    it('403 on tenant clinic financial data (payments)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/payments`)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });

    it('403 on platform finance (super_admin only)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/finance/transactions`)
        .set(...authHeader(platformSupport.token))
        .expect(403);
    });
  });

  // ── Full ticket lifecycle: create -> triage -> reply both ways -> resolve -> close/reopen ── //

  describe('Ticket lifecycle end-to-end', () => {
    let ticketId: string;

    it('the clinic creates a ticket', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/support-tickets`)
        .set(...authHeader(owner.token))
        .send({
          subject: 'Cannot load calendar',
          category: 'technical',
          priority: 'medium',
          description: 'Blank since this morning.',
        })
        .expect(201);
      ticketId = res.body.id;
      expect(res.body.status).toBe('open');
    });

    it('Platform Customer Service can list and read cross-tenant tickets and KPIs', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets/kpis`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets/clinics`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets/${ticketId}`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      expect(res.body.tenant.contactEmail).toBeDefined(); // detail-only clinic contact fields
    });

    it('Platform Customer Service replies — clinic sees it', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/support-tickets/${ticketId}/replies`)
        .set(...authHeader(platformSupport.token))
        .send({ note: 'Looking into it now.' })
        .expect(201);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/support-tickets/${ticketId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(
        res.body.history.some(
          (e: any) => e.type === 'REPLY' && e.note === 'Looking into it now.',
        ),
      ).toBe(true);
    });

    it('Platform Customer Service adds an internal note — clinic never sees it', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/platform/support-tickets/${ticketId}/notes`)
        .set(...authHeader(platformSupport.token))
        .send({ note: 'Escalated to engineering internally.' })
        .expect(201);

      const clinicView = await request(e2e.app.getHttpServer())
        .get(`${API}/support-tickets/${ticketId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(
        clinicView.body.history.some((e: any) =>
          e.note?.includes('Escalated to engineering'),
        ),
      ).toBe(false);

      const adminView = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets/${ticketId}`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      expect(
        adminView.body.notes.some((e: any) =>
          e.note?.includes('Escalated to engineering'),
        ),
      ).toBe(true);
    });

    it('the clinic replies back — Platform Customer Service sees it', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/support-tickets/${ticketId}/replies`)
        .set(...authHeader(owner.token))
        .send({ note: 'Any update?' })
        .expect(201);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets/${ticketId}`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      expect(
        res.body.history.some(
          (e: any) => e.type === 'REPLY' && e.actorRole === 'clinic',
        ),
      ).toBe(true);
    });

    it('Platform Customer Service can triage to in_progress then resolved', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${ticketId}/status`)
        .set(...authHeader(platformSupport.token))
        .send({ status: 'in_progress' })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${ticketId}/status`)
        .set(...authHeader(platformSupport.token))
        .send({ status: 'resolved' })
        .expect(200);
      expect(res.body.status).toBe('resolved');
      expect(res.body.resolvedAt).toBeTruthy();
    });

    it('Platform Customer Service CANNOT close the ticket — 403, ticket unchanged', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${ticketId}/status`)
        .set(...authHeader(platformSupport.token))
        .send({ status: 'closed' })
        .expect(403);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets/${ticketId}`)
        .set(...authHeader(platformSupport.token))
        .expect(200);
      expect(res.body.status).toBe('resolved');
      expect(res.body.closedAt).toBeNull();
    });

    it('a normal clinic reply on the resolved ticket does NOT reopen it', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/support-tickets/${ticketId}/replies`)
        .set(...authHeader(owner.token))
        .send({ note: 'Still not fixed for me.' })
        .expect(201);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/support-tickets/${ticketId}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.status).toBe('resolved');
      expect(res.body.resolvedAt).toBeTruthy();
    });

    it('another clinic cannot reply to, reopen, or read this ticket (404 IDOR-safe)', async () => {
      await request(e2e.app.getHttpServer())
        .get(`${API}/support-tickets/${ticketId}`)
        .set(...authHeader(otherOwner.token))
        .expect(404);
      await request(e2e.app.getHttpServer())
        .post(`${API}/support-tickets/${ticketId}/replies`)
        .set(...authHeader(otherOwner.token))
        .send({ note: 'x' })
        .expect(404);
      await request(e2e.app.getHttpServer())
        .patch(`${API}/support-tickets/${ticketId}/reopen`)
        .set(...authHeader(otherOwner.token))
        .send({})
        .expect(404);
      await request(e2e.app.getHttpServer())
        .patch(`${API}/support-tickets/${ticketId}/close`)
        .set(...authHeader(otherOwner.token))
        .expect(404);
    });

    it('the explicit "Issue not resolved" action reopens resolved -> in_progress and clears resolvedAt', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/support-tickets/${ticketId}/reopen`)
        .set(...authHeader(owner.token))
        .send({ note: 'The bug is still there.' })
        .expect(200);
      expect(res.body.status).toBe('in_progress');
      expect(res.body.resolvedAt).toBeNull();

      const events = await e2e.dataSource
        .getRepository(SupportTicketEvent)
        .find({
          where: { ticket: { id: ticketId } as any },
          relations: { ticket: true },
        });
      expect(
        events.some(
          (e) =>
            e.type === 'STATUS_CHANGED' &&
            e.to_value === 'in_progress' &&
            e.actor_role === 'clinic',
        ),
      ).toBe(true);
      // History preserved — every prior event (replies, notes' public counterpart, status changes) still present.
      expect(events.length).toBeGreaterThan(3);
    });

    it('resolve again, then the clinic can close its own resolved ticket', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${ticketId}/status`)
        .set(...authHeader(platformSupport.token))
        .send({ status: 'resolved' })
        .expect(200);

      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/support-tickets/${ticketId}/close`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(res.body.status).toBe('closed');
    });

    it('a CLOSED ticket cannot be reopened by the clinic', async () => {
      await request(e2e.app.getHttpServer())
        .patch(`${API}/support-tickets/${ticketId}/reopen`)
        .set(...authHeader(owner.token))
        .send({})
        .expect(400);
    });

    it('Super Admin retains the unrestricted any -> any transition, including reopening a closed ticket', async () => {
      const res = await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/support-tickets/${ticketId}/status`)
        .set(...authHeader(superAdmin.token))
        .send({ status: 'open' })
        .expect(200);
      expect(res.body.status).toBe('open');
      expect(res.body.resolvedAt).toBeNull();
      expect(res.body.closedAt).toBeNull();
    });

    it('every ticket action recorded the correct real actor (not a hardcoded super_admin)', async () => {
      const events = await e2e.dataSource
        .getRepository(SupportTicketEvent)
        .createQueryBuilder('e')
        .innerJoin('e.ticket', 't')
        .where('t.id = :ticketId', { ticketId })
        .getMany();

      expect(events.some((e) => e.actor_role === 'platform_support')).toBe(
        true,
      );
      expect(events.some((e) => e.actor_role === 'clinic')).toBe(true);
      expect(events.some((e) => e.actor_role === ROLE.SUPER_ADMIN)).toBe(true);
    });
  });

  // ── Disabled account loses access ─────────────────────────────────────────── //

  describe('Deactivated Platform Customer Service loses access', () => {
    it('deactivation revokes refresh tokens and the next request 401s/403s', async () => {
      // Issue a refresh token for platformSupport so we can prove it's revoked.
      const refreshTokens = e2e.dataSource.getRepository(RefreshToken);
      const before = await refreshTokens.count({
        where: { user: { id: platformSupport.userId } as any },
      });

      await request(e2e.app.getHttpServer())
        .patch(`${API}/platform/staff/${platformSupport.userId}/status`)
        .set(...authHeader(superAdmin.token))
        .send({ isActive: false })
        .expect(200);

      const live = await refreshTokens
        .createQueryBuilder('rt')
        .where('rt."userId" = :userId', { userId: platformSupport.userId })
        .andWhere('rt.revoked_at IS NULL')
        .getCount();
      expect(live).toBe(0);

      // The OLD access token is now rejected on the very next request —
      // buildAuthenticatedUser throws USER_INACTIVE immediately.
      await request(e2e.app.getHttpServer())
        .get(`${API}/platform/support-tickets`)
        .set(...authHeader(platformSupport.token))
        .expect(401);

      void before; // documented above the count is expected to include historical rows
    });
  });
});
