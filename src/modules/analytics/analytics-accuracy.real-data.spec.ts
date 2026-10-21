/**
 * Real-Postgres accuracy audit of the `/app/analytics` figures (2026-10-21).
 *
 * Every expected value is computed by plain TypeScript from the fixture
 * arrays below (`PAYMENTS`, `APPOINTMENTS`) — an INDEPENDENT ORACLE that never
 * reads back through the SQL under test. Covers the scenarios the audit
 * required: empty tenant, small tenant, period boundaries, UTC vs clinic-local
 * time, every appointment outcome, every payment status (incl. partial and
 * full refunds, pending, failed, platform-owned), a second currency,
 * branchless payments, a second tenant with overlapping data, a
 * branch-restricted caller, and pagination over many rows.
 *
 * Creates its own throwaway tenants (year 2032) and deletes them in
 * `afterAll`. Requires the dev Postgres (`SeedDataSource`).
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { SeedDataSource } from '../../seed/data-source';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { dayRangeInZone } from './analytics.constants';
import { PERMISSION } from '../../rbac/rbac.constants';
import { ErrorCode } from '../../common/errors';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { User } from '../../entities/Auth&RBAC/User';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Customer } from '../../entities/CRM/Customer';
import { CustomerReview } from '../../entities/CRM/CustomerReview';
import { Service } from '../../entities/Services/Service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';
import { Payment } from '../../entities/Payments/Payment';
import { AiMessage } from '../../entities/AI Agent/AiMessage';
import { Conversation } from '../../entities/Conversations/Conversation';
import {
  AppointmentActionOrigin,
  AppointmentPaymentStatus,
  AppointmentSource,
  AppointmentStatus,
  PaymentStatus,
  TenantApprovalStatus,
} from '../../entities/enums';

type BranchTag = 'BR1' | 'BR2';

interface ApptFixture {
  tag: string;
  branch: BranchTag;
  /** UTC instant. */
  start: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  /** Cancellation record origin; omitted = cancelled with NO record. */
  cancelledBy?: AppointmentActionOrigin;
  price: number;
}

interface PayFixture {
  amount: number;
  refunded: number;
  status: PaymentStatus;
  currency: string;
  purpose: 'BOOKING' | 'MANUAL' | 'ADDON';
  paidAt: string | null;
  /** Payment's own branch column. */
  branch?: BranchTag;
  /** Appointment it pays for (by fixture tag). */
  appt?: string;
}

const RANGE = { from: '2032-03-01', to: '2032-03-07' };

/**
 * Appointments for the main tenant. Times are UTC instants; both branches run
 * in Asia/Riyadh (UTC+3, no DST), so report days are RIYADH calendar days and
 * the range [1 Mar, 7 Mar] is [2032-02-29T21:00Z, 2032-03-07T20:59:59.999Z].
 * `late-local` (01:00 on 8 March in Riyadh = 22:00Z on 7 March) falls OUTSIDE
 * the range; `early-local` (02:00 on 2 March in Riyadh = 23:00Z on 1 March)
 * counts on 2 March, not 1 March.
 */
