/**
 * Real-Postgres conformance suite (mirrors `advanced-analytics.service.spec.ts`
 * / T143's own doc-comment: the only way to prove an aggregation figure is
 * right is to compute the expected value independently from the raw source
 * tables and compare). Requires the same dev database `npm test` already
 * uses (`SeedDataSource`) — NOT runnable in an environment with no Postgres
 * (this implementation session had none; these assertions are written and
 * typechecked but not yet executed against a live database — run this
 * suite before relying on it).
 *
 * Percentile interpolation used below (PostgreSQL `percentile_cont`, linear):
 * for 4 sorted values [10, 20, 30, 40], p50 = 25 (midpoint of the middle
 * two), p90 = 10 + 0.9*3*(40-10)/3... concretely: rank = 0.9*(n-1) = 2.7,
 * so p90 = v[2] + 0.7*(v[3]-v[2]) = 30 + 0.7*10 = 37.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { SeedDataSource } from '../../../seed/data-source';
import { JourneyAggregationService } from './journey-aggregation.service';
import {
  buildJourneyOverallQuery,
  type JourneyQueryOptions,
} from './journey-sql';
import { JOURNEY_KNOWN_TIMEZONES } from './journey.constants';
import { dayRangeUtc } from '../analytics.constants';

import { Tenant } from '../../../entities/SaaS-Core/Tenant';
import { Branch } from '../../../entities/SaaS-Core/Branch';
import { User } from '../../../entities/Auth&RBAC/User';
import { StaffProfile } from '../../../entities/Staff/StaffProfile';
import { Customer } from '../../../entities/CRM/Customer';
import { Service } from '../../../entities/Services/Service';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../../entities/Calendar&Appointments/AppointmentService';
import { QueueEntry } from '../../../entities/Calendar&Appointments/QueueEntry';
import { ScheduledNotification } from '../../../entities/Notifications/ScheduledNotification';
import {
  AppointmentPaymentStatus,
  AppointmentSource,
  AppointmentStatus,
  QueueState,
  TenantApprovalStatus,
} from '../../../entities/enums';

describe('JourneyAggregationService — conformance against raw tables', () => {
  let ds: DataSource;
  let journeyAgg: JourneyAggregationService;

  let tenantId: string;
  let otherTenantId: string;
  let branchId: string;
  let staffId: string;
  let serviceId: string;
  let serviceId2: string;
  let customerId: string;

  const FROM = '2031-03-01';
  const TO = '2031-03-10';
  const NOW = new Date('2031-03-15T00:00:00.000Z');
  const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000Z`);

  const opts = (): JourneyQueryOptions => ({
    tenantId,
    start: dayRangeUtc(FROM).start,
    end: dayRangeUtc(TO).end,
    now: NOW,
    zones: JOURNEY_KNOWN_TIMEZONES,
  });

  beforeAll(async () => {
    ds = await SeedDataSource.initialize();
    journeyAgg = new JourneyAggregationService(ds.getRepository(Appointment));

    const suffix = randomUUID().slice(0, 8);
    const tenant = await ds.getRepository(Tenant).save(
      ds.getRepository(Tenant).create({
        name: `Journey Conformance ${suffix}`,
        slug: `journey-${suffix}`,
        contact_email: `journey-${suffix}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    tenantId = tenant.id;

    const other = await ds.getRepository(Tenant).save(
      ds.getRepository(Tenant).create({
        name: `Journey Other ${suffix}`,
        slug: `journey-other-${suffix}`,
        contact_email: `journey-other-${suffix}@example.test`,
        approval_status: TenantApprovalStatus.APPROVED,
        is_active: true,
      }),
    );
    otherTenantId = other.id;

    const branch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Main Branch',
        timezone: 'Asia/Riyadh',
      }),
    );
    branchId = branch.id;

    const service = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Consultation',
        public_slug: 'consultation',
        duration_minutes: 30,
      }),
    );
    serviceId = service.id;
    const service2 = await ds.getRepository(Service).save(
      ds.getRepository(Service).create({
        tenant: { id: tenantId } as Tenant,
        name: 'Cleaning',
        public_slug: 'cleaning',
        duration_minutes: 45,
      }),
    );
    serviceId2 = service2.id;

    const staffUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: tenantId } as Tenant,
        email: `staff-${suffix}@example.test`,
        full_name: 'Dr. Journey',
        is_active: true,
      }),
    );
    const staff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        user: { id: staffUser.id } as User,
        tenant: { id: tenantId } as Tenant,
        // globally unique (UQ_staff_profiles_public_slug), so derive it from the per-run suffix
        public_slug: `journey-staff-${suffix}`,
      }),
    );
    staffId = staff.id;

    const customer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: tenantId } as Tenant,
        full_name: 'Patient Journey',
        phone: '+966500000099',
        email: `patient-${suffix}@example.test`,
      }),
    );
    customerId = customer.id;
  });

  afterAll(async () => {
    const q = (sql: string, tid = tenantId) => ds.query(sql, [tid]);
    for (const tid of [tenantId, otherTenantId]) {
      await q(`DELETE FROM scheduled_notifications WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM queue_entries WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM appointment_status_logs WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM appointment_services WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM appointments WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM services WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM customers WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM users WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM branches WHERE "tenantId" = $1`, tid);
      await q(`DELETE FROM tenant_settings WHERE "tenant_id" = $1`, tid);
      await q(`DELETE FROM tenants WHERE id = $1`, tid);
    }
    await ds.destroy();
  });

  async function makeAppointment(
    overrides: Partial<Appointment>,
  ): Promise<Appointment> {
    const repo = ds.getRepository(Appointment);
    return repo.save(
      repo.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        customer: { id: customerId } as Customer,
        staff: { id: staffId } as StaffProfile,
        status: AppointmentStatus.COMPLETED,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
        ...overrides,
      }),
    );
  }

  async function attachService(
    appointmentId: string,
    svc: string,
    minutes = 30,
    price = 100,
  ) {
    const repo = ds.getRepository(AppointmentServiceEntity);
    await repo.save(
      repo.create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: appointmentId } as Appointment,
        service: { id: svc } as Service,
        price,
        duration_minutes: minutes,
      }),
    );
  }

  async function makeQueueEntry(overrides: Partial<QueueEntry>) {
    const repo = ds.getRepository(QueueEntry);
    return repo.save(
      repo.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: branchId } as Branch,
        customer: { id: customerId } as Customer,
        staff: { id: staffId } as StaffProfile,
        state: QueueState.COMPLETED,
        // NOT NULL; the journey SQL never reads it, so the arrival's own day (or a day inside the test window) is faithful
        business_date: (overrides.arrived_at ?? new Date('2031-03-05T09:00:00.000Z'))
          .toISOString()
          .slice(0, 10),
        ...overrides,
      }),
    );
  }

  /** `appointment_status_logs.created_at` is a `@CreateDateColumn()` — raw INSERT is the only way to control it. */
  async function insertStatusLog(
    appointmentId: string,
    status: AppointmentStatus,
    createdAt: Date,
  ) {
    await ds.query(
      `INSERT INTO appointment_status_logs (id, "appointmentId", "tenantId", status, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::timestamptz)`,
      [appointmentId, tenantId, status, createdAt],
    );
  }

  async function makeReminder(
    appointmentId: string,
    leadMinutes: number,
    overrides: Partial<ScheduledNotification>,
  ) {
    const repo = ds.getRepository(ScheduledNotification);
    await repo.save(
      repo.create({
        tenant: { id: tenantId } as Tenant,
        appointment: { id: appointmentId } as Appointment,
        recipient_type: 'CUSTOMER',
        recipient_id: customerId,
        scheduled_at: new Date(),
        source_ref: `appointment-reminder:${appointmentId}:${leadMinutes}`,
        status: 'SENT',
        delivery_status: 'NONE',
        ...overrides,
      }),
    );
  }

  it("booked/completed/cancelled/no_show counts match computeRates' own definition (parity)", async () => {
    const a1 = await makeAppointment({
      start_at: at('2031-03-02', '09:00'),
      end_at: at('2031-03-02', '09:30'),
      status: AppointmentStatus.COMPLETED,
    });
    const a2 = await makeAppointment({
      start_at: at('2031-03-02', '10:00'),
      end_at: at('2031-03-02', '10:30'),
      status: AppointmentStatus.CANCELLED,
    });
    const a3 = await makeAppointment({
      start_at: at('2031-03-02', '11:00'),
      end_at: at('2031-03-02', '11:30'),
      status: AppointmentStatus.NO_SHOW,
    });
    void a1;
    void a2;
    void a3;

    const overall = await journeyAgg.fetchOverall(opts());

    const [independentRow] = await ds.query<
      { total: string; completed: string; cancelled: string; no_show: string }[]
    >(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
              COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
              COUNT(*) FILTER (WHERE status = 'NO_SHOW') AS no_show
       FROM appointments
       WHERE "tenantId" = $1 AND start_at BETWEEN $2 AND $3 AND deleted_at IS NULL`,
      [tenantId, dayRangeUtc(FROM).start, dayRangeUtc(TO).end],
    );

    expect(overall.booked).toBe(Number(independentRow.total));
    expect(overall.completed).toBe(Number(independentRow.completed));
    expect(overall.cancelled).toBe(Number(independentRow.cancelled));
    expect(overall.no_show).toBe(Number(independentRow.no_show));
  });

  it('computes wait-to-start/ready-delay/consultation from the queue, matching hand-computed percentiles', async () => {
    // 4 completed appointments, scheduled 09:00, arriving/starting/ending at controlled offsets:
    // wait_start values (started - arrived), minutes: [10, 20, 30, 40] -> p50=25, p90=37 (linear interpolation)
    const rows = [
      { arrive: '08:55', started: '09:05' }, // wait 10
      { arrive: '08:50', started: '09:10' }, // wait 20
      { arrive: '08:40', started: '09:10' }, // wait 30
      { arrive: '08:30', started: '09:10' }, // wait 40
    ];
    for (const [i, r] of rows.entries()) {
      const day = `2031-03-0${3 + i}`;
      const appt = await makeAppointment({
        start_at: at(day, '09:00'),
        end_at: at(day, '09:30'),
        status: AppointmentStatus.COMPLETED,
      });
      await makeQueueEntry({
        appointment: { id: appt.id } as Appointment,
        arrived_at: at(day, r.arrive),
        called_at: at(day, r.arrive.slice(0, 3) + '5'.padStart(2, '0')), // arbitrary, before started
        started_at: at(day, r.started),
        ended_at: at(day, '09:35'),
        state: QueueState.COMPLETED,
      });
    }

    const overall = await journeyAgg.fetchOverall({
      ...opts(),
      start: dayRangeUtc('2031-03-03').start,
      end: dayRangeUtc('2031-03-06').end,
    });

    expect(overall.wait_start_n).toBe(4);
    expect(overall.wait_start_p50).toBeCloseTo(25, 1);
    expect(overall.wait_start_p90).toBeCloseTo(37, 1);
  });

  it('a recall (skip then re-call) leaves only the LAST call time visible', async () => {
    const appt = await makeAppointment({
      start_at: at('2031-03-07', '09:00'),
      end_at: at('2031-03-07', '09:30'),
      status: AppointmentStatus.COMPLETED,
    });
    // First called at 09:05 (would-be wait_call = 5 min), then skipped and
    // recalled at 09:20 — the row itself only ever stores the LATEST call.
    await makeQueueEntry({
      appointment: { id: appt.id } as Appointment,
      arrived_at: at('2031-03-07', '09:00'),
      called_at: at('2031-03-07', '09:20'),
      started_at: at('2031-03-07', '09:25'),
      ended_at: at('2031-03-07', '09:55'),
      state: QueueState.COMPLETED,
    });

    const overall = await journeyAgg.fetchOverall({
      ...opts(),
      start: dayRangeUtc('2031-03-07').start,
      end: dayRangeUtc('2031-03-07').end,
    });

    expect(overall.wait_call_p50).toBeCloseTo(20, 1); // NOT 5 — the earlier call time is gone
  });

  it('a swept queue row (day-close CANCELLED while the appointment is not) is counted but contributes no duration', async () => {
    const appt = await makeAppointment({
      start_at: at('2031-03-08', '09:00'),
      end_at: at('2031-03-08', '09:30'),
      status: AppointmentStatus.COMPLETED, // completed via the appointment page directly, bypassing the queue
    });
    await makeQueueEntry({
      appointment: { id: appt.id } as Appointment,
      arrived_at: at('2031-03-08', '08:55'),
      state: QueueState.CANCELLED, // swept by the day-close sweep
      ended_at: at('2031-03-08', '23:50'),
    });
    // Completion recorded via status logs instead (queue was bypassed for the actual finish).
    await insertStatusLog(
      appt.id,
      AppointmentStatus.IN_PROGRESS,
      at('2031-03-08', '09:02'),
    );
    await insertStatusLog(
      appt.id,
      AppointmentStatus.COMPLETED,
      at('2031-03-08', '09:32'),
    );

    const overall = await journeyAgg.fetchOverall({
      ...opts(),
      start: dayRangeUtc('2031-03-08').start,
      end: dayRangeUtc('2031-03-08').end,
    });

    expect(overall.swept).toBe(1);
    // `completed_with_queue` = COMPLETED appointments that HAVE a queue entry (the same
    // `has_queue` predicate as the `arrived` stage), whatever that entry's final state.
    // The patient did check in, so a swept row still counts toward queue coverage; what
    // it must NOT do is contribute a duration (asserted below). Whether a swept check-in
    // should count as "went through the queue" is a product decision, not settled here.
    expect(overall.completed_with_queue).toBe(1);
    expect(overall.start_from_log).toBe(1); // start time came from the status log, not the swept queue row
    expect(overall.consult_n).toBe(1);
    expect(overall.consult_p50).toBeCloseTo(30, 1); // 09:02 -> 09:32
  });

  it('a multi-service appointment is excluded from the service dimension', async () => {
    const single = await makeAppointment({
      start_at: at('2031-03-09', '09:00'),
      end_at: at('2031-03-09', '09:30'),
    });
    await attachService(single.id, serviceId, 30);
    const multi = await makeAppointment({
      start_at: at('2031-03-09', '10:00'),
      end_at: at('2031-03-09', '11:00'),
    });
    await attachService(multi.id, serviceId, 30);
    await attachService(multi.id, serviceId2, 30);

    const rows = await journeyAgg.fetchDimension(
      {
        ...opts(),
        start: dayRangeUtc('2031-03-09').start,
        end: dayRangeUtc('2031-03-09').end,
      },
      'service',
    );

    const keys = rows.map((r) => r.dim_key);
    expect(keys).toContain(serviceId);
    // The multi-service appointment must not inflate serviceId's count, and
    // must not appear under serviceId2 either (it was never grouped).
    const svcRow = rows.find((r) => r.dim_key === serviceId);
    expect(svcRow?.booked).toBe(1);
  });

  it('reminder rows: SENT before start counts as reminded; a reasoned CANCELLED counts as failed', async () => {
    const appt = await makeAppointment({
      start_at: at('2031-03-04', '09:00'),
      end_at: at('2031-03-04', '09:30'),
      status: AppointmentStatus.NO_SHOW,
    });
    await makeReminder(appt.id, 1440, {
      status: 'SENT',
      sent_at: at('2031-03-03', '09:00'),
    });
    const otherAppt = await makeAppointment({
      start_at: at('2031-03-04', '10:00'),
      end_at: at('2031-03-04', '10:30'),
      status: AppointmentStatus.NO_SHOW,
    });
    await makeReminder(otherAppt.id, 1440, {
      status: 'CANCELLED',
      skip_reason: 'OPTED_OUT',
    });

    const overall = await journeyAgg.fetchOverall({
      ...opts(),
      start: dayRangeUtc('2031-03-04').start,
      end: dayRangeUtc('2031-03-04').end,
    });

    expect(overall.rem_reminded).toBe(1);
    expect(overall.no_show_reminded).toBe(1);
    expect(overall.rem_failed_only).toBe(1);
  });

  it('excludes soft-deleted appointments', async () => {
    const appt = await makeAppointment({
      start_at: at('2031-03-10', '09:00'),
      end_at: at('2031-03-10', '09:30'),
      status: AppointmentStatus.CANCELLED,
    });
    await ds.getRepository(Appointment).softDelete(appt.id);

    const overall = await journeyAgg.fetchOverall({
      ...opts(),
      start: dayRangeUtc('2031-03-10').start,
      end: dayRangeUtc('2031-03-10').end,
    });

    expect(overall.booked).toBe(0);
  });

  it("never returns another tenant's rows", async () => {
    const otherBranch = await ds.getRepository(Branch).save(
      ds.getRepository(Branch).create({
        tenant: { id: otherTenantId } as Tenant,
        name: 'Other Branch',
      }),
    );
    const otherUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        tenant: { id: otherTenantId } as Tenant,
        email: `other-${randomUUID()}@example.test`,
        full_name: 'Other Staff',
        is_active: true,
      }),
    );
    const otherStaff = await ds.getRepository(StaffProfile).save(
      ds.getRepository(StaffProfile).create({
        user: { id: otherUser.id } as User,
        tenant: { id: otherTenantId } as Tenant,
        public_slug: `journey-other-staff-${randomUUID().slice(0, 8)}`,
      }),
    );
    const otherCustomer = await ds.getRepository(Customer).save(
      ds.getRepository(Customer).create({
        tenant: { id: otherTenantId } as Tenant,
        full_name: 'Other Patient',
        phone: '+966500000098',
        email: `other-patient-${randomUUID().slice(0, 8)}@example.test`,
      }),
    );
    const otherRepo = ds.getRepository(Appointment);
    await otherRepo.save(
      otherRepo.create({
        tenant: { id: otherTenantId } as Tenant,
        branch: { id: otherBranch.id } as Branch,
        customer: { id: otherCustomer.id } as Customer,
        staff: { id: otherStaff.id } as StaffProfile,
        start_at: at('2031-03-05', '09:00'),
        end_at: at('2031-03-05', '09:30'),
        status: AppointmentStatus.COMPLETED,
        payment_status: AppointmentPaymentStatus.PAID,
        currency: 'SAR',
        source: AppointmentSource.MANUAL,
      }),
    );

    const { sql, params } = buildJourneyOverallQuery({
      ...opts(),
      tenantId: otherTenantId,
      start: dayRangeUtc('2031-03-05').start,
      end: dayRangeUtc('2031-03-05').end,
    });
    const [row] = await ds.query(sql, params);
    expect(row.booked).toBe(1); // only the other tenant's own row

    const oursRow = await journeyAgg.fetchOverall({
      ...opts(),
      start: dayRangeUtc('2031-03-05').start,
      end: dayRangeUtc('2031-03-05').end,
    });
    // This tenant may legitimately have its OWN appointments on that day (the percentile test
    // above books one on 2031-03-05 — the fixture is shared and the tests are order-dependent),
    // so the expected value is computed independently from the raw table for THIS tenant only.
    // A cross-tenant leak would make the aggregate exceed that count by the other tenant's row.
    const [{ n: ownRaw }] = await ds.query(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE "tenantId" = $1 AND start_at BETWEEN $2 AND $3 AND deleted_at IS NULL`,
      [tenantId, dayRangeUtc('2031-03-05').start, dayRangeUtc('2031-03-05').end],
    );
    expect(oursRow.booked).toBe(ownRaw);
  });

  it('every KNOWN_TIMEZONES entry is a real Postgres zone (AT TIME ZONE never errors)', async () => {
    const [{ count }] = await ds.query<{ count: string }[]>(
      `SELECT COUNT(*)::int AS count FROM pg_timezone_names WHERE name = ANY($1::text[])`,
      [JOURNEY_KNOWN_TIMEZONES],
    );
    // Not every IANA alias Node knows is guaranteed to be in pg_timezone_names
    // verbatim (e.g. deprecated aliases) — this asserts the OVERWHELMING
    // majority resolve, catching a wholesale mismatch (wrong Postgres
    // version, wrong tzdata) without being fragile to a handful of aliases.
    expect(Number(count)).toBeGreaterThan(JOURNEY_KNOWN_TIMEZONES.length * 0.9);
  });
});
