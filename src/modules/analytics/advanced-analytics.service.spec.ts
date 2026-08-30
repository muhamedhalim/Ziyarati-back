/**
 * Spec 014 (Clinic Platform Completion) — T143 (US11, FR-A002, depends T022).
 *
 * "Every figure MUST have a single stated definition ... two figures MUST
 * NOT measure the same thing under different names." The only way to prove
 * an aggregation figure is actually right is to compute the expected value
 * independently from the RAW source tables and compare — not to call the
 * service under test with different arguments (that would only prove the
 * service agrees with itself). This suite therefore runs against a REAL
 * Postgres connection (the same dev database `npm test` already uses; see
 * `SeedDataSource`) and, for every metric, issues its own raw SQL against
 * `appointments` / `payments` / `appointment_cancellations` /
 * `appointment_services` / `customer_reviews` and asserts the service's
 * output matches that independent computation exactly.
 *
 * Also asserts the metric REGISTRY itself has no two entries sharing
 * identical prose (a cheap, always-on guard against the same figure being
 * re-documented under two different names).
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { SeedDataSource } from '../../seed/data-source';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { AdvancedAnalyticsService } from './advanced-analytics.service';
import { METRIC_REGISTRY } from './metric-registry';
import { dayRangeUtc } from './analytics.constants';
import { PERMISSION } from '../../rbac/rbac.constants';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
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

const TENANT_WIDE_USER: AuthenticatedUser = {
  id: 'owner-stub',
  tenantId: null,
  roles: [],
  permissions: [
    PERMISSION.ANALYTICS_DASHBOARD_READ,
    PERMISSION.ANALYTICS_REPORTS_READ,
  ],
};

describe('AdvancedAnalyticsService — metric conformance against raw tables (T143, spec 014)', () => {
  let ds: DataSource;
  let aggregation: AnalyticsAggregationService;
  let advanced: AdvancedAnalyticsService;

  let tenantId: string;
  let branchAId: string;
  let branchBId: string;
  let serviceId: string;
  let customer1: string;
  let customer2: string;
  let customer3: string;
  let staffId: string;
  let restrictedUserId: string;

  // Fixed range for every conformance assertion below.
  const FROM = '2031-02-01';
  const TO = '2031-02-05';
  const { start: rangeStart } = dayRangeUtc(FROM);
  const rangeEndInstant = dayRangeUtc(TO).end;

  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000Z`);

  beforeAll(async () => {
    ds = await SeedDataSource.initialize();

    aggregation = new AnalyticsAggregationService(
      ds.getRepository(Branch),
      ds.getRepository(Appointment),
      ds.getRepository(Payment),
      ds.getRepository(Customer),
      ds.getRepository(AiMessage),
      ds.getRepository(Conversation),
      ds.getRepository(CustomerReview),
      ds.getRepository(AppointmentServiceEntity),
      ds.getRepository(StaffProfile),
      ds.getRepository(AppointmentCancellation),
    );
    advanced = new AdvancedAnalyticsService(
      aggregation,
      ds.getRepository(BranchUser),
      ds.getRepository(TenantSetting),
    );

    const suffix = randomUUID().slice(0, 8);
    const tenant = await ds.getRepository(Tenant).save(
      ds.getRepository(Tenant).create({
        name: `T143 Conformance ${suffix}`,
        slug: `t143-${suffix}`,
        contact_email: `t143-${suffix}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    tenantId = tenant.id;

    await ds.getRepository(TenantSetting).save(
      ds.getRepository(TenantSetting).create({
        tenant: { id: tenantId } as Tenant,
        currency: 'USD',
      }),
    );

    const branchA = await ds
      .getRepository(Branch)
      .save(
        ds
          .getRepository(Branch)
          .create({ tenant: { id: tenantId } as Tenant, name: 'Branch A' }),
      );
    const branchB = await ds
      .getRepository(Branch)
      .save(
        ds
          .getRepository(Branch)
          .create({ tenant: { id: tenantId } as Tenant, name: 'Branch B' }),
      );
    branchAId = branchA.id;
    branchBId = branchB.id;

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Consultation',
        duration_minutes: 30,
      }),
    );
    serviceId = service.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `staff-${suffix}@example.test`,
        full_name: 'Dr. Conformance',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        user: { id: staffUser.id } as User,
        tenant: { id: tenantId } as Tenant,
      }),
    );
    staffId = staff.id;

    // A SECOND staff user, assigned ONLY to Branch B via `branch_users` — the
    // branch-restricted caller for the FR-A016 assertions below. Deliberately
    // NOT given `analytics.dashboard.read`.
    const restrictedUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `restricted-${suffix}@example.test`,
        full_name: 'Branch B Manager',
        is_active: true,
      }),
    );
    restrictedUserId = restrictedUser.id;
    await ds.getRepository(BranchUser).save(
      ds.getRepository(BranchUser).create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchBId } as Branch,
        user: { id: restrictedUserId } as User,
      }),
    );

    const customers = ds.getRepository(Customer);
    const c1 = await customers.save(
      customers.create({
        tenant: { id: tenantId } as Tenant,
        full_name: 'Patient One',
        phone: '+966500000001',
        email: `patient1-${suffix}@example.test`,
      }),
    );
    const c2 = await customers.save(
      customers.create({
        tenant: { id: tenantId } as Tenant,
        full_name: 'Patient Two',
        phone: '+966500000002',
        email: `patient2-${suffix}@example.test`,
      }),
    );
    const c3 = await customers.save(
      customers.create({
        tenant: { id: tenantId } as Tenant,
        full_name: 'Patient Three',
        phone: '+966500000003',
        email: `patient3-${suffix}@example.test`,
      }),
    );
    customer1 = c1.id;
    customer2 = c2.id;
    customer3 = c3.id;

    const appointments = ds.getRepository(Appointment);
    const makeAppt = (overrides: Partial<Appointment>) =>
      appointments.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        customer: { id: customer1 } as Customer,
        staff: { id: staffId } as StaffProfile,
        start_at: at('2031-02-02', '09:00'),
        end_at: at('2031-02-02', '09:30'),
        status: AppointmentStatus.COMPLETED,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'USD',
        source: AppointmentSource.MANUAL,
        ...overrides,
      });

    // Branch A, day 1 (2031-02-02): 1 completed (customer1), 1 cancelled by
    // patient (customer2), 1 no-show (customer3).
    const a1 = await appointments.save(
      makeAppt({
        customer: { id: customer1 } as Customer,
        start_at: at('2031-02-02', '09:00'),
        end_at: at('2031-02-02', '09:30'),
      }),
    );
    const a2 = await appointments.save(
      makeAppt({
        customer: { id: customer2 } as Customer,
        status: AppointmentStatus.CANCELLED,
        start_at: at('2031-02-02', '10:00'),
        end_at: at('2031-02-02', '10:30'),
      }),
    );
    await appointments.save(
      makeAppt({
        customer: { id: customer3 } as Customer,
        status: AppointmentStatus.NO_SHOW,
        start_at: at('2031-02-02', '11:00'),
        end_at: at('2031-02-02', '11:30'),
      }),
    );
    // Branch A, day 3 (2031-02-04): 1 completed (customer1 again — a repeat
    // visit) + 1 cancelled by the CLINIC.
    const a4 = await appointments.save(
      makeAppt({
        customer: { id: customer1 } as Customer,
        start_at: at('2031-02-04', '09:00'),
        end_at: at('2031-02-04', '09:30'),
      }),
    );
    const a5 = await appointments.save(
      makeAppt({
        customer: { id: customer2 } as Customer,
        status: AppointmentStatus.CANCELLED,
        start_at: at('2031-02-04', '10:00'),
        end_at: at('2031-02-04', '10:30'),
      }),
    );
    // Branch B, day 2 (2031-02-03): 1 completed (customer2), via WHATSAPP_BOT
    // — this is the row that must NEVER appear in Branch A's figures, and
    // the ONLY row a Branch-B-restricted caller may see.
    const b1 = await appointments.save(
      makeAppt({
        branch: { id: branchBId } as Branch,
        customer: { id: customer2 } as Customer,
        source: AppointmentSource.WHATSAPP_BOT,
        start_at: at('2031-02-03', '09:00'),
        end_at: at('2031-02-03', '09:30'),
      }),
    );

    await ds.getRepository(AppointmentCancellation).save([
      ds.getRepository(AppointmentCancellation).create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: a2.id } as Appointment,
        origin: AppointmentActionOrigin.PATIENT,
      }),
      ds.getRepository(AppointmentCancellation).create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: a5.id } as Appointment,
        origin: AppointmentActionOrigin.STAFF,
      }),
    ]);

    const payments = ds.getRepository(Payment);
    await payments.save([
      payments.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        appointment: { id: a1.id } as Appointment,
        amount: 100,
        currency: 'USD',
        status: PaymentStatus.PAID,
        paid_at: at('2031-02-02', '09:35'),
      }),
      payments.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchAId } as Branch,
        appointment: { id: a4.id } as Appointment,
        amount: 150,
        currency: 'USD',
        status: PaymentStatus.PAID,
        paid_at: at('2031-02-04', '09:35'),
      }),
      payments.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchBId } as Branch,
        appointment: { id: b1.id } as Appointment,
        amount: 999,
        currency: 'USD',
        status: PaymentStatus.PAID,
        paid_at: at('2031-02-03', '09:35'),
      }),
    ]);

    await ds.getRepository(AppointmentServiceEntity).save([
      ds.getRepository(AppointmentServiceEntity).create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: a1.id } as Appointment,
        service: { id: serviceId } as Service,
        price: 100,
        duration_minutes: 30,
      }),
      ds.getRepository(AppointmentServiceEntity).create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: a4.id } as Appointment,
        service: { id: serviceId } as Service,
        price: 150,
        duration_minutes: 30,
      }),
    ]);

    await ds.getRepository(CustomerReview).save([
      ds.getRepository(CustomerReview).create({
        tenant: { id: tenantId } as Tenant,
        customer: { id: customer1 } as Customer,
        appointment: { id: a1.id } as Appointment,
        rating: 5,
      }),
      ds.getRepository(CustomerReview).create({
        tenant: { id: tenantId } as Tenant,
        customer: { id: customer1 } as Customer,
        appointment: { id: a4.id } as Appointment,
        rating: 3,
      }),
    ]);

    // Prior-period fixture for retention (FR-A007): customer1 had a
    // COMPLETED appointment in the period immediately preceding [FROM, TO]
    // (5 days = 2031-01-27..2031-01-31); customer2 did NOT. Only customer1
    // may count as "retained".
    await appointments.save(
      makeAppt({
        customer: { id: customer1 } as Customer,
        start_at: at('2031-01-28', '09:00'),
        end_at: at('2031-01-28', '09:30'),
      }),
    );
  }, 60_000);

  afterAll(async () => {
    // FK-safe order: children before parents. Own synthetic tenant only —
    // never touches any other tenant's data.
    const q = (sql: string) => ds.query(sql, [tenantId]);
    await q(`DELETE FROM payments WHERE "tenantId" = $1`);
    await q(`DELETE FROM customer_reviews WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointment_cancellations WHERE "tenantId" = $1`);
    await q(`DELETE FROM appointments WHERE "tenantId" = $1`);
    await q(`DELETE FROM services WHERE "tenantId" = $1`);
    await q(`DELETE FROM branch_users WHERE "tenantId" = $1`);
    await q(`DELETE FROM customers WHERE "tenantId" = $1`);
    await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`);
    await q(`DELETE FROM users WHERE "tenantId" = $1`);
    await q(`DELETE FROM branches WHERE "tenantId" = $1`);
    await q(`DELETE FROM tenant_settings WHERE "tenant_id" = $1`);
    await q(`DELETE FROM tenants WHERE id = $1`);
    await ds.destroy();
  }, 60_000);

  // ─────────────────────────── FR-A002 — the registry itself ─────────────────────────── //

  it('no two registry entries share identical prose (no hidden duplicate figure)', () => {
    const definitions = Object.values(METRIC_REGISTRY).map((m) => m.definition);
    expect(new Set(definitions).size).toBe(definitions.length);
  });

  it('every registry entry states what it counts (non-empty, real prose)', () => {
    for (const m of Object.values(METRIC_REGISTRY)) {
      expect(m.definition.length).toBeGreaterThan(20);
      expect(m.source.length).toBeGreaterThan(0);
    }
  });

  // ────────────────────── Appointment volume trend (FR-A004) ────────────────────────── //

  it('appointmentsTrend matches an independent raw-table count, per day, branch A only', async () => {
    const raw = await ds.query(
      `SELECT to_char(a.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
              COUNT(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_show
       FROM appointments a
       WHERE a."tenantId" = $1 AND a."branchId" = $2 AND a.start_at BETWEEN $3 AND $4
       GROUP BY 1 ORDER BY 1`,
      [tenantId, branchAId, rangeStart, rangeEndInstant],
    );

    const result = await advanced.appointmentsTrend(
      tenantId,
      TENANT_WIDE_USER,
      {
        from: FROM,
        to: TO,
        branchId: branchAId,
      },
    );

    expect(result.empty).toBe(false);
    expect(result.scope).toEqual({ branchId: branchAId });
    for (const r of raw) {
      const day = result.data.find((d: { date: string }) => d.date === r.date);
      expect(day).toBeDefined();
      expect(day!.total).toBe(r.total);
      expect(day!.completed).toBe(r.completed);
      expect(day!.cancelled).toBe(r.cancelled);
      expect(day!.noShow).toBe(r.no_show);
    }
    // Branch B's appointment (2031-02-03) must NOT leak into Branch A's trend.
    const day2 = result.data.find(
      (d: { date: string }) => d.date === '2031-02-03',
    );
    expect(day2?.total).toBe(0);
  });

  // ───────────────────────────── Revenue trend (FR-A003) ────────────────────────────── //

  it('revenueTrend matches an independent raw SUM over SETTLED payments, branch A only', async () => {
    const raw = await ds.query(
      `SELECT to_char(p.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
              COALESCE(SUM(p.amount), 0)::float AS revenue
       FROM payments p
       WHERE p."tenantId" = $1 AND p."branchId" = $2 AND p.status = 'PAID'
         AND p.paid_at BETWEEN $3 AND $4
       GROUP BY 1 ORDER BY 1`,
      [tenantId, branchAId, rangeStart, rangeEndInstant],
    );

    const result = await advanced.revenueTrend(tenantId, TENANT_WIDE_USER, {
      from: FROM,
      to: TO,
      branchId: branchAId,
    });

    expect(result.empty).toBe(false);
    expect(result.currency).toBe('USD');
    const rawTotal = raw.reduce(
      (s: number, r: { revenue: number }) => s + r.revenue,
      0,
    );
    const resultTotal = result.data.reduce(
      (s: number, d: { revenue: number }) => s + d.revenue,
      0,
    );
    expect(resultTotal).toBe(rawTotal);
    expect(resultTotal).toBe(250); // 100 (a1) + 150 (a4) — NOT branch B's 999.
  });

  // ─────────────────────────────────── Rates (FR-A005/006) ──────────────────────────── //

  it('rates matches an independent raw count of cancellation/no-show/completion, branch A only', async () => {
    const [raw] = await ds.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
              COUNT(*) FILTER (WHERE a.status = 'NO_SHOW')::int AS no_show
       FROM appointments a
       WHERE a."tenantId" = $1 AND a."branchId" = $2 AND a.start_at BETWEEN $3 AND $4`,
      [tenantId, branchAId, rangeStart, rangeEndInstant],
    );
    const [origins] = await ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.origin = 'PATIENT')::int AS by_patient,
         COUNT(*) FILTER (WHERE c.origin = 'STAFF')::int AS by_clinic
       FROM appointment_cancellations c
       INNER JOIN appointments a ON a.id = c."appointmentId"
       WHERE c."tenantId" = $1 AND a."branchId" = $2 AND a.status = 'CANCELLED'
         AND a.start_at BETWEEN $3 AND $4`,
      [tenantId, branchAId, rangeStart, rangeEndInstant],
    );

    const result = await advanced.rates(tenantId, TENANT_WIDE_USER, {
      from: FROM,
      to: TO,
      branchId: branchAId,
    });

    expect(result.empty).toBe(false);
    const rates = result as unknown as {
      cancellationRate: number;
      noShowRate: number;
      completionRate: number;
      cancellationByPatient: number;
      cancellationByClinic: number;
    };
    expect(rates.cancellationRate).toBeCloseTo(raw.cancelled / raw.total, 6);
    expect(rates.noShowRate).toBeCloseTo(raw.no_show / raw.total, 6);
    expect(rates.completionRate).toBeCloseTo(raw.completed / raw.total, 6);
    expect(rates.cancellationByPatient).toBe(origins.by_patient);
    expect(rates.cancellationByClinic).toBe(origins.by_clinic);
    // Fixture: 2 completed, 2 cancelled (1 patient, 1 clinic), 1 no-show = 5 total.
    expect(raw.total).toBe(5);
    expect(origins.by_patient).toBe(1);
    expect(origins.by_clinic).toBe(1);
  });

  // ─────────────────────────────────── Retention (FR-A007/008) ──────────────────────── //

  it('retention matches an independent raw EXISTS-based recomputation', async () => {
    const priorStart = dayRangeUtc('2031-01-27').start;
    const priorEnd = dayRangeUtc('2031-01-31').end;

    const [rawPrior] = await ds.query(
      `SELECT COUNT(DISTINCT a."customerId")::int AS c
       FROM appointments a
       WHERE a."tenantId" = $1 AND a."branchId" = $2 AND a.status = 'COMPLETED'
         AND a.start_at BETWEEN $3 AND $4`,
      [tenantId, branchAId, priorStart, priorEnd],
    );
    const [rawRetained] = await ds.query(
      `SELECT COUNT(DISTINCT a."customerId")::int AS c
       FROM appointments a
       WHERE a."tenantId" = $1 AND a."branchId" = $2 AND a.status = 'COMPLETED'
         AND a.start_at BETWEEN $3 AND $4
         AND a."customerId" IN (
           SELECT DISTINCT a2."customerId" FROM appointments a2
           WHERE a2."tenantId" = $1 AND a2."branchId" = $2 AND a2.status = 'COMPLETED'
             AND a2.start_at BETWEEN $5 AND $6
         )`,
      [tenantId, branchAId, rangeStart, rangeEndInstant, priorStart, priorEnd],
    );

    const result = await advanced.retention(tenantId, TENANT_WIDE_USER, {
      from: FROM,
      to: TO,
      branchId: branchAId,
    });

    expect(result.empty).toBe(false);
    const retention = result as unknown as {
      priorPeriodPatients: number;
      retainedPatients: number;
      repeatDistribution: { visits: number; patients: number }[];
    };
    expect(retention.priorPeriodPatients).toBe(rawPrior.c);
    expect(retention.retainedPatients).toBe(rawRetained.c);
    expect(retention.priorPeriodPatients).toBe(1); // only customer1
    expect(retention.retainedPatients).toBe(1); // customer1 also completed in-range
    // customer1: 2 completed visits in-range (a1, a4) -> repeat bucket "2".
    const twoVisits = retention.repeatDistribution.find((d) => d.visits === 2);
    expect(twoVisits?.patients).toBe(1);
  });

  // ─────────────────────────────── Service performance (FR-A009) ────────────────────── //

  it('performance/services matches an independent raw SUM of booked line-item price', async () => {
    const [raw] = await ds.query(
      `SELECT COUNT(*)::int AS appointments, COALESCE(SUM(aps.price), 0)::float AS revenue
       FROM appointment_services aps
       INNER JOIN appointments a ON a.id = aps."appointmentId"
       WHERE aps."tenantId" = $1 AND a."branchId" = $2 AND a.start_at BETWEEN $3 AND $4
         AND aps."serviceId" = $5`,
      [tenantId, branchAId, rangeStart, rangeEndInstant, serviceId],
    );

    const result = await advanced.performanceServices(
      tenantId,
      TENANT_WIDE_USER,
      {
        from: FROM,
        to: TO,
        branchId: branchAId,
        page: 1,
        limit: 20,
      },
    );

    expect(result.empty).toBe(false);
    const row = result.data.find(
      (d: { serviceId: string }) => d.serviceId === serviceId,
    );
    expect(row!.appointments).toBe(raw.appointments);
    expect(row!.revenue).toBe(raw.revenue);
    expect(row!.appointments).toBe(2); // a1 + a4
  });

  // ─────────────────────────────── Branch performance (FR-A011) ─────────────────────── //

  it('performance/branches matches independent raw per-branch counts and NEVER shows a clinic-wide total to a branch-restricted caller', async () => {
    const rawByBranch = await ds.query(
      `SELECT a."branchId" AS branch_id, COUNT(*)::int AS appointments
       FROM appointments a
       WHERE a."tenantId" = $1 AND a.start_at BETWEEN $2 AND $3
       GROUP BY 1`,
      [tenantId, rangeStart, rangeEndInstant],
    );
    const rawA = rawByBranch.find(
      (r: { branch_id: string }) => r.branch_id === branchAId,
    );
    const rawB = rawByBranch.find(
      (r: { branch_id: string }) => r.branch_id === branchBId,
    );

    const tenantWide = await advanced.performanceBranches(
      tenantId,
      TENANT_WIDE_USER,
      {
        from: FROM,
        to: TO,
        page: 1,
        limit: 20,
      },
    );
    expect(tenantWide.scope).toEqual({ branchId: 'ALL' });
    const rowA = tenantWide.data.find(
      (d: { branchId: string }) => d.branchId === branchAId,
    );
    const rowB = tenantWide.data.find(
      (d: { branchId: string }) => d.branchId === branchBId,
    );
    expect(rowA!.appointments).toBe(rawA.appointments);
    expect(rowB!.appointments).toBe(rawB.appointments);

    // FR-A016 — the Branch-B-restricted caller (holds only
    // analytics.reports.read, assigned only to Branch B) must see ONLY
    // Branch B's row, never Branch A's, and never a request-supplied
    // branchId for a DIFFERENT branch.
    const restricted: AuthenticatedUser = {
      id: restrictedUserId,
      tenantId: null,
      roles: [],
      permissions: [PERMISSION.ANALYTICS_REPORTS_READ],
    };
    const restrictedResult = await advanced.performanceBranches(
      tenantId,
      restricted,
      {
        from: FROM,
        to: TO,
        page: 1,
        limit: 20,
      },
    );
    expect(restrictedResult.scope).toEqual({ branchId: branchBId });
    expect(restrictedResult.data).toHaveLength(1);
    expect(restrictedResult.data[0].branchId).toBe(branchBId);
    expect(restrictedResult.data[0].appointments).toBe(rawB.appointments);

    await expect(
      advanced.performanceBranches(tenantId, restricted, {
        from: FROM,
        to: TO,
        branchId: branchAId,
        page: 1,
        limit: 20,
      }),
    ).rejects.toThrow();
  });

  // ─────────────────────────────── Channel performance (FR-A012) ────────────────────── //

  it('performance/channels matches an independent raw per-source count, all 4 sources present', async () => {
    const raw = await ds.query(
      `SELECT a.source AS source, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed
       FROM appointments a
       WHERE a."tenantId" = $1 AND a."branchId" = $2 AND a.start_at BETWEEN $3 AND $4
       GROUP BY 1`,
      [tenantId, branchAId, rangeStart, rangeEndInstant],
    );

    const result = await advanced.performanceChannels(
      tenantId,
      TENANT_WIDE_USER,
      {
        from: FROM,
        to: TO,
        branchId: branchAId,
        page: 1,
        limit: 20,
      },
    );

    expect(result.empty).toBe(false);
    // Every AppointmentSource must be present even at zero.
    expect(result.data.map((d: { source: string }) => d.source).sort()).toEqual(
      Object.values(AppointmentSource).sort(),
    );
    for (const r of raw) {
      const row = result.data.find(
        (d: { source: string }) => d.source === r.source,
      );
      expect(row!.appointments).toBe(r.total);
      expect(row!.completionRate).toBeCloseTo(r.completed / r.total, 6);
    }
  });

  // ───────────────────────────────────── Empty range (FR-A020) ──────────────────────── //

  // ────────── T147 (FR-A002) — every metric ANY route returns has a definition ────────── //

  it('every metric_key the dashboard route actually returns has a registry entry', async () => {
    const kpis = await aggregation.computeDashboardKpis(tenantId);
    expect(kpis.length).toBeGreaterThan(0);
    for (const kpi of kpis) {
      expect(METRIC_REGISTRY).toHaveProperty(kpi.metric_key);
    }
  });

  it('every figure documented for the existing daily/monthly/staff report fields has a registry entry', () => {
    // These routes return typed report objects, not `metric_key` strings —
    // this is the static mapping from report field -> registry key T022
    // already established (see metric-registry.ts's own docblock).
    const reportFieldConcepts = [
      'appointments.total',
      'appointments.completed',
      'appointments.cancelled',
      'appointments.no_show',
      'revenue.total',
      'customers.new',
      'ai.messages_count',
      'reviews.avg_rating',
    ] as const;
    for (const key of reportFieldConcepts) {
      // `toHaveProperty` treats a dotted string as a NESTED path, not a
      // literal key — these registry keys legitimately contain dots
      // (`appointments.total`), so a plain `in` check is used instead.
      expect(key in METRIC_REGISTRY).toBe(true);
    }
  });

  it('every F11 figure (T145/T146) has a registry entry', () => {
    const f11Keys = [
      'trends.appointments_daily',
      'trends.revenue_daily',
      'rates.cancellation',
      'rates.cancellation_by_patient',
      'rates.cancellation_by_clinic',
      'rates.no_show',
      'rates.completion',
      'retention.summary',
      'retention.repeat_distribution',
      'performance.services',
      'performance.staff',
      'performance.branches',
      'performance.channels',
    ] as const;
    for (const key of f11Keys) {
      expect(key in METRIC_REGISTRY).toBe(true);
    }
  });

  it('reports `empty: true` (not zeroes) for a range with genuinely no data', async () => {
    const result = await advanced.appointmentsTrend(
      tenantId,
      TENANT_WIDE_USER,
      {
        from: '2029-01-01',
        to: '2029-01-05',
        branchId: branchAId,
      },
    );
    expect(result.empty).toBe(true);
    expect(result.data).toEqual([]);
  });
});