const APPOINTMENTS: ApptFixture[] = [
  {
    tag: 'first-instant',
    branch: 'BR1',
    start: '2032-02-29T21:00:00.000Z', // 00:00 Riyadh, 1 March
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.MANUAL,
    price: 100,
  },
  {
    tag: 'c-done',
    branch: 'BR1',
    start: '2032-03-02T09:00:00.000Z',
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.WHATSAPP_BOT,
    price: 200,
  },
  {
    tag: 'c-cancel-patient',
    branch: 'BR1',
    start: '2032-03-02T10:00:00.000Z',
    status: AppointmentStatus.CANCELLED,
    source: AppointmentSource.MANUAL,
    cancelledBy: AppointmentActionOrigin.PATIENT,
    price: 150,
  },
  {
    tag: 'c-cancel-clinic',
    branch: 'BR2',
    start: '2032-03-03T10:00:00.000Z',
    status: AppointmentStatus.CANCELLED,
    source: AppointmentSource.PUBLIC_AI,
    cancelledBy: AppointmentActionOrigin.STAFF,
    price: 150,
  },
  {
    tag: 'c-cancel-unknown',
    branch: 'BR2',
    start: '2032-03-03T11:00:00.000Z',
    status: AppointmentStatus.CANCELLED,
    source: AppointmentSource.MANUAL,
    price: 150,
  },
  {
    tag: 'c-noshow',
    branch: 'BR2',
    start: '2032-03-04T09:00:00.000Z',
    status: AppointmentStatus.NO_SHOW,
    source: AppointmentSource.MANUAL,
    price: 300,
  },
  {
    tag: 'c-open',
    branch: 'BR2',
    start: '2032-03-05T09:00:00.000Z',
    status: AppointmentStatus.CONFIRMED,
    source: AppointmentSource.WHATSAPP_BOT,
    price: 120,
  },
  {
    tag: 'early-local',
    branch: 'BR2',
    start: '2032-03-01T23:00:00.000Z', // 02:00 Riyadh, 2 March
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.MANUAL,
    price: 60,
  },
  {
    tag: 'late-local',
    branch: 'BR1',
    start: '2032-03-07T22:00:00.000Z',
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.MANUAL,
    price: 80,
  },
  {
    tag: 'last-instant',
    branch: 'BR2',
    start: '2032-03-07T20:59:59.999Z', // 23:59:59.999 Riyadh, 7 March
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.MANUAL,
    price: 90,
  },
  // Outside the range on both sides.
  {
    tag: 'before',
    branch: 'BR1',
    start: '2032-02-29T20:40:00.000Z', // 23:40 Riyadh, 29 February
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.MANUAL,
    price: 500,
  },
  {
    tag: 'after',
    branch: 'BR1',
    start: '2032-03-07T21:30:00.000Z', // 00:30 Riyadh, 8 March
    status: AppointmentStatus.COMPLETED,
    source: AppointmentSource.MANUAL,
    price: 500,
  },
];

/** Payments for the main tenant — settings currency is USD, every booking is SAR. */
const PAYMENTS: PayFixture[] = [
  {
    amount: 100,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: '2032-02-29T21:00:00.000Z', // 00:00 Riyadh, 1 March
    branch: 'BR1',
    appt: 'first-instant',
  },
  // No branch of its own — belongs to its appointment's branch (BR1).
  {
    amount: 200,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: '2032-03-02T09:30:00.000Z',
    appt: 'c-done',
  },
  // Partial refund: counts 300 − 120 = 180 (previously dropped entirely).
  {
    amount: 300,
    refunded: 120,
    status: PaymentStatus.PARTIALLY_REFUNDED,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: '2032-03-04T09:00:00.000Z',
    branch: 'BR2',
    appt: 'c-noshow',
  },
  // Full refund: counts 0.
  {
    amount: 150,
    refunded: 150,
    status: PaymentStatus.REFUNDED,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: '2032-03-02T10:00:00.000Z',
    branch: 'BR1',
    appt: 'c-cancel-patient',
  },
  // Never collected.
  {
    amount: 120,
    refunded: 0,
    status: PaymentStatus.PENDING,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: null,
    branch: 'BR2',
    appt: 'c-open',
  },
  {
    amount: 400,
    refunded: 0,
    status: PaymentStatus.FAILED,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: null,
    branch: 'BR2',
  },
  // Manual payment with no branch and no booking: in totals, in no branch/channel row.
  {
    amount: 70,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'SAR',
    purpose: 'MANUAL',
    paidAt: '2032-03-06T12:00:00.000Z',
  },
  // Platform money (clinic is the payer) — never clinic revenue.
  {
    amount: 999,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'SAR',
    purpose: 'ADDON',
    paidAt: '2032-03-03T12:00:00.000Z',
  },
  // Paid on the last instant of the range.
  {
    amount: 90,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: '2032-03-07T20:59:59.999Z', // last Riyadh instant of 7 March
    branch: 'BR2',
    appt: 'last-instant',
  },
  // Outside the range (counts only in the all-time KPI).
  {
    amount: 500,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'SAR',
    purpose: 'BOOKING',
    paidAt: '2032-03-07T21:00:00.000Z', // 00:00 Riyadh, 8 March
    branch: 'BR1',
    appt: 'after',
  },
  // A different currency — never summed into SAR.
  {
    amount: 40,
    refunded: 0,
    status: PaymentStatus.PAID,
    currency: 'EUR',
    purpose: 'BOOKING',
    paidAt: '2032-03-05T10:00:00.000Z',
    branch: 'BR1',
  },
];

