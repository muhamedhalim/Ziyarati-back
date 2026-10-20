/**
 * Monthly / per-branch dashboard targets against REAL Postgres.
 *
 * Opt-in: set `TARGETS_IT_DATABASE_URL` to a database that has had every
 * migration applied (`node dist/src/migrate.js run`). Without it the suite is
 * skipped, so the default unit run never needs a database. Every row it
 * creates is scoped to two throwaway tenants and removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { join } from 'node:path';

import { TenantTargetsService, addMonths } from './tenant-targets.service';
import { AnalyticsAggregationService } from '../analytics/analytics-aggregation.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import { currentMonthUtc } from '../analytics/analytics.constants';
import { ErrorCode } from '../../common/errors';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Branch } from '../../entities/SaaS-Core/Branch';
import {
  TenantTarget,
  TenantTargetType,
} from '../../entities/SaaS-Core/TenantTarget';
import { TenantTargetHistory } from '../../entities/SaaS-Core/TenantTargetHistory';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';
import { Payment } from '../../entities/Payments/Payment';
import { Customer } from '../../entities/CRM/Customer';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Conversation } from '../../entities/Conversations/Conversation';
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { User } from '../../entities/Auth&RBAC/User';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { AppointmentStatus, PaymentStatus } from '../../entities/enums';

const URL = process.env.TARGETS_IT_DATABASE_URL;
const d = URL ? describe : describe.skip;

const utc = (monthOffset: number, day: number, hour = 10) => {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + monthOffset, day, hour),
  );
};

d('TenantTargetsService — real Postgres', () => {
  let ds: DataSource;
  let svc: TenantTargetsService;
  let scope: BranchScopeService;
  const sfx = randomUUID().slice(0, 8);
  let tA: string;
  let tB: string;
  let bA1: string;
  let bA2: string;
  let bB1: string;
  let ownerId: string;
  const OWNER = () => ({
    id: ownerId,
    permissions: ['branches.update', 'branches.update_own'],
  });
  const RESTRICTED = () => ({
    id: ownerId,
    permissions: ['branches.update_own'],
  });
  const THIS = currentMonthUtc();
  const NEXT = addMonths(THIS, 1);

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: URL,
      entities: [
        join(__dirname, '..', '..', 'entities', '**', '!(*.spec).{ts,js}'),
      ],
      synchronize: false,
    });
    await ds.initialize();
    const r = <T extends object>(e: new () => T) => ds.getRepository(e);
    const agg = new AnalyticsAggregationService(
      r(Branch),
      r(Appointment),
      r(Payment),
      r(Customer),
      r(AiMessage),
      r(Conversation),
      r(CustomerReview),
      r(AppointmentServiceEntity),
      r(StaffProfile),
      r(AppointmentCancellation),
      r(TenantSetting),
    );
    scope = new BranchScopeService(
      r(BranchUser),
      {
        application: { get: async () => null, set: async () => 'OK' },
      } as never,
      {} as never,
    );
    svc = new TenantTargetsService(
      r(TenantTarget),
      r(TenantTargetHistory),
      r(TenantSetting),
      r(Branch),
      ds,
      scope,
      agg,
      {
        wrap: (_t: string, _n: string, _s: string, p: () => Promise<unknown>) =>
          p(),
      } as never,
    );

    const mkTenant = async (n: string) =>
      (
        await r(Tenant).save(
          r(Tenant).create({
            name: n,
            slug: `${n}-${sfx}`,
            contact_email: `${n}-${sfx}@t.test`,
          }),
        )
      ).id;
    tA = await mkTenant('ta');
    tB = await mkTenant('tb');
    await r(TenantSetting).save(
      r(TenantSetting).create({
        tenant: { id: tA } as Tenant,
        currency: 'SAR',
      }),
    );
    const mkBranch = async (t: string, n: string) =>
      (
        await r(Branch).save(
          r(Branch).create({
            tenant: { id: t } as Tenant,
            name: n,
            is_active: true,
            timezone: 'UTC',
          }),
        )
      ).id;
    bA1 = await mkBranch(tA, 'A1');
    bA2 = await mkBranch(tA, 'A2');
    bB1 = await mkBranch(tB, 'B1');
    const user = await r(User).save(
      r(User).create({
        tenant: { id: tA } as Tenant,
        email: `o-${sfx}@t.test`,
        full_name: 'Owner',
        is_active: true,
      }),
    );
    ownerId = user.id;
    const cust = await r(Customer).save(
      r(Customer).create({
        tenant: { id: tA } as Tenant,
        full_name: 'P',
        phone: '+1000',
        email: `p-${sfx}@t.test`,
      }),
    );
    const staff = await r(StaffProfile).save(
      r(StaffProfile).create({
        tenant: { id: tA } as Tenant,
        user: { id: user.id } as User,
        title: 'Dr',
        public_slug: `dr-${sfx}`,
        is_available_for_booking: true,
      }),
    );

    const appt = (branch: string, start: Date, status: AppointmentStatus) =>
      r(Appointment).save(
        r(Appointment).create({
          tenant: { id: tA } as Tenant,
          branch: { id: branch } as Branch,
          customer: { id: cust.id } as Customer,
          staff: { id: staff.id } as StaffProfile,
          start_at: start,
          end_at: new Date(start.getTime() + 1_800_000),
          status,
        }),
      );
    const pay = (branch: string, amount: number, paidAt: Date) =>
      r(Payment).save(
        r(Payment).create({
          tenant: { id: tA } as Tenant,
          branch: { id: branch } as Branch,
          amount,
          currency: 'SAR',
          status: PaymentStatus.PAID,
          paid_at: paidAt,
        }),
      );
    // A1: 2 completed + 1 cancelled this month, 1 completed last month; A2: 1 completed this month.
    await appt(bA1, utc(0, 3, 8), AppointmentStatus.COMPLETED);
    await appt(bA1, utc(0, 4, 8), AppointmentStatus.COMPLETED);
    await appt(bA1, utc(0, 5, 8), AppointmentStatus.CANCELLED);
    await appt(bA1, utc(-1, 3, 8), AppointmentStatus.COMPLETED);
    await appt(bA2, utc(0, 3, 9), AppointmentStatus.COMPLETED);
    await pay(bA1, 100.1, utc(0, 5));
    await pay(bA1, 200.2, utc(0, 6));
    await pay(bA2, 50, utc(0, 6));
    await pay(bA1, 75, utc(-1, 6));
  }, 60_000);

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    for (const t of [tA, tB].filter(Boolean)) {
      await ds
        .query(`DELETE FROM payments WHERE "tenantId"=$1`, [t])
        .catch(() => undefined);
      await ds
        .query(`DELETE FROM appointments WHERE "tenantId"=$1`, [t])
        .catch(() => undefined);
      await ds
        .query(`DELETE FROM staff_profiles WHERE "tenantId"=$1`, [t])
        .catch(() => undefined);
      await ds
        .query(`DELETE FROM customers WHERE "tenantId"=$1`, [t])
        .catch(() => undefined);
      await ds.query(`DELETE FROM tenant_target_history WHERE tenant_id=$1`, [
        t,
      ]);
      await ds.query(`DELETE FROM tenant_targets WHERE tenant_id=$1`, [t]);
      await ds
        .query(`DELETE FROM branches WHERE "tenantId"=$1`, [t])
        .catch(() => undefined);
      await ds
        .query(`DELETE FROM tenant_settings WHERE tenant_id=$1`, [t])
        .catch(() => undefined);
    }
    await ds
      .query(`DELETE FROM users WHERE id=$1`, [ownerId])
      .catch(() => undefined);
    for (const t of [tA, tB].filter(Boolean))
      await ds
        .query(`DELETE FROM tenants WHERE id=$1`, [t])
        .catch(() => undefined);
    await ds.destroy();
  });

  const ledger = (
    tenant: string,
    branch: string | null,
    type: TenantTargetType,
    month: string,
  ) =>
    ds.getRepository(TenantTargetHistory).find({
      where: {
        tenant_id: tenant,
        target_type: type,
        period_month: month,
        ...(branch ? { branch_id: branch } : {}),
      },
      order: { changed_at: 'ASC' },
    });

  it('no target: nulls, never 0% (and org scope is labelled)', async () => {
    const p = await svc.getProgress(tA, OWNER(), {});
    expect(p.appointments).toMatchObject({
      target: null,
      percentage: null,
      remaining: null,
      source: 'ORGANIZATION',
    });
    expect(p.period.month).toBe(THIS);
    expect(p.currency).toBe('SAR');
  });

  it('actuals are scoped by branch and month, and revenue is decimal-safe', async () => {
    const all = await svc.getProgress(tA, OWNER(), {});
    expect(all.appointments.current).toBe(3);
    expect(all.revenue.current).toBe(350.3);
    const a1 = await svc.getProgress(tA, OWNER(), { branchId: bA1 });
    expect(a1.appointments.current).toBe(2);
    expect(a1.revenue.current).toBe(300.3);
    expect(a1.branch).toEqual({ id: bA1, name: 'A1' });
    const a2 = await svc.getProgress(tA, OWNER(), { branchId: bA2 });
    expect(a2.appointments.current).toBe(1);
    const prev = await svc.getProgress(tA, OWNER(), {
      month: addMonths(THIS, -1),
      branchId: bA1,
    });
    expect(prev.appointments.current).toBe(1);
    expect(prev.revenue.current).toBe(75);
  });

  it('branch and clinic-wide targets are independent rows; all-branches never picks a branch target', async () => {
    await svc.setTargets(tA, OWNER(), {
      branchId: bA1,
      appointmentTarget: 4,
      revenueTarget: 1000,
    });
    const all = await svc.getProgress(tA, OWNER(), {});
    expect(all.appointments.target).toBeNull(); // org target not set; A1's target is NOT substituted
    const a1 = await svc.getProgress(tA, OWNER(), { branchId: bA1 });
    expect(a1.appointments).toMatchObject({
      target: 4,
      current: 2,
      percentage: 50,
      remaining: 2,
      source: 'BRANCH',
    });
    expect(a1.revenue).toMatchObject({
      target: 1000,
      current: 300.3,
      source: 'BRANCH',
    });
    const a2 = await svc.getProgress(tA, OWNER(), { branchId: bA2 });
    expect(a2.appointments.target).toBeNull();

    await svc.setTargets(tA, OWNER(), { appointmentTarget: 10 });
    const all2 = await svc.getProgress(tA, OWNER(), {});
    expect(all2.appointments).toMatchObject({
      target: 10,
      current: 3,
      percentage: 30,
      source: 'ORGANIZATION',
    });
  });

  it('first set is CREATED, change is UPDATED with the previous value, same value is a no-op', async () => {
    await svc.setTargets(tA, OWNER(), { branchId: bA1, appointmentTarget: 6 });
    await svc.setTargets(tA, OWNER(), { branchId: bA1, appointmentTarget: 6 });
    const rows = await ledger(tA, bA1, TenantTargetType.APPOINTMENTS, THIS);
    expect(rows.map((r) => r.change_type)).toEqual(['CREATED', 'UPDATED']);
    expect(Number(rows[1].previous_value)).toBe(4);
    expect(Number(rows[1].new_value)).toBe(6);
    expect(rows[1].actor_user_id).toBe(ownerId);
    const p = await svc.getProgress(tA, OWNER(), { branchId: bA1 });
    expect(p.appointments.originalTarget).toBe(4);
    expect(p.appointments.target).toBe(6);
  });

  it('editing one month never touches another month', async () => {
    await svc.setTargets(tA, OWNER(), {
      month: NEXT,
      branchId: bA1,
      appointmentTarget: 99,
    });
    const cur = await svc.getProgress(tA, OWNER(), { branchId: bA1 });
    expect(cur.appointments.target).toBe(6);
    const nxt = await svc.getProgress(tA, OWNER(), {
      month: NEXT,
      branchId: bA1,
    });
    expect(nxt.appointments).toMatchObject({ target: 99, current: 0 });
  });

  it('zero target is trivially met; zero is distinct from unset', async () => {
    await svc.setTargets(tA, OWNER(), { branchId: bA2, appointmentTarget: 0 });
    const p = await svc.getProgress(tA, OWNER(), { branchId: bA2 });
    expect(p.appointments).toMatchObject({ target: 0, isCompleted: true });
  });

  it('history: paged, scoped, with original vs latest and actuals; branch filter applied', async () => {
    const h = await svc.getHistory(tA, OWNER(), {
      type: TenantTargetType.APPOINTMENTS,
      branchId: bA1,
      limit: 1,
      page: 1,
    });
    expect(h.total).toBe(2);
    expect(h.data).toHaveLength(1);
    expect(h.data[0].month).toBe(NEXT); // newest first
    const h2 = await svc.getHistory(tA, OWNER(), {
      type: TenantTargetType.APPOINTMENTS,
      branchId: bA1,
      limit: 5,
    });
    const cur = h2.data.find((r) => r.month === THIS)!;
    expect(cur).toMatchObject({
      target: 6,
      originalTarget: 4,
      edited: true,
      actual: 2,
    });
    expect(cur.percentage).toBeCloseTo(33.33, 2);
    expect(cur.branch).toEqual({ id: bA1, name: 'A1' });
    const org = await svc.getHistory(tA, OWNER(), {
      type: TenantTargetType.APPOINTMENTS,
    });
    expect(org.data.every((r) => r.branch.id === null)).toBe(true);
    const changes = await svc.getChanges(tA, OWNER(), {
      type: TenantTargetType.APPOINTMENTS,
      month: THIS,
      branchId: bA1,
    });
    expect(changes.map((c) => c.changeType)).toEqual(['UPDATED', 'CREATED']);
  });

  it('cross-tenant branch ids are rejected as not found (read, write, history)', async () => {
    await expect(
      svc.getProgress(tA, OWNER(), { branchId: bB1 }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await expect(
      svc.setTargets(tA, OWNER(), { branchId: bB1, appointmentTarget: 1 }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await expect(
      svc.getHistory(tA, OWNER(), {
        type: TenantTargetType.REVENUE,
        branchId: bB1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(
      await ds.getRepository(TenantTarget).count({ where: { tenant_id: tB } }),
    ).toBe(0);
  });

  it('tenant B sees none of tenant A targets', async () => {
    const p = await svc.getProgress(tB, OWNER(), {});
    expect(p.appointments.target).toBeNull();
    expect(
      (
        await svc.getHistory(tB, OWNER(), {
          type: TenantTargetType.APPOINTMENTS,
        })
      ).total,
    ).toBe(0);
  });

  it('rejects past months, far-future months and malformed months', async () => {
    await expect(
      svc.setTargets(tA, OWNER(), {
        month: addMonths(THIS, -1),
        appointmentTarget: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    await expect(
      svc.setTargets(tA, OWNER(), {
        month: addMonths(THIS, 13),
        appointmentTarget: 1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    await expect(
      svc.getProgress(tA, OWNER(), { month: '2026-13' }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('duplicate scope is blocked by the database; concurrent first-writes end with one row', async () => {
    const before = await ds
      .getRepository(TenantTarget)
      .count({ where: { tenant_id: tA } });
    await expect(
      ds.query(
        `INSERT INTO tenant_targets (tenant_id,branch_id,target_type,period_month,value,original_value) VALUES ($1,$2,'APPOINTMENTS',$3,1,1)`,
        [tA, bA1, THIS],
      ),
    ).rejects.toThrow(/uq_tenant_targets_branch/);
    await expect(
      ds.query(
        `INSERT INTO tenant_targets (tenant_id,branch_id,target_type,period_month,value,original_value) VALUES ($1,NULL,'APPOINTMENTS',$2,1,1)`,
        [tA, THIS],
      ),
    ).rejects.toThrow(/uq_tenant_targets_org/);
    const m = addMonths(THIS, 3);
    const results = await Promise.allSettled([
      svc.setTargets(tA, OWNER(), {
        month: m,
        branchId: bA2,
        revenueTarget: 5,
      }),
      svc.setTargets(tA, OWNER(), {
        month: m,
        branchId: bA2,
        revenueTarget: 7,
      }),
    ]);
    expect(results.some((x) => x.status === 'fulfilled')).toBe(true);
    const rows = await ds
      .getRepository(TenantTarget)
      .find({ where: { tenant_id: tA, branch_id: bA2, period_month: m } });
    expect(rows).toHaveLength(1);
    const led = await ledger(tA, bA2, TenantTargetType.REVENUE, m);
    expect(led[0].change_type).toBe('CREATED');
    expect(Number(led[led.length - 1].new_value)).toBe(Number(rows[0].value)); // ledger agrees with the row
    expect(
      await ds.getRepository(TenantTarget).count({ where: { tenant_id: tA } }),
    ).toBe(before + 1);
  });

  it('a failure mid-transaction leaves neither a target nor a ledger row', async () => {
    const m = addMonths(THIS, 4);
    // appointmentTarget is fine; revenueTarget overflows numeric(14,2) -> the whole save rolls back.
    await expect(
      svc.setTargets(tA, OWNER(), {
        month: m,
        branchId: bA1,
        appointmentTarget: 3,
        revenueTarget: 1e15,
      }),
    ).rejects.toBeDefined();
    expect(
      await ds
        .getRepository(TenantTarget)
        .count({ where: { tenant_id: tA, period_month: m } }),
    ).toBe(0);
    expect(
      await ds
        .getRepository(TenantTargetHistory)
        .count({ where: { tenant_id: tA, period_month: m } }),
    ).toBe(0);
  });

  describe('branch-restricted caller', () => {
    it('is refused a branch outside its scope (403) and cannot widen via a foreign id', async () => {
      jest.spyOn(scope, 'getMembershipBranchIds').mockResolvedValue([bA1]);
      await expect(
        svc.getProgress(tA, RESTRICTED(), { branchId: bA2 }),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
      await expect(
        svc.setTargets(tA, RESTRICTED(), {
          branchId: bA2,
          appointmentTarget: 1,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
    });

    it('all-branches = sum of ITS branches only when every one has a target, else unavailable', async () => {
      jest.spyOn(scope, 'getMembershipBranchIds').mockResolvedValue([bA1, bA2]);
      // A1=6, A2=0 this month -> both present
      const ok = await svc.getProgress(tA, RESTRICTED(), {});
      expect(ok.appointments).toMatchObject({
        target: 6,
        source: 'BRANCH_SUM',
        current: 3,
      });
      // Revenue: A1 has 1000, A2 has none for THIS month -> incomplete
      const rev = await svc.getProgress(tA, RESTRICTED(), {});
      expect(rev.revenue).toMatchObject({
        target: null,
        unavailableReason: 'BRANCH_TARGETS_INCOMPLETE',
        current: 350.3,
      });
      // Restricted history never shows the clinic-wide rows.
      const h = await svc.getHistory(tA, RESTRICTED(), {
        type: TenantTargetType.APPOINTMENTS,
      });
      expect(h.data.every((r) => r.branch.id !== null)).toBe(true);
    });

    it('assigned to no branch -> sees nothing, never widened', async () => {
      jest.spyOn(scope, 'getMembershipBranchIds').mockResolvedValue([]);
      const p = await svc.getProgress(tA, RESTRICTED(), {});
      expect(p.appointments).toMatchObject({ target: null, current: 0 });
      expect(
        (
          await svc.getHistory(tA, RESTRICTED(), {
            type: TenantTargetType.APPOINTMENTS,
          })
        ).total,
      ).toBe(0);
    });
  });
});
