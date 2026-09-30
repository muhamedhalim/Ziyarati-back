/**
 * HTTP e2e — Sales Staff Management, Phase 6: bonuses.
 *
 * Real AppModule, real Postgres (`ziyarati_e2e`, built from the migrations).
 * The figures come from a CLOSED month (2019-05) seeded with explicit timestamps,
 * so every expected amount is exact and independent of the clock:
 *   repA acquires 3 clinics; PAID invoices total 2 000 SAR (+ 40 USD, which is
 *   reported but never counted); 3 clinics make their first payment.
 *
 * What is proven here that a mock cannot show:
 *   - the amount is decided by the server from the LOCKED rule (a rule edited
 *     while an approval waits is what gets approved),
 *   - approvals race safely (one wins, the rest get 409, one live row),
 *   - approving locks the target, voiding unlocks it,
 *   - a bonus is only reachable through its own employee.
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
const MAY = '2019-05'; // closed
const JUN = '2019-06'; // closed
const JUL = '2019-07'; // closed
const NOW = new Date();
const CURRENT = `${NOW.getUTCFullYear()}-${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;

interface Actor {
  userId: string;
  token: string;
}

describe('Sales Staff Management — bonuses (HTTP e2e)', () => {
  let e2e: E2eApp;
  let admin: Actor;
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
        email: `bon-admin-${RUN}@example.test`,
        full_name: 'E2E bonus admin',
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
      email: `bon-${label}-${RUN}@example.test`,
      fullName: `Bon ${label}`,
      roleSlug: ROLE.PLATFORM_SALES,
      sendInvitation: false,
    }).expect(201);
    createdUserIds.push(res.body.id);
    return res.body.id as string;
  }

  async function seedClinic(label: string): Promise<string> {
    const [row] = (await e2e.dataSource.query(
      `INSERT INTO tenants (name, slug, contact_email, approval_status)
       VALUES ($1, $2, $3, 'APPROVED') RETURNING id`,
      [`BonE2E ${label}`, `bon-${RUN}-${label}`, `bon-${RUN}-${label}@example.test`],
    )) as Array<{ id: string }>;
    createdTenantIds.push(row.id);
    return row.id;
  }

  const own = (userId: string, tenantId: string, assignedAt: string) =>
    e2e.dataSource.query(
      `INSERT INTO sales_clinic_assignments (sales_user_id, tenant_id, kind, assigned_at)
       VALUES ($1, $2, 'acquired', $3::timestamptz)`,
      [userId, tenantId, assignedAt],
    );

  async function paid(tenantId: string, amount: number, currency: string, at: string) {
    const [row] = (await e2e.dataSource.query(
      `INSERT INTO subscription_invoices
         (tenant_id, subscription_id, amount, status, paid_at, issued_at, period_start, period_end, currency)
       VALUES ($1, $2, $3, 'PAID', $4::timestamptz, $4::timestamptz, $4::timestamptz,
               $4::timestamptz + interval '30 days', $5)
       RETURNING id`,
      [tenantId, randomUUID(), amount, at, currency],
    )) as Array<{ id: string }>;
    createdInvoiceIds.push(row.id);
  }

  const targetUrl = (rep: string, period: string, metric: string) =>
    `/platform/sales/employees/${rep}/targets/${period}/${metric}`;
  const approveUrl = (rep: string, period: string, metric: string) =>
    `${targetUrl(rep, period, metric)}/bonus/approve`;
  const previewUrl = (rep: string, period: string) =>
    `/platform/sales/employees/${rep}/bonus-preview?period=${period}`;
  const item = (body: { items: Array<{ metric: string }> }, metric: string) =>
    body.items.find((i) => i.metric === metric) as Record<string, any>;

  async function liveRecords(target: string): Promise<Array<{ status: string }>> {
    return e2e.dataSource.query(
      `SELECT status FROM sales_bonus_records WHERE target_id = (
         SELECT id FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = $3
       ) AND status <> 'void'`,
      [repA, `${MAY}-01`, target],
    );
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    admin = await createSuperAdmin();
    repA = await createRep('A');
    repB = await createRep('B');

    const c1 = await seedClinic('c1');
    const c2 = await seedClinic('c2');
    const c3 = await seedClinic('c3');
    await own(repA, c1, '2019-05-02T09:00:00Z');
    await own(repA, c2, '2019-05-03T09:00:00Z');
    await own(repA, c3, '2019-05-04T09:00:00Z');
    await paid(c1, 800, 'SAR', '2019-05-10T10:00:00Z'); // first payment of c1
    await paid(c1, 700, 'SAR', '2019-05-20T10:00:00Z');
    await paid(c2, 500, 'SAR', '2019-05-12T10:00:00Z'); // first payment of c2
    await paid(c3, 40, 'USD', '2019-05-13T10:00:00Z'); //  first payment of c3, other currency

    const why = { reason: 'back-fill for the e2e' };
    await put(targetUrl(repA, MAY, 'new_clinics'), {
      targetValue: 3,
      bonusType: 'fixed_on_threshold',
      bonusThresholdPct: 100,
      bonusAmount: 500,
      ...why,
    }).expect(200);
    await put(targetUrl(repA, MAY, 'subscription_revenue'), {
      targetValue: 1500,
      currency: 'SAR',
      bonusType: 'percent_of_achieved',
      bonusThresholdPct: 100,
      bonusPercent: 5,
      ...why,
    }).expect(200);
    await put(targetUrl(repA, MAY, 'paid_conversions'), {
      targetValue: 5,
      bonusType: 'fixed_on_threshold',
      bonusThresholdPct: 100,
      bonusAmount: 300,
      ...why,
    }).expect(200);
    await put(targetUrl(repA, JUN, 'new_clinics'), { targetValue: 1, ...why }).expect(200); // no bonus rule
  }, 90_000);

  afterAll(async () => {
    const ds = e2e.dataSource;
    if (createdInvoiceIds.length) {
      await ds.query(`DELETE FROM subscription_invoices WHERE id = ANY($1::uuid[])`, [createdInvoiceIds]);
    }
    if (createdUserIds.length) {
      await ds.query(`DELETE FROM sales_bonus_records WHERE sales_user_id = ANY($1::uuid[])`, [createdUserIds]);
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

  // ───────────────────────── preview ─────────────────────────

  describe('preview', () => {
    it('reports what each rule pays for the real progress of a closed month', async () => {
      const body = (await get(previewUrl(repA, MAY)).expect(200)).body;
      expect(body).toMatchObject({ employeeId: repA, period: MAY, phase: 'past' });
      expect(body.items.map((i: { metric: string }) => i.metric)).toEqual([
        'new_clinics',
        'subscription_revenue',
        'paid_conversions',
      ]);

      // 3 of 3 clinics → the 100 % threshold is met → the fixed 500 SAR.
      expect(item(body, 'new_clinics')).toMatchObject({
        state: 'ready',
        target: 3,
        achieved: 3,
        applicable: true,
        thresholdMet: true,
        amount: 500,
        bonusCurrency: 'SAR',
        record: null,
        voidedCount: 0,
        version: 1,
      });
      // 2 000 SAR of 1 500 → 133 % → 5 % of the ACHIEVED revenue = 100.00; USD is reported, not counted.
      expect(item(body, 'subscription_revenue')).toMatchObject({
        state: 'ready',
        achieved: 2000,
        currency: 'SAR',
        thresholdMet: true,
        amount: 100,
        excludedCurrencies: [{ currency: 'USD', amount: 40 }],
      });
      // 3 of 5 conversions → 60 % → threshold missed → nothing earned.
      expect(item(body, 'paid_conversions')).toMatchObject({
        state: 'ready',
        achieved: 3,
        thresholdMet: false,
        amount: 0,
      });
    });

    it('a target without a bonus rule is "no_rule" and pays nothing', async () => {
      const body = (await get(previewUrl(repA, JUN)).expect(200)).body;
      expect(item(body, 'new_clinics')).toMatchObject({
        state: 'no_rule',
        applicable: false,
        amount: 0,
        rule: null,
      });
    });

    it('an open month is only a projection', async () => {
      await put(targetUrl(repB, CURRENT, 'new_clinics'), {
        targetValue: 1,
        bonusType: 'fixed_on_threshold',
        bonusThresholdPct: 100,
        bonusAmount: 50,
      }).expect(200);
      const body = (await get(previewUrl(repB, CURRENT)).expect(200)).body;
      expect(body.phase).toBe('current');
      expect(item(body, 'new_clinics')).toMatchObject({ state: 'open', thresholdMet: false, amount: 0 });
    });

    it('defaults to the current month and shows no items when nothing is targeted', async () => {
      const body = (await get(`/platform/sales/employees/${repA}/bonus-preview`).expect(200)).body;
      expect(body.period).toBe(CURRENT);
      expect(body.items).toEqual([]);
    });

    it('rejects a malformed period', async () => {
      await get(`/platform/sales/employees/${repA}/bonus-preview?period=2019-5`).expect(400);
    });
  });

  // ───────────────────────── approve: refusals ─────────────────────────

  describe('approve — refusals', () => {
    it('an open month cannot be approved (422) and nothing is written', async () => {
      const res = await post(approveUrl(repB, CURRENT, 'new_clinics')).expect(422);
      expect(res.body.code).toBe('SALES_PERIOD_NOT_CLOSED');
      const rows = await e2e.dataSource.query(`SELECT 1 FROM sales_bonus_records WHERE sales_user_id = $1`, [repB]);
      expect(rows).toHaveLength(0);
    });

    it('a target without a bonus rule cannot be approved (422)', async () => {
      const res = await post(approveUrl(repA, JUN, 'new_clinics')).expect(422);
      expect(res.body.code).toBe('SALES_BONUS_NO_RULE');
    });

    it('a target that does not exist is a 404', async () => {
      const res = await post(approveUrl(repA, JUL, 'new_clinics')).expect(404);
      expect(res.body.code).toBe('SALES_TARGET_NOT_FOUND');
    });

    it('a client can NEVER supply an amount — every such field is rejected (400)', async () => {
      for (const body of [
        { amount: 999999 },
        { bonusAmount: 999999 },
        { achievedValue: 999 },
        { status: 'paid' },
        { currency: 'USD' },
      ]) {
        await post(approveUrl(repA, MAY, 'new_clinics'), body).expect(400);
      }
      expect(await liveRecords('new_clinics')).toHaveLength(0);
    });

    it('a rule edited since the admin looked (expectedVersion) is a 409, not an approval', async () => {
      const res = await post(approveUrl(repA, MAY, 'new_clinics'), { expectedVersion: 7 }).expect(409);
      expect(res.body.code).toBe('SALES_TARGET_VERSION_CONFLICT');
      expect(await liveRecords('new_clinics')).toHaveLength(0);
    });
  });

  // ───────────────────────── approve: the happy path and its consequences ─────────────────────────

  describe('approve — freezes the calculation and locks the target', () => {
    let bonusId: string;

    it('approves a closed month: 201, server-computed amount, frozen figures', async () => {
      const res = await post(approveUrl(repA, MAY, 'new_clinics'), { expectedVersion: 1 }).expect(201);
      bonusId = res.body.id;
      expect(res.body).toMatchObject({
        period: MAY,
        metric: 'new_clinics',
        status: 'approved',
        amount: 500,
        currency: 'SAR',
        targetValue: 3,
        achievedValue: 3,
        achievementPct: 100,
        approvedBy: { id: admin.userId },
        paidMarkedAt: null,
        voidReason: null,
      });
      expect(res.body.rule).toMatchObject({ type: 'fixed_on_threshold', thresholdPct: 100, amount: 500, thresholdMet: true });
    });

    it('the target is now locked: it cannot be changed or cleared', async () => {
      const put409 = await put(targetUrl(repA, MAY, 'new_clinics'), { targetValue: 99, reason: 'trying to game it' }).expect(409);
      expect(put409.body.code).toBe('SALES_TARGET_LOCKED');
      const del409 = await del(targetUrl(repA, MAY, 'new_clinics')).expect(409);
      expect(del409.body.code).toBe('SALES_TARGET_LOCKED');
      const targets = (await get(`/platform/sales/employees/${repA}/targets?from=${MAY}&to=${MAY}`).expect(200)).body;
      expect(targets.months[0].metrics.find((m: { metric: string }) => m.metric === 'new_clinics')).toMatchObject({
        locked: true,
        target: 3,
      });
    });

    it('the preview now shows the approved record, and a second approval is a 409', async () => {
      const body = (await get(previewUrl(repA, MAY)).expect(200)).body;
      expect(item(body, 'new_clinics')).toMatchObject({ state: 'approved', record: { id: bonusId, amount: 500 } });
      const again = await post(approveUrl(repA, MAY, 'new_clinics')).expect(409);
      expect(again.body.code).toBe('SALES_BONUS_EXISTS');
      expect(await liveRecords('new_clinics')).toHaveLength(1);
    });

    it('the frozen record does not move when the underlying data changes afterwards', async () => {
      // A refund AFTER approval must not rewrite history: the snapshot stands (void + re-approve is the correction).
      const [inv] = await e2e.dataSource.query(
        `UPDATE subscription_invoices SET status = 'REFUNDED' WHERE id = $1 RETURNING id`,
        [createdInvoiceIds[0]],
      );
      expect(inv).toBeDefined();
      const list = (await get(`/platform/sales/employees/${repA}/bonuses?status=approved`).expect(200)).body;
      expect(list.data.find((r: { id: string }) => r.id === bonusId)).toMatchObject({ amount: 500, achievedValue: 3 });
      await e2e.dataSource.query(`UPDATE subscription_invoices SET status = 'PAID' WHERE id = $1`, [createdInvoiceIds[0]]);
    });

    it('writes an audit entry with the frozen figures', async () => {
      const rows = (await e2e.dataSource.query(
        `SELECT new_values AS after FROM audit_logs
          WHERE "userId" = $1 AND action = 'platform_admin.sales.bonus_approved' AND entity_id = $2`,
        [admin.userId, bonusId],
      )) as Array<{ after: Record<string, unknown> }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].after).toMatchObject({ employeeId: repA, period: MAY, metric: 'new_clinics', amount: 500, currency: 'SAR' });
    });
  });

  // ───────────────────────── concurrency ─────────────────────────

  describe('concurrency', () => {
    it('five simultaneous approvals of one target: exactly one 201, four 409, one live row', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => post(approveUrl(repA, MAY, 'subscription_revenue'))),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const losers = results.filter((r) => r.status === 409);
      expect(losers).toHaveLength(4);
      for (const l of losers) expect(l.body.code).toBe('SALES_BONUS_EXISTS');
      expect(await liveRecords('subscription_revenue')).toHaveLength(1);
      const winner = results.find((r) => r.status === 201)!;
      expect(winner.body).toMatchObject({ amount: 100, achievedValue: 2000, currency: 'SAR' });
    });

    it('an approval WAITS for the target lock and decides from the rule it finds AFTER it', async () => {
      // Deterministic: another transaction holds the target row and edits the rule; the approval must
      // block behind it and then approve the EDITED rule (threshold 50 -> the 60 % achieved now earns 300).
      const qr = e2e.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(
          `SELECT 1 FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'paid_conversions' FOR UPDATE`,
          [repA, `${MAY}-01`],
        );
        let settled = false;
        const pending = post(approveUrl(repA, MAY, 'paid_conversions')).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(settled).toBe(false); // blocked on the row lock, not racing past it
        await qr.query(
          `UPDATE sales_targets SET bonus_threshold_pct = 50, version = version + 1
            WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'paid_conversions'`,
          [repA, `${MAY}-01`],
        );
        await qr.commitTransaction();
        const res = await pending;
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ amount: 300, achievementPct: 60 });
        expect(res.body.rule).toMatchObject({ thresholdPct: 50, thresholdMet: true });
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
      }
    });

    it('a target EDIT that waits behind an approval is refused once the approval commits', async () => {
      // The other ordering of the same race. The approval holds the target row and commits a live bonus
      // WITHOUT modifying the target row itself, so the waiting edit gets its lock on an unchanged row —
      // PostgreSQL does not re-run the statement for it, and a `locked` flag read in the SAME statement as
      // FOR UPDATE would still be the stale `false`. The flag must be read AFTER the lock is granted.
      const rep = await createRep('editrace');
      await put(targetUrl(rep, MAY, 'new_clinics'), {
        targetValue: 2,
        bonusType: 'fixed_on_threshold',
        bonusThresholdPct: 100,
        bonusAmount: 10,
        reason: 'e2e',
      }).expect(200);
      const qr = e2e.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(
          `SELECT 1 FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics' FOR UPDATE`,
          [rep, `${MAY}-01`],
        );
        let settled = false;
        const pending = put(targetUrl(rep, MAY, 'new_clinics'), { targetValue: 50, reason: 'sneaky edit' }).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 500));
        expect(settled).toBe(false); // waiting for the lock
        await qr.query(
          `INSERT INTO sales_bonus_records
             (target_id, sales_user_id, period_month, metric, target_value, achieved_value, achievement_pct,
              rule_snapshot, bonus_amount, currency, status, computed_at, approved_by, approved_at)
           SELECT id, sales_user_id, period_month, metric, 2, 0, 0, '{}'::jsonb, 0, 'SAR', 'approved', now(), $3, now()
             FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics'`,
          [rep, `${MAY}-01`, admin.userId],
        );
        await qr.commitTransaction();
        const res = await pending;
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SALES_TARGET_LOCKED');
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
      }
      const [row] = await e2e.dataSource.query(
        `SELECT target_value FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics'`,
        [rep, `${MAY}-01`],
      );
      expect(Number(row.target_value)).toBe(2); // the approved target was NOT rewritten
    });

    it('a waiting approval whose expectedVersion went stale during the wait is refused', async () => {
      const t = (await get(`/platform/sales/employees/${repB}/targets?from=${JUL}&to=${JUL}`).expect(200)).body;
      expect(t.months[0].metrics.every((m: { targetId: unknown }) => m.targetId === null)).toBe(true);
      await put(targetUrl(repB, JUL, 'new_clinics'), {
        targetValue: 1,
        bonusType: 'fixed_on_threshold',
        bonusThresholdPct: 100,
        bonusAmount: 10,
        reason: 'e2e',
      }).expect(200);
      const qr = e2e.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(
          `SELECT 1 FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics' FOR UPDATE`,
          [repB, `${JUL}-01`],
        );
        const pending = post(approveUrl(repB, JUL, 'new_clinics'), { expectedVersion: 1 });
        await new Promise((r) => setTimeout(r, 300));
        await qr.query(
          `UPDATE sales_targets SET bonus_amount = 9999, version = version + 1
            WHERE sales_user_id = $1 AND period_month = $2::date AND metric = 'new_clinics'`,
          [repB, `${JUL}-01`],
        );
        await qr.commitTransaction();
        const res = await pending;
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SALES_TARGET_VERSION_CONFLICT');
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
      }
      const rows = await e2e.dataSource.query(`SELECT 1 FROM sales_bonus_records WHERE sales_user_id = $1`, [repB]);
      expect(rows).toHaveLength(0);
    });
  });

  // ───────────────────────── mark paid / void ─────────────────────────

  describe('mark paid and void', () => {
    let newClinicsBonus: string;
    let revenueBonus: string;

    beforeAll(async () => {
      const list = (await get(`/platform/sales/employees/${repA}/bonuses?limit=50`).expect(200)).body;
      newClinicsBonus = list.data.find((r: { metric: string }) => r.metric === 'new_clinics').id;
      revenueBonus = list.data.find((r: { metric: string }) => r.metric === 'subscription_revenue').id;
    });

    it('marks an approved bonus as paid (bookkeeping only) and records who and when', async () => {
      const res = await post(`/platform/sales/employees/${repA}/bonuses/${newClinicsBonus}/mark-paid`).expect(200);
      expect(res.body).toMatchObject({ id: newClinicsBonus, status: 'paid', paidMarkedBy: { id: admin.userId } });
      expect(res.body.paidMarkedAt).toEqual(expect.any(String));
    });

    it('marking it paid again is a 409 that names the current status', async () => {
      const res = await post(`/platform/sales/employees/${repA}/bonuses/${newClinicsBonus}/mark-paid`).expect(409);
      expect(res.body.code).toBe('SALES_BONUS_STATE_CONFLICT');
    });

    it('a bonus is reachable ONLY through its own employee (no IDOR): another employee gets an identical 404', async () => {
      const unknown = await post(`/platform/sales/employees/${repA}/bonuses/${randomUUID()}/mark-paid`).expect(404);
      const foreign = await post(`/platform/sales/employees/${repB}/bonuses/${revenueBonus}/mark-paid`).expect(404);
      const foreignVoid = await post(`/platform/sales/employees/${repB}/bonuses/${revenueBonus}/void`, { reason: 'x' }).expect(404);
      for (const r of [unknown, foreign, foreignVoid]) expect(r.body.code).toBe('SALES_BONUS_NOT_FOUND');
      const stillApproved = (await get(`/platform/sales/employees/${repA}/bonuses?status=approved`).expect(200)).body;
      expect(stillApproved.data.some((r: { id: string }) => r.id === revenueBonus)).toBe(true);
      const bList = (await get(`/platform/sales/employees/${repB}/bonuses`).expect(200)).body;
      expect(bList.data).toHaveLength(0);
    });

    it('voiding needs a reason (422)', async () => {
      const res = await post(`/platform/sales/employees/${repA}/bonuses/${newClinicsBonus}/void`, { reason: '  ' }).expect(422);
      expect(res.body.code).toBe('SALES_REASON_REQUIRED');
    });

    it('voids a bonus (even one marked paid), audited as such, and the target unlocks', async () => {
      const res = await post(`/platform/sales/employees/${repA}/bonuses/${newClinicsBonus}/void`, { reason: 'wrong bonus amount' }).expect(200);
      expect(res.body).toMatchObject({ status: 'void', voidReason: 'wrong bonus amount', voidedBy: { id: admin.userId } });

      const audit = (await e2e.dataSource.query(
        `SELECT old_values AS before, new_values AS after FROM audit_logs
          WHERE "userId" = $1 AND action = 'platform_admin.sales.bonus_voided' AND entity_id = $2`,
        [admin.userId, newClinicsBonus],
      )) as Array<{ before: Record<string, unknown>; after: Record<string, unknown> }>;
      expect(audit[0].before).toMatchObject({ status: 'paid' });
      expect(audit[0].after).toMatchObject({ status: 'void', reason: 'wrong bonus amount', wasPaid: true });

      const targets = (await get(`/platform/sales/employees/${repA}/targets?from=${MAY}&to=${MAY}`).expect(200)).body;
      expect(targets.months[0].metrics.find((m: { metric: string }) => m.metric === 'new_clinics').locked).toBe(false);
    });

    it('voiding again is a 409', async () => {
      const res = await post(`/platform/sales/employees/${repA}/bonuses/${newClinicsBonus}/void`, { reason: 'again' }).expect(409);
      expect(res.body.code).toBe('SALES_BONUS_STATE_CONFLICT');
    });

    it('a voided bonus cannot be marked paid', async () => {
      await post(`/platform/sales/employees/${repA}/bonuses/${newClinicsBonus}/mark-paid`).expect(409);
    });

    it('after a void the rule can be corrected and approved again; the voided record stays as history', async () => {
      await put(targetUrl(repA, MAY, 'new_clinics'), {
        targetValue: 3,
        bonusType: 'fixed_on_threshold',
        bonusThresholdPct: 100,
        bonusAmount: 600,
        reason: 'corrected the bonus amount',
      }).expect(200);
      const again = await post(approveUrl(repA, MAY, 'new_clinics')).expect(201);
      expect(again.body).toMatchObject({ status: 'approved', amount: 600 });
      expect(again.body.id).not.toBe(newClinicsBonus);

      const voided = (await get(`/platform/sales/employees/${repA}/bonuses?status=void`).expect(200)).body;
      expect(voided.data.map((r: { id: string }) => r.id)).toContain(newClinicsBonus);
      const preview = (await get(previewUrl(repA, MAY)).expect(200)).body;
      expect(item(preview, 'new_clinics')).toMatchObject({ state: 'approved', voidedCount: 1, record: { amount: 600 } });
      expect(await liveRecords('new_clinics')).toHaveLength(1); // one live row, the void row does not count
    });

    it('lists lifetime totals per currency: owed (approved) and paid', async () => {
      // live now: new_clinics 600 (approved), revenue 100 (approved), conversions 300 (approved). Nothing paid.
      let list = (await get(`/platform/sales/employees/${repA}/bonuses`).expect(200)).body;
      expect(list.totals).toEqual({ owed: [{ currency: 'SAR', amount: 1000 }], paid: [] });

      await post(`/platform/sales/employees/${repA}/bonuses/${revenueBonus}/mark-paid`).expect(200);
      list = (await get(`/platform/sales/employees/${repA}/bonuses`).expect(200)).body;
      expect(list.totals).toEqual({ owed: [{ currency: 'SAR', amount: 900 }], paid: [{ currency: 'SAR', amount: 100 }] });
      // newest month first, then newest record
      expect(list.data.every((r: { period: string }) => r.period === MAY)).toBe(true);
    });

    it('filters by period and status, and pages', async () => {
      const paidOnly = (await get(`/platform/sales/employees/${repA}/bonuses?status=paid`).expect(200)).body;
      expect(paidOnly.data).toHaveLength(1);
      expect(paidOnly.data[0].id).toBe(revenueBonus);
      const other = (await get(`/platform/sales/employees/${repA}/bonuses?period=${JUN}`).expect(200)).body;
      expect(other.total).toBe(0);
      const paged = (await get(`/platform/sales/employees/${repA}/bonuses?limit=2&page=2`).expect(200)).body;
      expect(paged).toMatchObject({ page: 2, limit: 2, total: 4 });
      expect(paged.data).toHaveLength(2);
    });

    it('audits mark-paid', async () => {
      const rows = await e2e.dataSource.query(
        `SELECT 1 FROM audit_logs WHERE "userId" = $1 AND action = 'platform_admin.sales.bonus_marked_paid' AND entity_id = $2`,
        [admin.userId, revenueBonus],
      );
      expect(rows).toHaveLength(1);
    });
  });

  // ───────────────────────── deactivated employee ─────────────────────────

  describe('a deactivated employee', () => {
    it('can still be approved for the months they worked (a rep who left may be owed a bonus)', async () => {
      const rep = await createRep('gone');
      await put(targetUrl(rep, MAY, 'new_clinics'), {
        targetValue: 1,
        bonusType: 'fixed_on_threshold',
        bonusThresholdPct: 100,
        bonusAmount: 50,
        reason: 'e2e',
      }).expect(200);
      await patch(`/platform/staff/${rep}/status`, { isActive: false }).expect(200);
      const res = await post(approveUrl(rep, MAY, 'new_clinics')).expect(201);
      // 0 of 1 clinics: the threshold was missed, so the decision is recorded with an amount of 0.
      expect(res.body).toMatchObject({ status: 'approved', amount: 0, achievedValue: 0 });
      expect(res.body.rule).toMatchObject({ thresholdMet: false });
    });
  });

  // ───────────────────────── team list ─────────────────────────

  describe('the team list projects each employee\'s bonus per currency', () => {
    it('sums what the rules would pay, without any extra query per employee', async () => {
      const res = (await get(`/platform/sales/employees?search=bon-A-${RUN}&period=${MAY}`).expect(200)).body;
      const row = res.data.find((e: { id: string }) => e.id === repA);
      // new_clinics 600 (corrected rule) + revenue 100 + conversions 300 (threshold now 50 %).
      expect(row.bonusPreview).toEqual([{ currency: 'SAR', amount: 1000 }]);
      const none = (await get(`/platform/sales/employees?search=bon-B-${RUN}&period=${MAY}`).expect(200)).body;
      expect(none.data[0].bonusPreview).toEqual([]);
    });
  });

  // ───────────────────────── measured: no N+1 ─────────────────────────

  describe('query count does not grow with the number of records', () => {
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

    it('bonuses list: same statement count for 1 record and for 15', async () => {
      const rep = await createRep('many');
      const statements = async (): Promise<number> => {
        count = 0;
        counting = true;
        try {
          await get(`/platform/sales/employees/${rep}/bonuses?limit=50`).expect(200);
        } finally {
          counting = false;
        }
        return count;
      };
      const seedRecord = async (period: string) => {
        await e2e.dataSource.query(
          `INSERT INTO sales_targets (sales_user_id, period_month, metric, target_value, currency, bonus_type, bonus_threshold_pct, bonus_amount, bonus_currency, version)
           VALUES ($1, $2::date, 'new_clinics', 1, NULL, 'fixed_on_threshold', 100, 10, 'SAR', 1)`,
          [rep, `${period}-01`],
        );
        await e2e.dataSource.query(
          `INSERT INTO sales_bonus_records
             (target_id, sales_user_id, period_month, metric, target_value, achieved_value, achievement_pct,
              rule_snapshot, bonus_amount, currency, status, computed_at, approved_by, approved_at)
           SELECT id, sales_user_id, period_month, metric, 1, 1, 100, '{}'::jsonb, 10, 'SAR', 'approved', now(), $3, now()
             FROM sales_targets WHERE sales_user_id = $1 AND period_month = $2::date`,
          [rep, `${period}-01`, admin.userId],
        );
      };
      await seedRecord('2018-01');
      await get(`/platform/sales/employees/${rep}/bonuses`); // warm
      const one = await statements();
      for (let m = 2; m <= 12; m++) await seedRecord(`2018-${String(m).padStart(2, '0')}`);
      for (let m = 1; m <= 4; m++) await seedRecord(`2017-${String(m).padStart(2, '0')}`);
      const many = await statements();
      console.log(`[query-count] bonuses: 1 record → ${one}, 15 records → ${many}`);
      expect(many).toBe(one);
    });
  });
});
