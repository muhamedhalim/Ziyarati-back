/**
 * HTTP e2e — Sales Staff Management, Phase 5: monthly targets and progress.
 *
 * Real AppModule, real Postgres (`ziyarati_e2e`, built from the migrations).
 * The attribution tests seed ownership windows and invoices with EXPLICIT
 * timestamps in a closed month (2019-03) so every expected figure is exact and
 * independent of the clock, and so no other data in the database can reach it.
 * The boundary cases are deliberate: an invoice at 23:59:59Z on the last day
 * belongs to March and one at 00:00:00Z on the 1st belongs to April (the dev
 * host runs at UTC+3, so a local-time month would put both in the wrong place),
 * and an invoice paid at the exact instant of a reassignment belongs to the NEW
 * owner only.
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
const CLOSED = '2019-03'; // fully in the past, untouched by any other fixture

interface Actor {
  userId: string;
  token: string;
}

describe('Sales Staff Management — targets and progress (HTTP e2e)', () => {
  let e2e: E2eApp;
  let admin: Actor;
  let support: Actor;
  let repA: string;
  let repB: string;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  const http = () => e2e.app.getHttpServer();
  const get = (path: string, token = admin.token) =>
    request(http()).get(`${API}${path}`).set(...authHeader(token));
  const post = (path: string, body: object = {}, token = admin.token) =>
    request(http()).post(`${API}${path}`).set(...authHeader(token)).send(body);
  const put = (path: string, body: object = {}, token = admin.token) =>
    request(http()).put(`${API}${path}`).set(...authHeader(token)).send(body);
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

  async function createPlatformActor(roleSlug: string, label: string): Promise<Actor> {
    const role = await e2e.dataSource
      .getRepository(Role)
      .createQueryBuilder('r')
      .where('r.slug = :slug', { slug: roleSlug })
      .andWhere('r."tenantId" IS NULL')
      .getOneOrFail();
    const users = e2e.dataSource.getRepository(User);
    const user = await users.save(
      users.create({
        tenant: undefined,
        email: `${label}-${RUN}-${randomUUID().slice(0, 6)}@example.test`,
        full_name: `E2E ${label}`,
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
      email: `tgt-${label}-${RUN}@example.test`,
      fullName: `Tgt ${label}`,
      roleSlug: ROLE.PLATFORM_SALES,
      sendInvitation: false,
    }).expect(201);
    createdUserIds.push(res.body.id);
    return res.body.id as string;
  }

  async function seedClinic(
    label: string,
    opts: { status?: string; deleted?: boolean } = {},
  ): Promise<string> {
    const [row] = (await e2e.dataSource.query(
      `INSERT INTO tenants (name, slug, contact_email, approval_status, deleted_at)
       VALUES ($1, $2, $3, $4, ${opts.deleted ? 'now()' : 'NULL'})
       RETURNING id`,
      [
        `TgtE2E ${label}`,
        `tgt-${RUN}-${label}`,
        `tgt-${RUN}-${label}@example.test`,
        opts.status ?? 'APPROVED',
      ],
    )) as Array<{ id: string }>;
    createdTenantIds.push(row.id);
    return row.id;
  }

  /** Ownership row with explicit timestamps (the service always uses now()). */
  const own = (
    userId: string,
    tenantId: string,
    kind: 'acquired' | 'managed',
    assignedAt: string,
    endedAt: string | null = null,
  ) =>
    e2e.dataSource.query(
      `INSERT INTO sales_clinic_assignments
         (sales_user_id, tenant_id, kind, assigned_at, ended_at, end_reason)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6)`,
      [userId, tenantId, kind, assignedAt, endedAt, endedAt ? 'reassigned' : null],
    );

  async function invoice(
    tenantId: string,
    status: 'PAID' | 'OPEN' | 'REFUNDED' | 'VOID',
    amount: number,
    currency: string,
    paidAt: string | null,
  ) {
    const [row] = (await e2e.dataSource.query(
      `INSERT INTO subscription_invoices
         (tenant_id, subscription_id, amount, status, paid_at, issued_at,
          period_start, period_end, currency)
       VALUES ($1, $2, $3, $4, $5::timestamptz, COALESCE($5::timestamptz, now()),
               COALESCE($5::timestamptz, now()), COALESCE($5::timestamptz, now()) + interval '30 days', $6)
       RETURNING id`,
      [tenantId, randomUUID(), amount, status, paidAt, currency],
    )) as Array<{ id: string }>;
    createdInvoiceIds.push(row.id);
  }

  const targetsUrl = (rep: string, period: string, metric: string) =>
    `/platform/sales/employees/${rep}/targets/${period}/${metric}`;

  const metricOf = (body: { months: Array<{ metrics: Array<{ metric: string }> }> }, monthIdx: number, metric: string) =>
    body.months[monthIdx].metrics.find((m) => m.metric === metric) as Record<string, any>;

  beforeAll(async () => {
    e2e = await createE2eApp();
    admin = await createPlatformActor(ROLE.SUPER_ADMIN, 'tsa');
    support = await createPlatformActor(ROLE.PLATFORM_SUPPORT, 'tcs');
    repA = await createRep('A');
    repB = await createRep('B');
  }, 90_000);

  afterAll(async () => {
    const ds = e2e.dataSource;
    if (createdInvoiceIds.length) {
      await ds.query(`DELETE FROM subscription_invoices WHERE id = ANY($1::uuid[])`, [createdInvoiceIds]);
    }
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM sales_bonus_records WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
      // Revisions go with their target (ON DELETE CASCADE).
      await ds.query(`DELETE FROM sales_targets WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
      await ds.query(`DELETE FROM sales_clinic_assignments WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
    }
    if (createdTenantIds.length) {
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

  // ───────────────────────── attribution: exact figures ─────────────────────────

  describe('progress is attributed exactly (closed month 2019-03)', () => {
    beforeAll(async () => {
      const c1 = await seedClinic('c1');
      const c2 = await seedClinic('c2');
      const c3 = await seedClinic('c3');
      const c4 = await seedClinic('c4');
      const c5 = await seedClinic('c5');
      const cRejected = await seedClinic('rej', { status: 'REJECTED' });
      const cDeleted = await seedClinic('del', { deleted: true });

      // repA: c1, c2 acquired in March; c4 acquired in February; rejected + deleted acquired in
      // March (must NOT count); c3 is managed and moves to repB at 2019-03-15T12:00:00Z.
      await own(repA, c1, 'acquired', '2019-03-02T09:00:00Z');
      await own(repA, c2, 'acquired', '2019-03-10T09:00:00Z');
      await own(repA, c4, 'acquired', '2019-02-20T09:00:00Z');
      await own(repA, cRejected, 'acquired', '2019-03-06T09:00:00Z');
      await own(repA, cDeleted, 'acquired', '2019-03-07T09:00:00Z');
      await own(repA, c3, 'managed', '2019-01-01T00:00:00Z', '2019-03-15T12:00:00Z');
      await own(repB, c3, 'managed', '2019-03-15T12:00:00Z');
      await own(repB, c5, 'acquired', '2019-03-05T09:00:00Z');

      // c1: two March payments, one refunded, one open, one paid at the very start of APRIL.
      await invoice(c1, 'PAID', 200, 'SAR', '2019-03-03T10:00:00Z'); //   first ever -> conversion
      await invoice(c1, 'PAID', 50, 'SAR', '2019-03-31T23:59:59Z'); //    last second of March
      await invoice(c1, 'PAID', 999, 'SAR', '2019-04-01T00:00:00Z'); //   first instant of April
      await invoice(c1, 'REFUNDED', 500, 'SAR', '2019-03-05T10:00:00Z'); // not revenue
      await invoice(c1, 'OPEN', 700, 'SAR', null); //                     not revenue
      await invoice(c1, 'VOID', 300, 'SAR', null); //                     not revenue
      // c2: a February payment BEFORE repA owned it, then a March USD payment.
      await invoice(c2, 'PAID', 10, 'SAR', '2019-02-10T10:00:00Z');
      await invoice(c2, 'PAID', 30, 'USD', '2019-03-12T10:00:00Z');
      // c3: paid during repA's window, at the exact reassignment instant, and after it.
      await invoice(c3, 'PAID', 100, 'SAR', '2019-03-10T10:00:00Z'); //   repA (first ever -> repA conversion)
      await invoice(c3, 'PAID', 40, 'SAR', '2019-03-15T12:00:00Z'); //    boundary -> repB ONLY
      await invoice(c3, 'PAID', 60, 'SAR', '2019-03-20T10:00:00Z'); //    repB
    }, 30_000);

    it('reports the right figure for each metric, without a target set', async () => {
      const a = (await get(`/platform/sales/employees/${repA}/targets?from=${CLOSED}&to=${CLOSED}`).expect(200)).body;
      // new clinics: c1 + c2. Not c4 (Feb), not the rejected/deleted clinics, not managed c3.
      expect(metricOf(a, 0, 'new_clinics')).toMatchObject({ achieved: 2, target: null, percentage: null, onTrack: null });
      // revenue (SAR): c1 200 + 50, plus c3's 100 while repA owned it. NOT c1's 999 (April), refunded, open, void.
      expect(metricOf(a, 0, 'subscription_revenue')).toMatchObject({ achieved: 350, currency: 'SAR' });
      // c2's USD payment is reported, but never added to SAR.
      expect(metricOf(a, 0, 'subscription_revenue').excludedCurrencies).toEqual([{ currency: 'USD', amount: 30 }]);
      // conversions: c1 (first paid Mar 3) and c3 (first paid Mar 10, while repA owned it). c2's first payment was Feb.
      expect(metricOf(a, 0, 'paid_conversions')).toMatchObject({ achieved: 2 });
    });

    it('an invoice paid at the exact reassignment instant goes to the NEW owner only', async () => {
      const b = (await get(`/platform/sales/employees/${repB}/targets?from=${CLOSED}&to=${CLOSED}`).expect(200)).body;
      expect(metricOf(b, 0, 'subscription_revenue')).toMatchObject({ achieved: 100 }); // 40 + 60
      // ...and repA must NOT also get the boundary invoice: 200 + 50 (c1) + 100 (c3, before the switch).
      const a = (await get(`/platform/sales/employees/${repA}/targets?from=${CLOSED}&to=${CLOSED}`).expect(200)).body;
      expect(metricOf(a, 0, 'subscription_revenue').achieved).toBe(350);
      // c3's FIRST payment was during repA's ownership, so it is not repB's conversion.
      expect(metricOf(b, 0, 'paid_conversions')).toMatchObject({ achieved: 0 });
      expect(metricOf(b, 0, 'new_clinics')).toMatchObject({ achieved: 1 }); // c5
    });

    it('the month boundary is UTC: the last second is March, the first instant is April', async () => {
      const range = (await get(`/platform/sales/employees/${repA}/targets?from=2019-02&to=2019-04`).expect(200)).body;
      expect(range.months.map((m: { period: string }) => m.period)).toEqual(['2019-02', '2019-03', '2019-04']);
      expect(metricOf(range, 1, 'subscription_revenue').achieved).toBe(350);
      expect(metricOf(range, 2, 'subscription_revenue').achieved).toBe(999);
      // February: repA acquired c4, but c2's Feb payment predates repA's ownership -> not credited.
      expect(metricOf(range, 0, 'new_clinics').achieved).toBe(1);
      expect(metricOf(range, 0, 'subscription_revenue').achieved).toBe(0);
      expect(metricOf(range, 0, 'paid_conversions').achieved).toBe(0);
    });

    it('a closed month needs a reason to set a target; then progress, remaining and pace follow', async () => {
      await put(targetsUrl(repA, CLOSED, 'new_clinics'), { targetValue: 4 }).expect(422);
      const set = await put(targetsUrl(repA, CLOSED, 'new_clinics'), { targetValue: 4, reason: 'back-fill from the signed plan' }).expect(200);
      expect(set.body).toMatchObject({
        metric: 'new_clinics',
        target: 4,
        achieved: 2,
        remaining: 2,
        percentage: 50,
        isCompleted: false,
        version: 1,
        onTrack: false, // a closed month is on track only if the target was reached
      });
      await put(targetsUrl(repA, CLOSED, 'subscription_revenue'), {
        targetValue: 700,
        currency: 'SAR',
        reason: 'back-fill',
      }).expect(200);
      const conv = await put(targetsUrl(repA, CLOSED, 'paid_conversions'), { targetValue: 2, reason: 'back-fill' }).expect(200);
      expect(conv.body).toMatchObject({ percentage: 100, isCompleted: true, expectedPercentage: 100, onTrack: true });
      await put(targetsUrl(repB, CLOSED, 'new_clinics'), { targetValue: 2, reason: 'back-fill' }).expect(200);
    });

    it('the team overview aggregates the same figures, revenue per currency', async () => {
      const o = (await get(`/platform/sales/overview?period=${CLOSED}`).expect(200)).body;
      expect(o.targetsSet).toBe(4);
      expect(o.onTrack).toBe(1); // only repA's conversions target was reached
      expect(o.byMetric).toEqual([
        { metric: 'new_clinics', currency: null, targets: 2, target: 6, achieved: 3, percentage: 50, onTrack: 0 },
        { metric: 'subscription_revenue', currency: 'SAR', targets: 1, target: 700, achieved: 350, percentage: 50, onTrack: 0 },
        { metric: 'paid_conversions', currency: null, targets: 1, target: 2, achieved: 2, percentage: 100, onTrack: 1 },
      ]);
    });

    it('the team list attaches each employee\'s targets for the period', async () => {
      const list = (await get(`/platform/sales/employees?period=${CLOSED}&search=${encodeURIComponent('Tgt A')}`).expect(200)).body;
      const a = list.data.find((e: { id: string }) => e.id === repA);
      expect(a.targets).toEqual([
        { metric: 'new_clinics', target: 4, currency: null, achieved: 2, percentage: 50, isCompleted: false, expectedPercentage: 100, onTrack: false },
        { metric: 'subscription_revenue', target: 700, currency: 'SAR', achieved: 350, percentage: 50, isCompleted: false, expectedPercentage: 100, onTrack: false },
        { metric: 'paid_conversions', target: 2, currency: null, achieved: 2, percentage: 100, isCompleted: true, expectedPercentage: 100, onTrack: true },
      ]);
    });

    it('reassigning through the API splits an invoice exactly at the switch (no double credit)', async () => {
      const c = await seedClinic('live');
      await post(`/platform/sales/employees/${repA}/assignments`, { tenantIds: [c] }).expect(201);
      await post(`/platform/sales/employees/${repB}/assignments`, { tenantIds: [c], onConflict: 'reassign' }).expect(201);
      const rows = (await e2e.dataSource.query(
        `SELECT sales_user_id, assigned_at, ended_at FROM sales_clinic_assignments WHERE tenant_id = $1`,
        [c],
      )) as Array<{ sales_user_id: string; assigned_at: Date; ended_at: Date | null }>;
      const old = rows.find((r) => r.sales_user_id === repA)!;
      const now = rows.find((r) => r.sales_user_id === repB)!;
      // The two windows meet at exactly one instant — that is what makes the split exact.
      expect(old.ended_at!.getTime()).toBe(now.assigned_at.getTime());

      const cur = new Date();
      // Only meaningful while both instants fall in the current UTC month.
      if (old.assigned_at.getUTCMonth() === cur.getUTCMonth() && now.assigned_at.getUTCMonth() === cur.getUTCMonth()) {
        // Postgres keeps microseconds; a JS Date keeps milliseconds. Take the switch instant from the
        // database itself so the invoice lands on it EXACTLY.
        const paid = (amount: number, at: string, owner: string) =>
          e2e.dataSource.query(
            `INSERT INTO subscription_invoices
               (tenant_id, subscription_id, amount, status, paid_at, issued_at, period_start, period_end, currency)
             SELECT tenant_id::text, $2::text, $3::numeric, 'PAID', ${at}, ${at}, ${at}, ${at} + interval '30 days', 'SAR'
               FROM sales_clinic_assignments WHERE tenant_id = $1::uuid AND sales_user_id = $4::uuid
             RETURNING id`,
            [c, randomUUID(), amount, owner],
          ).then((r: Array<{ id: string }>) => createdInvoiceIds.push(r[0].id));
        await paid(11, "assigned_at + interval '1 millisecond'", repA); // inside repA's window
        await paid(22, 'assigned_at', repB); //                          exactly the switch instant (repB's assigned_at == repA's ended_at)
        const period = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`;
        const a = (await get(`/platform/sales/employees/${repA}/targets?from=${period}&to=${period}`).expect(200)).body;
        const b = (await get(`/platform/sales/employees/${repB}/targets?from=${period}&to=${period}`).expect(200)).body;
        expect(metricOf(a, 0, 'subscription_revenue').achieved).toBe(11);
        expect(metricOf(b, 0, 'subscription_revenue').achieved).toBe(22);
      }
    });
  });

  // ───────────────────────── writes: versions, reasons, locks ─────────────────────────

  describe('target writes', () => {
    const OPEN = (() => {
      const d = new Date();
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })();
    let rep: string;

    beforeAll(async () => {
      rep = await createRep('W');
    });

    it('creates at version 1, updates with the right version, refuses a stale one, and a no-op writes nothing', async () => {
      const url = targetsUrl(rep, OPEN, 'new_clinics');
      const created = await put(url, { targetValue: 10 }).expect(200);
      expect(created.body).toMatchObject({ target: 10, version: 1 });

      const updated = await put(url, { targetValue: 12, expectedVersion: 1 }).expect(200);
      expect(updated.body).toMatchObject({ target: 12, version: 2 });

      const stale = await put(url, { targetValue: 15, expectedVersion: 1 }).expect(409);
      expect(stale.body.code).toBe('SALES_TARGET_VERSION_CONFLICT');

      const same = await put(url, { targetValue: 12, expectedVersion: 2 }).expect(200);
      expect(same.body.version).toBe(2); // unchanged: no bump

      const revs = (await get(`/platform/sales/employees/${rep}/target-revisions?period=${OPEN}&metric=new_clinics`).expect(200)).body;
      expect(revs.total).toBe(2); // create + one real update; the stale and the no-op left nothing
      expect(revs.data.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
      expect(revs.data[0]).toMatchObject({ before: { targetValue: 10 }, after: { targetValue: 12 }, period: OPEN, metric: 'new_clinics' });
      expect(revs.data[1].before).toBeNull();
      expect(revs.data[0].changedBy.id).toBe(admin.userId);
    });

    it('two concurrent updates with the same expectedVersion: exactly one wins', async () => {
      const url = targetsUrl(rep, OPEN, 'paid_conversions');
      await put(url, { targetValue: 5 }).expect(200);
      // Six writers, all holding version 1: the row lock lets exactly one through.
      const results = await Promise.all(
        [6, 7, 8, 9, 10, 11].map((v) => put(url, { targetValue: v, expectedVersion: 1 })),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      const now = (await get(`/platform/sales/employees/${rep}/targets?from=${OPEN}&to=${OPEN}`).expect(200)).body;
      expect(metricOf(now, 0, 'paid_conversions').version).toBe(2);
    });

    it('the row lock makes a writer WAIT for a concurrent edit, then see its version', async () => {
      // Deterministic proof of the lock (racing HTTP calls can serialize by luck):
      // hold the row in another transaction and show the PUT cannot get past it.
      const list = (await get(`/platform/sales/employees/${rep}/targets?from=${OPEN}&to=${OPEN}`).expect(200)).body;
      const version = metricOf(list, 0, 'new_clinics').version as number;
      const qr = e2e.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(
          `SELECT 1 FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics' FOR UPDATE`,
          [rep, `${OPEN}-01`],
        );
        let settled = false;
        const pending = put(targetsUrl(rep, OPEN, 'new_clinics'), { targetValue: 77, expectedVersion: version }).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(settled).toBe(false); // blocked on the row lock, not racing past it
        await qr.query(
          `UPDATE sales_targets SET version = version + 1 WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics'`,
          [rep, `${OPEN}-01`],
        );
        await qr.commitTransaction();
        const res = await pending;
        expect(res.status).toBe(409); // it re-read AFTER the lock was released and saw the newer version
        expect(res.body.code).toBe('SALES_TARGET_VERSION_CONFLICT');
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
      }
    });

    it('two concurrent CREATES of the same target: one 200, one 409 — never two rows', async () => {
      const url = targetsUrl(rep, OPEN, 'subscription_revenue');
      const [x, y] = await Promise.all([put(url, { targetValue: 100 }), put(url, { targetValue: 200 })]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const rows = await e2e.dataSource.query(
        `SELECT 1 FROM sales_targets WHERE sales_user_id = $1 AND metric = 'subscription_revenue'`,
        [rep],
      );
      expect(rows).toHaveLength(1);
    });

    it('a revenue target defaults its currency to the platform currency and keeps a bonus rule', async () => {
      const r = await put(targetsUrl(rep, '2030-01', 'subscription_revenue'), {
        targetValue: 5000,
        bonusType: 'percent_of_achieved',
        bonusPercent: 5,
        bonusThresholdPct: 100,
      }).expect(200);
      expect(r.body.currency).toBe('SAR');
      expect(r.body.bonusRule).toEqual({ type: 'percent_of_achieved', thresholdPct: 100, amount: null, percent: 5, currency: 'SAR' });
      // A future month has pace 0: never "behind".
      expect(r.body).toMatchObject({ expectedPercentage: 0, onTrack: true });
    });

    it('clears an open-month target; a missing one is 404; a closed month is kept', async () => {
      await put(targetsUrl(rep, '2030-02', 'new_clinics'), { targetValue: 3 }).expect(200);
      await del(`${targetsUrl(rep, '2030-02', 'new_clinics')}?reason=typo`).expect(200);
      const after = (await get(`/platform/sales/employees/${rep}/targets?from=2030-02&to=2030-02`).expect(200)).body;
      expect(metricOf(after, 0, 'new_clinics').target).toBeNull();
      const missing = await del(targetsUrl(rep, '2030-02', 'new_clinics')).expect(404);
      expect(missing.body.code).toBe('SALES_TARGET_NOT_FOUND');

      await put(targetsUrl(rep, '2019-05', 'new_clinics'), { targetValue: 3, reason: 'seed' }).expect(200);
      const kept = await del(targetsUrl(rep, '2019-05', 'new_clinics')).expect(409);
      expect(kept.body.code).toBe('SALES_TARGET_LOCKED');
    });

    it('a target whose bonus is approved is locked: cannot be changed or cleared', async () => {
      await put(targetsUrl(rep, '2019-06', 'new_clinics'), { targetValue: 3, reason: 'seed' }).expect(200);
      const [t] = (await e2e.dataSource.query(
        `SELECT id FROM sales_targets WHERE sales_user_id = $1 AND period_month = '2019-06-01' AND metric = 'new_clinics'`,
        [rep],
      )) as Array<{ id: string }>;
      await e2e.dataSource.query(
        `INSERT INTO sales_bonus_records
           (target_id, sales_user_id, period_month, metric, target_value, achieved_value,
            achievement_pct, rule_snapshot, bonus_amount, currency, status, computed_at, approved_by, approved_at)
         VALUES ($1, $2, '2019-06-01', 'new_clinics', 3, 3, 100, '{}'::jsonb, 100, 'SAR', 'approved', now(), $3, now())`,
        [t.id, rep, admin.userId],
      );
      const changed = await put(targetsUrl(rep, '2019-06', 'new_clinics'), { targetValue: 99, reason: 'please' }).expect(409);
      expect(changed.body.code).toBe('SALES_TARGET_LOCKED');
      await del(targetsUrl(rep, '2019-06', 'new_clinics')).expect(409);
      const list = (await get(`/platform/sales/employees/${rep}/targets?from=2019-06&to=2019-06`).expect(200)).body;
      expect(metricOf(list, 0, 'new_clinics')).toMatchObject({ target: 3, locked: true });

      // A VOIDED bonus unlocks the target for a corrected edit (but still blocks deletion, which would orphan the record).
      await e2e.dataSource.query(`UPDATE sales_bonus_records SET status = 'void', void_reason = 'test', voided_by = $2, voided_at = now() WHERE target_id = $1`, [t.id, admin.userId]);
      await put(targetsUrl(rep, '2019-06', 'new_clinics'), { targetValue: 4, reason: 'corrected' }).expect(200);
    });

    it('a deactivated employee gets no new open-month target, but a closed month can still be corrected', async () => {
      const gone = await createRep('gone');
      await patch(`/platform/staff/${gone}/status`, { isActive: false }).expect(200);
      const refused = await put(targetsUrl(gone, OPEN, 'new_clinics'), { targetValue: 3 }).expect(409);
      expect(refused.body.code).toBe('SALES_EMPLOYEE_INACTIVE');
      await put(targetsUrl(gone, '2019-07', 'new_clinics'), { targetValue: 3, reason: 'left mid-month' }).expect(200);
    });

    it('rejects invalid input with 400 and never reaches the database CHECKs (which would be a 500)', async () => {
      const bad: Array<[string, string, object]> = [
        ['a fraction of a clinic', 'new_clinics', { targetValue: 2.5 }],
        ['a negative target', 'new_clinics', { targetValue: -1 }],
        ['a currency on a clinic target', 'new_clinics', { targetValue: 2, currency: 'SAR' }],
        ['an unsupported currency', 'subscription_revenue', { targetValue: 2, currency: 'JPY' }],
        ['a percentage bonus on a clinic target', 'new_clinics', { targetValue: 2, bonusType: 'percent_of_achieved', bonusPercent: 5 }],
        ['a fixed bonus without an amount', 'new_clinics', { targetValue: 2, bonusType: 'fixed_on_threshold', bonusThresholdPct: 100 }],
        ['a stray bonus amount with no bonus type', 'new_clinics', { targetValue: 2, bonusAmount: 10 }],
        ['an unknown field', 'new_clinics', { targetValue: 2, achieved: 999 }],
        ['a client-supplied achieved value', 'new_clinics', { targetValue: 2, bonusPaid: 1000 }],
      ];
      for (const [label, metric, body] of bad) {
        const res = await put(targetsUrl(rep, OPEN, metric), body);
        expect([label, res.status]).toEqual([label, 400]);
      }
      await put(targetsUrl(rep, OPEN, 'not_a_metric'), { targetValue: 2 }).expect(400);
      await put(targetsUrl(rep, '2026-13', 'new_clinics'), { targetValue: 2 }).expect(400);
      await get(`/platform/sales/employees/${rep}/targets?from=2020-01&to=2026-12`).expect(400); // > 24 months
      await get(`/platform/sales/employees/${rep}/targets?from=2026-05&to=2026-01`).expect(400); // from > to
    });

    it('is scoped to the employee in the path: another employee\'s history is never returned', async () => {
      const other = await createRep('other');
      const mine = (await get(`/platform/sales/employees/${rep}/target-revisions`).expect(200)).body;
      const theirs = (await get(`/platform/sales/employees/${other}/target-revisions`).expect(200)).body;
      expect(mine.total).toBeGreaterThan(0);
      expect(theirs.total).toBe(0);
    });

    it('a non-employee id is the same 404 on every target route (no existence leak)', async () => {
      for (const id of [support.userId, admin.userId, randomUUID()]) {
        const r1 = await get(`/platform/sales/employees/${id}/targets`).expect(404);
        const r2 = await put(targetsUrl(id, OPEN, 'new_clinics'), { targetValue: 1 }).expect(404);
        const r3 = await del(targetsUrl(id, OPEN, 'new_clinics')).expect(404);
        const r4 = await get(`/platform/sales/employees/${id}/target-revisions`).expect(404);
        for (const r of [r1, r2, r3, r4]) expect(r.body.code).toBe('SALES_EMPLOYEE_NOT_FOUND');
      }
    });

    it('audits set and clear with the reason and the before/after state', async () => {
      const rows = (await e2e.dataSource.query(
        `SELECT action, entity_id, old_values AS before, new_values AS after FROM audit_logs
          WHERE "userId" = $1 AND action IN ('platform_admin.sales.target_set', 'platform_admin.sales.target_deleted')
          ORDER BY created_at DESC`,
        [admin.userId],
      )) as Array<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>;
      const set = rows.find((r) => r.action === 'platform_admin.sales.target_set' && (r.after as { reason?: string })?.reason === 'corrected');
      expect(set).toBeDefined();
      expect(set!.before).toMatchObject({ targetValue: 3, metric: 'new_clinics' });
      expect(set!.after).toMatchObject({ targetValue: 4, metric: 'new_clinics' });
      expect(rows.some((r) => r.action === 'platform_admin.sales.target_deleted')).toBe(true);
    });
  });

  // ───────────────────────── measured: no N+1 ─────────────────────────

  describe('query count does not grow with the size of the request', () => {
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

    async function statements(path: string): Promise<number> {
      count = 0;
      counting = true;
      try {
        await get(path).expect(200);
      } finally {
        counting = false;
      }
      return count;
    }

    it('employees list WITH targets: same statement count for 2 and for 12 rows', async () => {
      for (let i = 0; i < 12; i++) {
        const r = await createRep(`qc${i}`);
        await put(targetsUrl(r, CLOSED, 'new_clinics'), { targetValue: 1, reason: 'qc' }).expect(200);
      }
      await get(`/platform/sales/employees?limit=2&period=${CLOSED}`); // warm caches
      const small = await statements(`/platform/sales/employees?limit=2&period=${CLOSED}`);
      const large = await statements(`/platform/sales/employees?limit=12&period=${CLOSED}`);
      console.log(`[query-count] employees+targets: limit=2 → ${small}, limit=12 → ${large}`);
      expect(large).toBe(small);
    });

    it('targets range: same statement count for 1 month and for 24 months', async () => {
      await get(`/platform/sales/employees/${repA}/targets`); // warm
      const one = await statements(`/platform/sales/employees/${repA}/targets?from=${CLOSED}&to=${CLOSED}`);
      const many = await statements(`/platform/sales/employees/${repA}/targets?from=2018-04&to=2020-03`);
      console.log(`[query-count] targets: 1 month → ${one}, 24 months → ${many}`);
      expect(many).toBe(one);
    });

    it('overview: the statement count does not depend on how many targets exist', async () => {
      await get(`/platform/sales/overview?period=${CLOSED}`); // warm
      const withTargets = await statements(`/platform/sales/overview?period=${CLOSED}`);
      const empty = await statements('/platform/sales/overview?period=2001-01');
      console.log(`[query-count] overview: with targets → ${withTargets}, empty month → ${empty}`);
      expect(withTargets).toBeLessThanOrEqual(empty + 3); // at most the three metric queries more than an empty month
    });
  });
});