// ───────────────────────────── The oracle ────────────────────────────── //

const COLLECTED = new Set<PaymentStatus>([
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
]);
const net = (p: PayFixture) => Math.max(p.amount - p.refunded, 0);
const isClinicRevenue = (p: PayFixture, currency: string) =>
  COLLECTED.has(p.status) && p.purpose !== 'ADDON' && p.currency === currency;
/** Riyadh calendar day of an instant — fixed +3h, independent of the service's zone code. */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
const riyadhDay = (iso: string) =>
  new Date(Date.parse(iso) + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
const inRange = (iso: string | null) =>
  iso !== null && riyadhDay(iso) >= RANGE.from && riyadhDay(iso) <= RANGE.to;
const apptByTag = new Map(APPOINTMENTS.map((a) => [a.tag, a]));
const branchOf = (p: PayFixture): BranchTag | undefined =>
  p.branch ?? (p.appt ? apptByTag.get(p.appt)?.branch : undefined);
const sum = (xs: number[]) =>
  Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

const rangedRevenue = (pred: (p: PayFixture) => boolean = () => true) =>
  sum(
    PAYMENTS.filter(
      (p) => isClinicRevenue(p, 'SAR') && inRange(p.paidAt) && pred(p),
    ).map(net),
  );
const inRangeAppts = APPOINTMENTS.filter((a) => inRange(a.start));
const countStatus = (s: AppointmentStatus) =>
  inRangeAppts.filter((a) => a.status === s).length;

describe('Analytics accuracy — figures vs an independent oracle over real Postgres', () => {
  let ds: DataSource;
  let agg: AnalyticsAggregationService;
  let advanced: AdvancedAnalyticsService;

  const ids: Record<string, string> = {};
  const tenants: string[] = [];
  let tenantId: string;
  let otherTenantId: string;
  let emptyTenantId: string;
  let eurTenantId: string;

  const OWNER = {
    id: 'owner',
    tenantId: '',
    roles: [],
    permissions: [
      PERMISSION.ANALYTICS_DASHBOARD_READ,
      PERMISSION.ANALYTICS_REPORTS_READ,
    ],
  } as unknown as AuthenticatedUser;
  let restricted: AuthenticatedUser;

  beforeAll(async () => {
    ds = await SeedDataSource.initialize();
    const suffix = randomUUID().slice(0, 8);
    const r = <T extends object>(e: new () => T) => ds.getRepository(e);

    const mkTenant = async (tag: string, currency: string | null) => {
      const t = await r(Tenant).save(
        r(Tenant).create({
          name: `Analytics Accuracy ${tag} ${suffix}`,
          slug: `an-acc-${tag}-${suffix}`,
          contact_email: `an-acc-${tag}-${suffix}@example.test`,
          approval_status: TenantApprovalStatus.APPROVED,
          is_active: true,
        }),
      );
      tenants.push(t.id);
      if (currency) {
        await r(TenantSetting).save(
          r(TenantSetting).create({ tenant: { id: t.id } as Tenant, currency }),
        );
      }
      return t.id;
    };
    tenantId = await mkTenant('main', 'USD'); // settings say USD, every booking is SAR
    otherTenantId = await mkTenant('other', 'SAR');
    emptyTenantId = await mkTenant('empty', null);
    eurTenantId = await mkTenant('eur', 'SAR');
    (OWNER as { tenantId: string }).tenantId = tenantId;

    const mkBranch = async (t: string, name: string) =>
      (
        await r(Branch).save(
          r(Branch).create({
            tenant: { id: t } as Tenant,
            name,
            timezone: 'Asia/Riyadh',
          }),
        )
      ).id;
    ids.BR1 = await mkBranch(tenantId, 'Accuracy Branch 1');
    ids.BR2 = await mkBranch(tenantId, 'Accuracy Branch 2');
    ids.otherBranch = await mkBranch(otherTenantId, 'Other Tenant Branch');

    const mkUser = async (t: string, tag: string) =>
      r(User).save(
        r(User).create({
          tenant: { id: t } as Tenant,
          email: `an-acc-${tag}-${suffix}@example.test`.toLowerCase(),
          full_name: `Dr. ${tag}`,
          is_active: true,
        }),
      );
    const mkStaff = async (t: string, tag: string) => {
      const user = await mkUser(t, tag);
      return (
        await r(StaffProfile).save(
          r(StaffProfile).create({
            user: { id: user.id } as User,
            tenant: { id: t } as Tenant,
            public_slug: `an-acc-${tag}-${suffix}`,
          }),
        )
      ).id;
    };
    ids.staff = await mkStaff(tenantId, 'staff');
    ids.otherStaff = await mkStaff(otherTenantId, 'otherstaff');

    // A branch-restricted manager (no tenant-wide permission), assigned to BR2 only.
    const manager = await mkUser(tenantId, 'br2-manager');
    await ds.query(
      `INSERT INTO branch_users ("tenantId", "branchId", "userId") VALUES ($1, $2, $3)`,
      [tenantId, ids.BR2, manager.id],
    );
    restricted = {
      id: manager.id,
      tenantId,
      roles: [],
      permissions: [PERMISSION.ANALYTICS_REPORTS_READ],
    } as unknown as AuthenticatedUser;

    const mkCustomer = async (t: string, tag: string) =>
      (
        await r(Customer).save(
          r(Customer).create({
            tenant: { id: t } as Tenant,
            full_name: `Patient ${tag}`,
            phone: `+96650${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
            email: `an-acc-p-${tag}-${suffix}@example.test`,
          }),
        )
      ).id;
    ids.customer = await mkCustomer(tenantId, 'main');
    ids.otherCustomer = await mkCustomer(otherTenantId, 'other');

    // 25 services so the paginated service table has 3 pages of 10.
    const services: string[] = [];
    for (let i = 0; i < 25; i++) {
      services.push(
        (
          await r(Service).save(
            r(Service).create({
              tenant: { id: tenantId } as Tenant,
              name: `Svc ${String(i).padStart(2, '0')}`,
              public_slug: `an-acc-svc-${i}-${suffix}`,
              duration_minutes: 30,
            }),
          )
        ).id,
      );
    }

    const saveAppt = async (
      t: string,
      branchId: string,
      staffId: string,
      customerId: string,
      start: Date,
      status: AppointmentStatus,
      source: AppointmentSource,
    ) =>
      r(Appointment).save(
        r(Appointment).create({
          tenant: { id: t } as Tenant,
          branch: { id: branchId } as Branch,
          customer: { id: customerId } as Customer,
          staff: { id: staffId } as StaffProfile,
          start_at: start,
          end_at: new Date(start.getTime() + 15 * 60_000),
          status,
          payment_status: AppointmentPaymentStatus.UNPAID,
          currency: 'SAR',
          source,
        }),
      );

    for (const a of APPOINTMENTS) {
      const appt = await saveAppt(
        tenantId,
        ids[a.branch],
        ids.staff,
        ids.customer,
        new Date(a.start),
        a.status,
        a.source,
      );
      ids[`appt:${a.tag}`] = appt.id;
      await r(AppointmentServiceEntity).save(
        r(AppointmentServiceEntity).create({
          tenant: { id: tenantId } as Tenant,
          appointment: { id: appt.id } as Appointment,
          service: { id: services[0] } as Service,
          price: a.price,
          duration_minutes: 15,
        }),
      );
      if (a.cancelledBy) {
        await r(AppointmentCancellation).save(
          r(AppointmentCancellation).create({
            tenant: { id: tenantId } as Tenant,
            appointment: { id: appt.id } as Appointment,
            origin: a.cancelledBy,
          }),
        );
      }
    }
    // One line item for each of the other 24 services on the completed `c-done` booking.
    for (let i = 1; i < 25; i++) {
      await r(AppointmentServiceEntity).save(
        r(AppointmentServiceEntity).create({
          tenant: { id: tenantId } as Tenant,
          appointment: { id: ids['appt:c-done'] } as Appointment,
          service: { id: services[i] } as Service,
          price: 10,
          duration_minutes: 5,
        }),
      );
    }

    const savePayment = (
      t: string,
      p: PayFixture,
      branchId?: string,
      apptId?: string,
    ) =>
      r(Payment).save(
        r(Payment).create({
          tenant: { id: t } as Tenant,
          branch: branchId ? ({ id: branchId } as Branch) : undefined,
          appointment: apptId ? ({ id: apptId } as Appointment) : undefined,
          amount: p.amount,
          refunded_amount: p.refunded,
          status: p.status,
          currency: p.currency,
          purpose: p.purpose,
          paid_at: p.paidAt ? new Date(p.paidAt) : undefined,
        }),
      );
    for (const p of PAYMENTS) {
      await savePayment(
        tenantId,
        p,
        p.branch ? ids[p.branch] : undefined,
        p.appt ? ids[`appt:${p.appt}`] : undefined,
      );
    }

    // The OTHER tenant: heavy activity on the very same days — must never leak.
    for (let d = 1; d <= 7; d++) {
      const start = new Date(`2032-03-0${d}T12:00:00.000Z`);
      const appt = await saveAppt(
        otherTenantId,
        ids.otherBranch,
        ids.otherStaff,
        ids.otherCustomer,
        start,
        AppointmentStatus.COMPLETED,
        AppointmentSource.MANUAL,
      );
      await savePayment(
        otherTenantId,
        {
          amount: 10_000,
          refunded: 0,
          status: PaymentStatus.PAID,
          currency: 'SAR',
          purpose: 'BOOKING',
          paidAt: start.toISOString(),
        },
        ids.otherBranch,
        appt.id,
      );
    }

    // EUR-collecting tenant whose settings say SAR: SAR is configured but never collected.
    await savePayment(eurTenantId, {
      amount: 55,
      refunded: 0,
      status: PaymentStatus.PAID,
      currency: 'EUR',
      purpose: 'BOOKING',
      paidAt: '2032-03-02T10:00:00.000Z',
    });
    await savePayment(eurTenantId, {
      amount: 45,
      refunded: 0,
      status: PaymentStatus.PAID,
      currency: 'EUR',
      purpose: 'BOOKING',
      paidAt: '2032-03-03T10:00:00.000Z',
    });

    agg = new AnalyticsAggregationService(
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
    const branchScope = {
      getMembershipBranchIds: async (t: string, userId: string) =>
        (
          await ds.query(
            `SELECT "branchId" AS id FROM branch_users WHERE "tenantId" = $1 AND "userId" = $2 ORDER BY "branchId"`,
            [t, userId],
          )
        ).map((x: { id: string }) => x.id),
    };
    advanced = new AdvancedAnalyticsService(
      agg,
      branchScope as never,
      r(TenantSetting),
      {
        wrap: (
          _t: string,
          _n: string,
          _k: string,
          producer: () => Promise<unknown>,
        ) => producer(),
      } as never,
    );
  }, 180_000);

  afterAll(async () => {
    for (const tid of tenants) {
      for (const table of [
        'payments',
        'appointment_cancellations',
        'appointment_services',
        'appointments',
        'services',
        'branch_users',
        'customers',
        'staff_profiles',
        'users',
        'branches',
      ]) {
        await ds.query(`DELETE FROM ${table} WHERE "tenantId" = $1`, [tid]);
      }
      await ds.query(`DELETE FROM tenant_settings WHERE "tenant_id" = $1`, [
        tid,
      ]);
      await ds.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
    }
    await ds.destroy();
  }, 60_000);

  // ───────────────────────────── Currency ─────────────────────────────── //

  it('reports in the currency the clinic actually collects, not a never-used configured default', async () => {
    await expect(agg.resolveReportingCurrency(tenantId)).resolves.toEqual({
      currency: 'SAR',
      configuredCurrency: 'USD',
    });
    // Configured currency is honoured when it has collected payments.
    await expect(agg.resolveReportingCurrency(otherTenantId)).resolves.toEqual({
      currency: 'SAR',
      configuredCurrency: 'SAR',
    });
    // Configured currency never collected → the one that was.
    await expect(agg.resolveReportingCurrency(eurTenantId)).resolves.toEqual({
      currency: 'EUR',
      configuredCurrency: 'SAR',
    });
    // No payments and no settings row → the settings column default (SAR
    // since migration 1730123000000, matching what bookings are charged in).
    await expect(agg.resolveReportingCurrency(emptyTenantId)).resolves.toEqual({
      currency: 'SAR',
      configuredCurrency: 'SAR',
    });
  });

  // ───────────────────────────── Revenue ──────────────────────────────── //

  it('revenue trend = net collected SAR per clinic-local (Riyadh) day (partial refund netted, full refund 0, pending/failed/platform excluded)', async () => {
    const out = await advanced.revenueTrend(tenantId, OWNER, RANGE);
    if (out.empty) throw new Error('expected data');
    expect(out.currency).toBe('SAR');
    const byDay = Object.fromEntries(out.data.map((d) => [d.date, d.revenue]));
    expect(byDay['2032-03-01']).toBe(100); // first instant of the range
    expect(byDay['2032-03-02']).toBe(200); // full refund adds 0
    expect(byDay['2032-03-03']).toBe(0); // only platform ADDON money that day
    expect(byDay['2032-03-04']).toBe(180); // 300 − 120
    expect(byDay['2032-03-06']).toBe(70);
    expect(byDay['2032-03-07']).toBe(90); // last instant of the range
    expect(sum(out.data.map((d) => d.revenue))).toBe(rangedRevenue());
    expect(rangedRevenue()).toBe(640);
    // The EUR payment is surfaced, never summed in.
    expect(out.excludedOtherCurrency).toEqual({ count: 1, amount: 40 });
  });

  it('branch table rows + unattributed revenue add up to the trend total; branchless payments follow their appointment', async () => {
    const out = await advanced.performanceBranches(tenantId, OWNER, {
      ...RANGE,
      page: 1,
      limit: 10,
    });
    if (out.empty) throw new Error('expected data');
    const row = (id: string) => out.data.find((b) => b.branchId === id);
    expect(row(ids.BR1)?.revenue).toBe(
      rangedRevenue((p) => branchOf(p) === 'BR1'),
    );
    expect(row(ids.BR1)?.revenue).toBe(300); // 100 + 200 (via its appointment)
    expect(row(ids.BR2)?.revenue).toBe(
      rangedRevenue((p) => branchOf(p) === 'BR2'),
    );
    expect(out.unattributedRevenue).toBe(
      rangedRevenue((p) => branchOf(p) === undefined),
    );
    expect(sum(out.data.map((b) => b.revenue)) + out.unattributedRevenue).toBe(
      rangedRevenue(),
    );
    expect(row(ids.BR1)?.appointments).toBe(
      inRangeAppts.filter((a) => a.branch === 'BR1').length,
    );
    // The other tenant's branch never appears.
    expect(out.data.some((b) => b.branchId === ids.otherBranch)).toBe(false);
  });

  it('channel table rows + unattributed revenue add up to the trend total', async () => {
    const out = await advanced.performanceChannels(tenantId, OWNER, {
      ...RANGE,
      page: 1,
      limit: 10,
    });
    if (out.empty) throw new Error('expected data');
    const sourceOf = (p: PayFixture) =>
      p.appt ? apptByTag.get(p.appt)?.source : undefined;
    for (const row of out.data) {
      expect(row.revenue).toBe(
        rangedRevenue((p) => sourceOf(p) === row.source),
      );
      expect(row.appointments).toBe(
        inRangeAppts.filter((a) => a.source === row.source).length,
      );
    }
    expect(sum(out.data.map((c) => c.revenue)) + out.unattributedRevenue).toBe(
      rangedRevenue(),
    );
  });

  it('daily report revenue for one branch/day uses the same rule (branchless payment attributed via its appointment)', async () => {
    const day = await agg.computeDailyMetrics(tenantId, ids.BR1, '2032-03-02');
    expect(day.total_revenue).toBe(200);
    expect(day.total_appointments).toBe(2);
    expect(day.completed_appointments).toBe(1);
    expect(day.cancelled_appointments).toBe(1);
    // 02:00 Riyadh on 2 March (23:00Z on 1 March) is BR2's 2 March, not 1 March.
    expect(
      (await agg.computeDailyMetrics(tenantId, ids.BR2, '2032-03-02'))
        .total_appointments,
    ).toBe(1);
    expect(
      (await agg.computeDailyMetrics(tenantId, ids.BR2, '2032-03-01'))
        .total_appointments,
    ).toBe(0);
    const br2 = await agg.computeDailyMetrics(tenantId, ids.BR2, '2032-03-04');
    expect(br2.total_revenue).toBe(180);
    expect(br2.no_show_appointments).toBe(1);
  });

  it('dashboard all-time KPIs: revenue in SAR incl. out-of-range money, no platform/pending/failed/other-currency', async () => {
    const kpis = Object.fromEntries(
      (await agg.computeDashboardKpis(tenantId)).map((k) => [
        k.metric_key,
        k.metric_value,
      ]),
    );
    const allTime = sum(
      PAYMENTS.filter((p) => isClinicRevenue(p, 'SAR')).map(net),
    );
    expect(kpis.total_revenue).toBe(allTime);
    expect(kpis.total_revenue).toBe(1140); // 640 in range + 500 on 8 March
    expect(kpis.total_paid_payments).toBe(
      PAYMENTS.filter((p) => COLLECTED.has(p.status) && p.purpose !== 'ADDON')
        .length,
    );
    expect(kpis.total_appointments).toBe(APPOINTMENTS.length);
    expect(kpis.total_no_shows).toBe(
      APPOINTMENTS.filter((a) => a.status === AppointmentStatus.NO_SHOW).length,
    );
    expect(
      kpis.bookings_manual +
        kpis.bookings_whatsapp_bot +
        kpis.bookings_public_ai +
        kpis.bookings_platform,
    ).toBe(APPOINTMENTS.length);
  });

  it('staff revenue is net collected SAR via the staffed appointment', async () => {
    const [row] = await agg.computeStaffPerformance(tenantId, RANGE);
    expect(row.total_appointments).toBe(inRangeAppts.length);
    expect(row.revenue).toBe(rangedRevenue((p) => p.appt !== undefined));
  });

  // ─────────────────────── Appointments & rates ───────────────────────── //

  it('appointment trend counts every status per clinic-local (Riyadh) day, inclusive of both range edges', async () => {
    const out = await advanced.appointmentsTrend(tenantId, OWNER, RANGE);
    if (out.empty) throw new Error('expected data');
    expect(sum(out.data.map((d) => d.total))).toBe(inRangeAppts.length);
    expect(sum(out.data.map((d) => d.completed))).toBe(
      countStatus(AppointmentStatus.COMPLETED),
    );
    expect(out.timezone).toBe('Asia/Riyadh');
    const day = (d: string) => out.data.find((x) => x.date === d)?.total;
    // 01:00 Riyadh on 8 March (22:00Z on 7 March) is NOT in the range.
    expect(day('2032-03-07')).toBe(1);
    // 02:00 Riyadh on 2 March (23:00Z on 1 March) counts on 2 March.
    expect(day('2032-03-01')).toBe(1);
    expect(day('2032-03-02')).toBe(3);
  });

  it('rates: exact ratios, cancellation split adds up, open appointments make the denominator explicit', async () => {
    const out = await advanced.rates(tenantId, OWNER, RANGE);
    if (out.empty || !('totalAppointments' in out))
      throw new Error('expected data');
    const total = inRangeAppts.length;
    expect(out.totalAppointments).toBe(total);
    expect(out.completionRate).toBeCloseTo(
      countStatus(AppointmentStatus.COMPLETED) / total,
      4,
    );
    expect(out.cancellationRate).toBeCloseTo(
      countStatus(AppointmentStatus.CANCELLED) / total,
      4,
    );
    expect(out.noShowRate).toBeCloseTo(
      countStatus(AppointmentStatus.NO_SHOW) / total,
      4,
    );
    expect(out.cancellationByPatient).toBe(1);
    expect(out.cancellationByClinic).toBe(1);
    expect(out.cancellationUnattributed).toBe(1);
    expect(
      out.cancellationByPatient +
        out.cancellationByClinic +
        out.cancellationUnattributed,
    ).toBe(countStatus(AppointmentStatus.CANCELLED));
    expect(out.openAppointments).toBe(1);
    expect(
      Math.round(
        (out.completionRate +
          out.cancellationRate +
          out.noShowRate +
          out.openAppointments / total) *
          1000,
      ) / 1000,
    ).toBe(1);
  });

  // ─────────────────────── Pagination & scoping ───────────────────────── //

  it('service performance paginates without losing or duplicating rows', async () => {
    const pages = await Promise.all(
      [1, 2, 3].map((page) =>
        advanced.performanceServices(tenantId, OWNER, {
          ...RANGE,
          page,
          limit: 10,
        }),
      ),
    );
    const rows = pages.flatMap((p) => p.data);
    expect(pages[0].total).toBe(25);
    expect(pages.map((p) => p.data.length)).toEqual([10, 10, 5]);
    expect(new Set(rows.map((r) => r.serviceId)).size).toBe(25);
    // Booked line-item value, any outcome (documented): 9 in-range bookings on Svc 00.
    const svc0 = rows.find((r) => r.name === 'Svc 00');
    expect(svc0?.appointments).toBe(inRangeAppts.length);
    expect(svc0?.revenue).toBe(sum(inRangeAppts.map((a) => a.price)));
  });

  it('a branch-restricted caller is pinned to their own branch and refused any other', async () => {
    const out = await advanced.revenueTrend(tenantId, restricted, RANGE);
    expect(out.scope.branchId).toBe(ids.BR2);
    if (out.empty) throw new Error('expected data');
    expect(sum(out.data.map((d) => d.revenue))).toBe(
      rangedRevenue((p) => branchOf(p) === 'BR2'),
    );
    await expect(
      advanced.revenueTrend(tenantId, restricted, {
        ...RANGE,
        branchId: ids.BR1,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
  });

  it('daily/monthly/staff reports are branch-scoped the same way (FR-A016)', async () => {
    // List endpoints: a restricted caller's request is narrowed to BR2.
    const scope = await advanced.resolveScope(tenantId, restricted, undefined);
    expect(scope.branchId).toBe(ids.BR2);
    const [row] = await agg.computeStaffPerformance(tenantId, {
      ...RANGE,
      branchId: scope.branchId,
    });
    expect(row.total_appointments).toBe(
      inRangeAppts.filter((a) => a.branch === 'BR2').length,
    );
    // Single-report reads: another branch's report is NOT_FOUND, own branch ok.
    await expect(
      advanced.assertBranchVisible(tenantId, restricted, ids.BR1),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    await expect(
      advanced.assertBranchVisible(tenantId, restricted, ids.BR2),
    ).resolves.toBeUndefined();
    await expect(
      advanced.assertBranchVisible(tenantId, OWNER, ids.BR1),
    ).resolves.toBeUndefined();
  });

  it("another tenant's branch id is refused, never silently answered", async () => {
    await expect(
      advanced.appointmentsTrend(tenantId, OWNER, {
        ...RANGE,
        branchId: ids.otherBranch,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  // ──────────────────────────── Empty tenant ──────────────────────────── //

  it('an empty clinic gets `empty`, never fabricated zero rates, and all-zero KPIs', async () => {
    const owner = { ...OWNER, tenantId: emptyTenantId } as AuthenticatedUser;
    expect(
      (await advanced.appointmentsTrend(emptyTenantId, owner, RANGE)).empty,
    ).toBe(true);
    expect(
      (await advanced.revenueTrend(emptyTenantId, owner, RANGE)).empty,
    ).toBe(true);
    expect((await advanced.rates(emptyTenantId, owner, RANGE)).empty).toBe(
      true,
    );
    expect((await advanced.retention(emptyTenantId, owner, RANGE)).empty).toBe(
      true,
    );
    expect(
      (
        await advanced.performanceChannels(emptyTenantId, owner, {
          ...RANGE,
          page: 1,
          limit: 10,
        })
      ).empty,
    ).toBe(true);
    const kpis = await agg.computeDashboardKpis(emptyTenantId);
    expect(kpis.every((k) => k.metric_value === 0)).toBe(true);
  });

  it('reporting timezone: majority branch zone, else the clinic default, else UTC', async () => {
    expect(await agg.resolveReportingTimezone(tenantId)).toBe('Asia/Riyadh');
    // No branches at all → the tenant's own default_timezone (column default UTC).
    expect(await agg.resolveReportingTimezone(eurTenantId)).toBe('UTC');
  });

  it('sanity: the range bounds the oracle uses are the ones the service uses', () => {
    expect(dayRangeInZone(RANGE.from, 'Asia/Riyadh').start.toISOString()).toBe(
      '2032-02-29T21:00:00.000Z',
    );
    expect(dayRangeInZone(RANGE.to, 'Asia/Riyadh').end.toISOString()).toBe(
      '2032-03-07T20:59:59.999Z',
    );
  });
});
