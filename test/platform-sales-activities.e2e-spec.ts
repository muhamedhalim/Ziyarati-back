/**
 * HTTP e2e — Sales Staff Management, Phase 6: the manual field-activity log.
 *
 * Real AppModule, real Postgres (`ziyarati_e2e`, built from the migrations).
 * Proves what the mocks cannot: the subject CHECK never surfaces as a 500,
 * every row is reached only through its own employee, deletes are soft and
 * audited, and the "last activity" figures Phase 2 built now carry real data
 * (employee list, per-clinic portfolio, the "not worked in N days" filter).
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';

import {
  authHeader,
  createE2eApp,
  type E2eApp,
} from './utils/whatsapp-e2e-app';

import { Role } from '../src/entities/Auth&RBAC/Role';
import { User } from '../src/entities/Auth&RBAC/User';
import { UserRole } from '../src/entities/Auth&RBAC/UserRole';
import { ROLE } from '../src/rbac/rbac.constants';

const API = '/api/v1';
const RUN = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const ago = (days: number, hoursOffset = 0) =>
  new Date(Date.now() - days * DAY + hoursOffset * 3_600_000).toISOString();

interface Actor {
  userId: string;
  token: string;
}

describe('Sales Staff Management — field activities (HTTP e2e)', () => {
  let e2e: E2eApp;
  let admin: Actor;
  let repA: string;
  let repB: string;
  let clinic1: string;
  let clinic2: string;
  let clinic3: string;
  let deletedClinic: string;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];

  const http = () => e2e.app.getHttpServer();
  const get = (path: string, token = admin.token) =>
    request(http()).get(`${API}${path}`).set(...authHeader(token));
  const post = (path: string, body: object = {}, token = admin.token) =>
    request(http()).post(`${API}${path}`).set(...authHeader(token)).send(body);
  const patch = (path: string, body: object = {}, token = admin.token) =>
    request(http()).patch(`${API}${path}`).set(...authHeader(token)).send(body);
  const del = (path: string, token = admin.token) =>
    request(http()).delete(`${API}${path}`).set(...authHeader(token));

  const mint = (userId: string) =>
    e2e.jwt.signAsync(
      { sub: userId, tenantId: null, type: 'access' },
      {
        secret: e2e.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret'),
        expiresIn: '15m',
      },
    );

  async function createSuperAdmin(): Promise<Actor> {
    const role = await e2e.dataSource
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: ROLE.SUPER_ADMIN })
      .andWhere('r."tenantId" IS NULL')
      .getOneOrFail();
    const users = e2e.dataSource.getRepository(User);
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `act-admin-${RUN}@example.test`,
        full_name: 'E2E activity admin',
        is_active: true,
      }),
    );
    await e2e.dataSource
      .getRepository(UserRole)
      .save({ user: { id: user.id } as User, role: { id: role.id } as Role });
    createdUserIds.push(user.id);
    return { userId: user.id, token: await mint(user.id) };
  }

  async function createRep(label: string): Promise<string> {
    const res = await post('/platform/staff', {
      email: `act-${label}-${RUN}@example.test`,
      fullName: `Act ${label}`,
      roleSlug: ROLE.PLATFORM_SALES,
      sendInvitation: false,
    }).expect(201);
    createdUserIds.push(res.body.id);
    return res.body.id as string;
  }

  async function seedClinic(label: string, deleted = false): Promise<string> {
    const [row] = (await e2e.dataSource.query(
      `INSERT INTO tenants (name, slug, contact_email, approval_status, deleted_at)
       VALUES ($1, $2, $3, 'APPROVED', ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
      [`ActE2E ${label}`, `act-${RUN}-${label}`, `act-${RUN}-${label}@example.test`],
    )) as Array<{ id: string }>;
    createdTenantIds.push(row.id);
    return row.id;
  }

  const log = (rep: string, body: object) => post(`/platform/sales/employees/${rep}/activities`, body);
  const list = (rep: string, qs = '') => get(`/platform/sales/employees/${rep}/activities${qs}`);
  const prospect = (over: Record<string, unknown> = {}) => ({
    type: 'visit',
    occurredAt: ago(1),
    prospectName: 'Al Noor Polyclinic',
    ...over,
  });

  beforeAll(async () => {
    e2e = await createE2eApp();
    admin = await createSuperAdmin();
    repA = await createRep('A');
    repB = await createRep('B');
    clinic1 = await seedClinic('c1');
    clinic2 = await seedClinic('c2');
    clinic3 = await seedClinic('c3');
    deletedClinic = await seedClinic('gone', true);
    await post(`/platform/sales/employees/${repA}/assignments`, {
      tenantIds: [clinic1, clinic2, clinic3],
      kind: 'managed',
    }).expect(201);
  }, 90_000);

  afterAll(async () => {
    const ds = e2e.dataSource;
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM sales_activities WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
    }
    if (createdTenantIds.length) {
      await ds.query(`DELETE FROM sales_activities WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE tenant_id = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM api_logs WHERE "tenantId" = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM audit_logs WHERE "tenantId" = ANY($1::uuid[])`, [createdTenantIds]);
      await ds.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [createdTenantIds]);
    }
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM password_resets WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM refresh_tokens WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM user_roles WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM audit_logs WHERE "userId" = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
    }
    await e2e.app.close();
  }, 60_000);

  // ───────────────────────── logging ─────────────────────────

  describe('logging an activity', () => {
    it('records a prospect visit, labelled as manually entered by the acting admin', async () => {
      const res = await log(repA, prospect({ outcome: 'interested', note: 'Wants a demo next week' })).expect(201);
      expect(res.body).toMatchObject({
        type: 'visit',
        clinic: null,
        prospectName: 'Al Noor Polyclinic',
        outcome: 'interested',
        note: 'Wants a demo next week',
        source: 'admin_manual',
        recordedBy: { id: admin.userId },
      });
      expect(res.body.id).toEqual(expect.any(String));
    });

    it('records an activity about a clinic on the platform, echoing its name and slug', async () => {
      const res = await log(repA, { type: 'demo', occurredAt: ago(2), tenantId: clinic1, outcome: 'signed_up' }).expect(201);
      expect(res.body.clinic).toMatchObject({ id: clinic1, slug: `act-${RUN}-c1` });
      expect(res.body.prospectName).toBeNull();
    });

    it('trims the prospect name and stores an empty note as nothing', async () => {
      const res = await log(repA, prospect({ prospectName: '  Dr. Salem  ', note: '   ' })).expect(201);
      expect(res.body).toMatchObject({ prospectName: 'Dr. Salem', note: null });
    });

    it('needs exactly one of clinic / prospect — never a 500 from the database CHECK', async () => {
      const neither = await log(repA, { type: 'call', occurredAt: ago(1) }).expect(400);
      const blank = await log(repA, { type: 'call', occurredAt: ago(1), prospectName: '   ' }).expect(400);
      const both = await log(repA, prospect({ tenantId: clinic1 })).expect(400);
      for (const r of [neither, blank, both]) expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(both.body.context?.field ?? both.body.publicContext?.field ?? JSON.stringify(both.body)).toContain('prospectName');
    });

    it('refuses a future date, an absurdly old one, and an unknown or deleted clinic', async () => {
      await log(repA, prospect({ occurredAt: ago(-1) })).expect(400); //   tomorrow
      await log(repA, prospect({ occurredAt: ago(731) })).expect(400); //  a mistyped year
      await log(repA, { type: 'visit', occurredAt: ago(1), tenantId: randomUUID() }).expect(400);
      await log(repA, { type: 'visit', occurredAt: ago(1), tenantId: deletedClinic }).expect(400);
    });

    it('tolerates a few minutes of browser clock skew, not more', async () => {
      await log(repA, prospect({ occurredAt: new Date(Date.now() + 2 * 60_000).toISOString() })).expect(201);
      await log(repA, prospect({ occurredAt: new Date(Date.now() + 30 * 60_000).toISOString() })).expect(400);
    });

    it('rejects malformed input: unknown type/outcome, a bare date, a zone-less time, overlong text', async () => {
      await log(repA, prospect({ type: 'lunch' })).expect(400);
      await log(repA, prospect({ outcome: 'maybe' })).expect(400);
      await log(repA, prospect({ occurredAt: ago(1).slice(0, 10) })).expect(400);
      await log(repA, prospect({ occurredAt: ago(1).slice(0, 19) })).expect(400);
      await log(repA, prospect({ note: 'x'.repeat(1001) })).expect(400);
      await log(repA, prospect({ prospectName: 'x'.repeat(201) })).expect(400);
    });

    it('the server owns source, recordedBy and the employee — the client cannot set them', async () => {
      await log(repA, prospect({ source: 'self' })).expect(400);
      await log(repA, prospect({ recordedBy: randomUUID() })).expect(400);
      await log(repA, prospect({ salesUserId: repB })).expect(400);
      const rows = await e2e.dataSource.query(`SELECT 1 FROM sales_activities WHERE sales_user_id = $1`, [repB]);
      expect(rows).toHaveLength(0);
    });

    it('audits the entry against the clinic and never copies the free-text note into the log', async () => {
      const res = await log(repA, { type: 'meeting', occurredAt: ago(3), tenantId: clinic2, note: 'CONFIDENTIAL-REMARK' }).expect(201);
      const rows = (await e2e.dataSource.query(
        `SELECT "tenantId", new_values AS after FROM audit_logs
          WHERE "userId" = $1 AND action = 'platform_admin.sales.activity_logged' AND entity_id = $2`,
        [admin.userId, res.body.id],
      )) as Array<{ tenantId: string; after: Record<string, unknown> }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(clinic2);
      expect(rows[0].after).toMatchObject({ employeeId: repA, type: 'meeting', hasNote: true });
      expect(JSON.stringify(rows[0])).not.toContain('CONFIDENTIAL-REMARK');
    });
  });

  // ───────────────────────── reading ─────────────────────────

  describe('listing', () => {
    it('is newest first and belongs to ONE employee only', async () => {
      await log(repB, prospect({ prospectName: 'Only B', occurredAt: ago(1) })).expect(201);
      const a = (await list(repA).expect(200)).body;
      const times = a.data.map((r: { occurredAt: string }) => Date.parse(r.occurredAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect(a.data.some((r: { prospectName: string }) => r.prospectName === 'Only B')).toBe(false);
      const b = (await list(repB).expect(200)).body;
      expect(b.data.map((r: { prospectName: string }) => r.prospectName)).toEqual(['Only B']);
      expect(b.total).toBe(1);
    });

    it('filters by type and by clinic', async () => {
      const calls = (await list(repA, '?type=demo').expect(200)).body;
      expect(calls.data.every((r: { type: string }) => r.type === 'demo')).toBe(true);
      expect(calls.total).toBeGreaterThanOrEqual(1);
      const c1 = (await list(repA, `?tenantId=${clinic1}`).expect(200)).body;
      expect(c1.data.length).toBeGreaterThanOrEqual(1);
      expect(c1.data.every((r: { clinic: { id: string } | null }) => r.clinic?.id === clinic1)).toBe(true);
    });

    it('`to` is an inclusive UTC day; `from` starts at 00:00Z', async () => {
      const rep = await createRep('days');
      const day = ago(10).slice(0, 10);
      const first = await log(rep, prospect({ prospectName: 'Late', occurredAt: `${day}T23:30:00.000Z` })).expect(201);
      const second = await log(rep, prospect({ prospectName: 'Early', occurredAt: `${day}T00:30:00.000Z` })).expect(201);
      const names = async (qs: string) =>
        ((await list(rep, qs).expect(200)).body.data as Array<{ id: string }>).map((r) => r.id);

      expect((await names(`?from=${day}&to=${day}`)).sort()).toEqual([first.body.id, second.body.id].sort());
      const before = new Date(Date.parse(`${day}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
      const after = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
      expect(await names(`?from=${before}&to=${before}`)).toEqual([]); //  the day before: nothing
      expect(await names(`?from=${after}`)).toEqual([]); //                from the day after: nothing
      expect(await names(`?to=${before}`)).toEqual([]);
    });

    it('rejects an impossible date and an inverted range', async () => {
      await list(repA, '?from=2026-02-31').expect(400);
      await list(repA, '?from=2026-09-30&to=2026-09-01').expect(400);
      await list(repA, '?from=today').expect(400);
    });

    it('pages', async () => {
      const rep = await createRep('pages');
      for (let i = 1; i <= 5; i++) await log(rep, prospect({ prospectName: `P${i}`, occurredAt: ago(i) })).expect(201);
      const p2 = (await list(rep, '?limit=2&page=2').expect(200)).body;
      expect(p2).toMatchObject({ page: 2, limit: 2, total: 5 });
      expect(p2.data.map((r: { prospectName: string }) => r.prospectName)).toEqual(['P3', 'P4']);
    });
  });

  // ───────────────────────── deleting ─────────────────────────

  describe('deleting', () => {
    it('soft-deletes: the row disappears from the list but is kept, and the delete is audited', async () => {
      const made = await log(repA, { type: 'call', occurredAt: ago(4), tenantId: clinic3 }).expect(201);
      await del(`/platform/sales/employees/${repA}/activities/${made.body.id}`).expect(200);

      const listed = (await list(repA, `?tenantId=${clinic3}`).expect(200)).body;
      expect(listed.data.some((r: { id: string }) => r.id === made.body.id)).toBe(false);
      const [row] = await e2e.dataSource.query(`SELECT deleted_at FROM sales_activities WHERE id = $1`, [made.body.id]);
      expect(row.deleted_at).not.toBeNull();

      const audit = await e2e.dataSource.query(
        `SELECT "tenantId" FROM audit_logs WHERE "userId" = $1 AND action = 'platform_admin.sales.activity_deleted' AND entity_id = $2`,
        [admin.userId, made.body.id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].tenantId).toBe(clinic3);
    });

    it('a second delete is a 404', async () => {
      const made = await log(repA, prospect()).expect(201);
      await del(`/platform/sales/employees/${repA}/activities/${made.body.id}`).expect(200);
      const again = await del(`/platform/sales/employees/${repA}/activities/${made.body.id}`).expect(404);
      expect(again.body.code).toBe('SALES_ACTIVITY_NOT_FOUND');
    });

    it("another employee's activity id is an identical 404 — and the row is untouched (no IDOR)", async () => {
      const made = await log(repA, prospect({ prospectName: 'Mine' })).expect(201);
      const foreign = await del(`/platform/sales/employees/${repB}/activities/${made.body.id}`).expect(404);
      const unknown = await del(`/platform/sales/employees/${repA}/activities/${randomUUID()}`).expect(404);
      expect(foreign.body.code).toBe('SALES_ACTIVITY_NOT_FOUND');
      expect(unknown.body.code).toBe('SALES_ACTIVITY_NOT_FOUND');
      const [row] = await e2e.dataSource.query(`SELECT deleted_at FROM sales_activities WHERE id = $1`, [made.body.id]);
      expect(row.deleted_at).toBeNull();
    });
  });

  // ───────────────────────── the figures Phase 2 built ─────────────────────────

  describe('last-activity figures carry real data', () => {
    let rep: string;
    let cA: string;
    let cB: string;
    let cC: string;
    let newest: string;

    beforeAll(async () => {
      rep = await createRep('last');
      cA = await seedClinic('la');
      cB = await seedClinic('lb');
      cC = await seedClinic('lc');
      await post(`/platform/sales/employees/${rep}/assignments`, { tenantIds: [cA, cB, cC], kind: 'managed' }).expect(201);
      await log(rep, { type: 'visit', occurredAt: ago(2), tenantId: cA }).expect(201); //  recent
      await log(rep, { type: 'call', occurredAt: ago(40), tenantId: cB }).expect(201); //  stale
      // cC: never worked
      const n = await log(rep, prospect({ occurredAt: ago(0, -1) })).expect(201); //  newest, but a PROSPECT
      newest = n.body.id;
    });

    it('the employee list shows the latest non-deleted activity', async () => {
      const row = (await get(`/platform/sales/employees?search=act-last-${RUN}`).expect(200)).body.data[0];
      expect(Date.parse(row.lastActivityAt)).toBeGreaterThan(Date.now() - 2 * 3_600_000);
      await del(`/platform/sales/employees/${rep}/activities/${newest}`).expect(200);
      const after = (await get(`/platform/sales/employees?search=act-last-${RUN}`).expect(200)).body.data[0];
      expect(Date.parse(after.lastActivityAt)).toBeLessThan(Date.now() - 1.5 * DAY); // fell back to the clinic visit 2 days ago
    });

    it('the portfolio shows the last activity PER clinic, and the "not worked in 30 days" filter uses it', async () => {
      const all = (await get(`/platform/sales/employees/${rep}/clinics?limit=50`).expect(200)).body.data as Array<{
        clinic: { id: string };
        lastActivityAt: string | null;
      }>;
      const byId = new Map(all.map((r) => [r.clinic.id, r.lastActivityAt]));
      expect(byId.get(cA)).not.toBeNull();
      expect(byId.get(cB)).not.toBeNull();
      expect(byId.get(cC)).toBeNull();

      const stale = (await get(`/platform/sales/employees/${rep}/clinics?staleDays=30&limit=50`).expect(200)).body.data as Array<{
        clinic: { id: string };
      }>;
      expect(stale.map((r) => r.clinic.id).sort()).toEqual([cB, cC].sort()); // 40 days ago and never — not the recent one
    });

    it('deleting the only recent activity of a clinic makes it stale again', async () => {
      const mine = (await list(rep, `?tenantId=${cA}`).expect(200)).body.data[0];
      await del(`/platform/sales/employees/${rep}/activities/${mine.id}`).expect(200);
      const stale = (await get(`/platform/sales/employees/${rep}/clinics?staleDays=30&limit=50`).expect(200)).body.data as Array<{
        clinic: { id: string };
      }>;
      expect(stale.map((r) => r.clinic.id)).toContain(cA);
    });
  });

  // ───────────────────────── deactivated employee ─────────────────────────

  describe('a deactivated employee', () => {
    it('can still have past activity logged (catching up after they left)', async () => {
      const rep = await createRep('left');
      await patch(`/platform/staff/${rep}/status`, { isActive: false }).expect(200);
      await log(rep, prospect({ occurredAt: ago(5) })).expect(201);
      expect((await list(rep).expect(200)).body.total).toBe(1);
    });
  });

  // ───────────────────────── measured: no N+1 ─────────────────────────

  describe('query count does not grow with the number of rows', () => {
    const proto = PgClient.prototype as unknown as { query: (...a: unknown[]) => unknown };
    const original = proto.query;
    let counting = false;
    let count = 0;

    beforeAll(() => {
      proto.query = function patched(this: unknown, ...args: unknown[]) {
        if (counting) count++;
        return original.apply(this, args);
      };
    });
    afterAll(() => {
      proto.query = original;
    });

    it('activities list: same statement count for 1 row and for 30', async () => {
      const rep = await createRep('qc');
      const statements = async (): Promise<number> => {
        count = 0;
        counting = true;
        try {
          await list(rep, '?limit=50').expect(200);
        } finally {
          counting = false;
        }
        return count;
      };
      await log(rep, { type: 'demo', occurredAt: ago(1), tenantId: clinic1 }).expect(201);
      await list(rep); // warm
      const one = await statements();
      for (let i = 0; i < 29; i++) {
        await e2e.dataSource.query(
          `INSERT INTO sales_activities (sales_user_id, tenant_id, type, occurred_at, source, recorded_by)
           VALUES ($1, $2, 'visit', now() - ($3 || ' hours')::interval, 'admin_manual', $4)`,
          [rep, i % 2 ? clinic1 : clinic2, String(i + 2), admin.userId],
        );
      }
      const many = await statements();
      console.log(`[query-count] activities: 1 row → ${one}, 30 rows → ${many}`);
      expect(many).toBe(one);
    });
  });
});
