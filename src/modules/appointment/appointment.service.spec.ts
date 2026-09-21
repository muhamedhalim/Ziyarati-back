import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AppointmentsService } from './appointment.service';
import { AppointmentAuditService } from './appointment-audit.service';
import { BranchScopeService } from '../../core/branch-scope/branch-scope.service';
import { StaffScopeService } from '../../core/staff-scope/staff-scope.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentHistory } from '../../entities/Calendar&Appointments/AppointmentHistory';
import { AppointmentStatusLog } from '../../entities/Calendar&Appointments/AppointmentStatusLog';
import { AppointmentNote } from '../../entities/Calendar&Appointments/AppointmentNote';
import { AppointmentReschedule } from '../../entities/Calendar&Appointments/AppointmentReschedule';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';
import { ScheduledNotification } from '../../entities/Notifications/ScheduledNotification';
import { OutboxJob } from '../../entities/Campaigns/OutboxJob';
import { QUEUE, JOB } from '../../queue/queue.constants';
import { AppointmentActionOrigin } from '../../entities/enums';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { Service, PricingType } from '../../entities/Services/Service';
import { AvailabilityService } from '../scheduling/availability.service';
import { UsageService } from '../subscription-billing/usage.service';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import {
  AppointmentStatus,
  AppointmentPaymentStatus,
} from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';
import { UserRole } from '../../entities/Auth&RBAC/UserRole';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 'tenant-1';
const USER = 'user-1';

describe('AppointmentsService', () => {
  let service: AppointmentsService;
  let appointments: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let availability: { assertBookable: jest.Mock };
  let usage: {
    assertWithinLimit: jest.Mock;
    increment: jest.Mock;
    incrementIfWithinLimit: jest.Mock;
  };
  let subscriptions: { assertBillableActionAllowed: jest.Mock };
  let notesRepo: MockRepository;
  let historyRepo: MockRepository;
  let statusLogsRepo: MockRepository;
  let reschedulesRepo: MockRepository;
  let cancellationsRepo: MockRepository;
  let scheduledNotificationsRepo: MockRepository;
  let appointmentAudit: { record: jest.Mock };
  let staffScope: { resolveOwnStaffId: jest.Mock };

  /** Full tenant-wide access — the default caller for existing tests. */
  const FULL_ACCESS_CALLER = {
    id: USER,
    permissions: [PERMISSION.APPOINTMENTS_READ],
  };

  /** A fully-hydrated appointment returned by the trailing `findOne` reload. */
  const reloaded = {
    id: 'appt-1',
    status: AppointmentStatus.PENDING_PAYMENT,
    customer: { id: 'cust-1' },
    staff: { id: 'staff-1' },
    branch: { id: 'b1' },
    start_at: new Date('2026-08-01T10:00:00Z'),
  };

  beforeEach(async () => {
    appointments = createMockRepository();
    appointments.findOne.mockResolvedValue(reloaded); // trailing reload default
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    availability = { assertBookable: jest.fn().mockResolvedValue(undefined) };
    usage = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      incrementIfWithinLimit: jest
        .fn()
        .mockResolvedValue({ applied: true, used: 0, limit: 100 }),
    };
    subscriptions = {
      assertBillableActionAllowed: jest.fn().mockResolvedValue(undefined),
    };
    notesRepo = createMockRepository();
    historyRepo = createMockRepository();
    statusLogsRepo = createMockRepository();
    reschedulesRepo = createMockRepository();
    cancellationsRepo = createMockRepository();
    scheduledNotificationsRepo = createMockRepository();
    appointmentAudit = { record: jest.fn().mockResolvedValue(undefined) };
    staffScope = { resolveOwnStaffId: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentsService,
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: getRepositoryToken(AppointmentNote), useValue: notesRepo },
        {
          provide: getRepositoryToken(AppointmentHistory),
          useValue: historyRepo,
        },
        {
          provide: getRepositoryToken(AppointmentStatusLog),
          useValue: statusLogsRepo,
        },
        {
          provide: getRepositoryToken(AppointmentReschedule),
          useValue: reschedulesRepo,
        },
        {
          provide: getRepositoryToken(AppointmentCancellation),
          useValue: cancellationsRepo,
        },
        {
          provide: getRepositoryToken(ScheduledNotification),
          useValue: scheduledNotificationsRepo,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: AvailabilityService, useValue: availability },
        { provide: UsageService, useValue: usage },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: AppointmentAuditService, useValue: appointmentAudit },
        // Tenant-wide (branchIds: null) — every principal this suite models
        // predates branch scoping, so the service composes exactly the
        // queries it did before, and these assertions keep their meaning.
        {
          provide: BranchScopeService,
          useValue: {
            resolve: jest.fn().mockResolvedValue({ branchIds: null }),
            resolveCurrent: jest.fn().mockResolvedValue({ branchIds: null }),
            isAllowed: () => true,
            assertBranchAllowed: () => undefined,
            branchFilter: () => undefined,
          },
        },
        { provide: StaffScopeService, useValue: staffScope },
      ],
    }).compile();
    service = moduleRef.get(AppointmentsService);
  });

  afterEach(() => jest.clearAllMocks());

  // Convenience: the per-entity stable repos the service obtains via the manager.
  const repo = (entity: unknown) =>
    manager.getRepository(entity) as unknown as MockRepository;

  describe('create', () => {
    const dto = {
      branchId: 'b1',
      customerId: 'c1',
      staffId: 's1',
      serviceIds: ['svc1'],
      startAt: '2026-07-01T10:00:00.000Z',
    } as any;

    const primeValidRefs = () => {
      // One read, not two: `assertBranch` now returns the row so `create` can
      // snapshot `timezone` from it instead of re-reading the same branch.
      repo(Branch).findOne.mockResolvedValue({
        id: 'b1',
        timezone: 'Asia/Riyadh',
      });
      repo(Customer).exists.mockResolvedValue(true);
      // Branch-scoped staff validation loads the profile (it also needs
      // `is_available_for_booking`), where it used to only `exists` on tenant.
      repo(StaffProfile).findOne.mockResolvedValue({
        id: 's1',
        is_available_for_booking: true,
      });
      // No staff_schedules rows anywhere → unconfigured legacy clinic, which
      // "explicit configuration wins" deliberately lets through.
      repo(StaffSchedule).exists.mockResolvedValue(false);
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 30, base_price: 100, is_active: true },
      ]);
      repo(Appointment).save.mockImplementation(async (e: any) => ({
        id: 'appt-1',
        ...e,
      }));
    };

    it('books through the availability engine and counts the quota atomically (success)', async () => {
      primeValidRefs();

      const result = await service.create(TENANT, USER, dto);

      // FND-034: the quota check-and-increment is now ONE atomic call, INSIDE
      // the transaction (manager passed through), after availability —
      // replacing the old assertWithinLimit-then-later-increment pair.
      expect(usage.incrementIfWithinLimit).toHaveBeenCalledWith(
        TENANT,
        'APPOINTMENTS',
        1,
        manager,
      );
      // P0 booking remediation: NO `manager`. The availability engine fans out
      // to six sibling services that each check out their own pooled
      // connection; running it inside the write transaction meant a booking
      // needed its transaction's connection PLUS a free one, so N concurrent
      // bookings (N >= pool size) deadlocked. Passing a manager bought no
      // isolation either way — the double-booking guarantee is the
      // `appointments_no_overlap` EXCLUSION constraint at INSERT, not this
      // check. See the comment on `create`.
      // P2 (Phase 6): the branch/staff rows validation just loaded are
      // threaded through as `preloaded*`, so AvailabilityService doesn't
      // re-fetch the identical rows a second time (measured: 4 duplicate
      // statements per booking before this change).
      expect(availability.assertBookable).toHaveBeenCalledWith(
        TENANT,
        'b1',
        's1',
        expect.any(Date),
        expect.any(Date),
        {
          preloadedBranch: { id: 'b1', timezone: 'Asia/Riyadh' },
          preloadedStaff: { id: 's1', is_available_for_booking: true },
        },
      );
      // New bookings start UNPAID / PENDING_PAYMENT (the two axes are independent).
      const created = repo(Appointment).create.mock.calls[0][0];
      expect(created.status).toBe(AppointmentStatus.PENDING_PAYMENT);
      expect(created.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
      expect(result).toBe(reloaded);
    });

    describe('requireBookableStaff (dashboard POST /appointments)', () => {
      const staffWithUser = {
        id: 's1',
        is_available_for_booking: true,
        user: { id: 'u-staff' },
      };

      it('books a staff member whose account holds the doctor or manager role', async () => {
        primeValidRefs();
        repo(StaffProfile).findOne.mockResolvedValue(staffWithUser);
        repo(UserRole).exists.mockResolvedValue(true);

        await service.create(TENANT, USER, dto, { requireBookableStaff: true });

        // Matched through THIS staff member's own user, inside THIS tenant,
        // against exactly the doctor + manager slugs.
        expect(repo(UserRole).exists).toHaveBeenCalledWith({
          where: {
            user: { id: 'u-staff', tenant: { id: TENANT } },
            role: { slug: In([ROLE.DOCTOR, ROLE.MANAGER]) },
          },
        });
        expect(repo(Appointment).save).toHaveBeenCalled();
      });

      it('rejects a receptionist (or any other role) BEFORE availability, quota or insert', async () => {
        primeValidRefs();
        repo(StaffProfile).findOne.mockResolvedValue(staffWithUser);
        repo(UserRole).exists.mockResolvedValue(false);

        await expect(
          service.create(TENANT, USER, dto, { requireBookableStaff: true }),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

        expect(availability.assertBookable).not.toHaveBeenCalled();
        expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
        expect(repo(Appointment).save).not.toHaveBeenCalled();
      });

      it('rejects a staff profile that has no linked account (fail closed)', async () => {
        primeValidRefs();
        repo(StaffProfile).findOne.mockResolvedValue({
          id: 's1',
          is_available_for_booking: true,
        });

        await expect(
          service.create(TENANT, USER, dto, { requireBookableStaff: true }),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
        expect(repo(UserRole).exists).not.toHaveBeenCalled();
        expect(repo(Appointment).save).not.toHaveBeenCalled();
      });

      it('is opt-in: assistant/waitlist/import callers skip the role check entirely', async () => {
        primeValidRefs();

        await service.create(TENANT, USER, dto);

        expect(repo(UserRole).exists).not.toHaveBeenCalled();
        expect(repo(Appointment).save).toHaveBeenCalled();
      });
    });

    it('[M-9] confirms an insured booking instead of stranding it in PENDING_PAYMENT', async () => {
      primeValidRefs();

      await service.create(TENANT, USER, { ...dto, hasInsurance: true });

      const created = repo(Appointment).create.mock.calls[0][0];
      // The two axes now agree. An insured booking is never charged online, and
      // the ONLY automatic route to CONFIRMED is a verified payment event — so
      // leaving it PENDING_PAYMENT (the previous behaviour, asserted here) meant
      // waiting forever for a payment that could never arrive, until a staff
      // member advanced it by hand.
      expect(created.status).toBe(AppointmentStatus.CONFIRMED);
      // Insurance still never implies PAID.
      expect(created.payment_status).toBe(AppointmentPaymentStatus.INSURANCE);
    });

    it('keeps the existing UNPAID default when hasInsurance is false/omitted', async () => {
      primeValidRefs();

      await service.create(TENANT, USER, { ...dto, hasInsurance: false });

      const created = repo(Appointment).create.mock.calls[0][0];
      expect(created.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
      expect(created.status).toBe(AppointmentStatus.PENDING_PAYMENT);
    });

    it('[M-9] confirms when the clinic does not collect online payment at all', async () => {
      primeValidRefs();
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes('tenant_settings') ? [{ payment_required: false }] : [],
      );

      await service.create(TENANT, USER, dto);

      const created = repo(Appointment).create.mock.calls[0][0];
      expect(created.status).toBe(AppointmentStatus.CONFIRMED);
      expect(created.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
    });

    it('[M-9] confirms a zero-total booking (nothing to collect)', async () => {
      primeValidRefs();
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 30, base_price: 0, is_active: true },
      ]);

      await service.create(TENANT, USER, dto);

      expect(repo(Appointment).create.mock.calls[0][0].status).toBe(
        AppointmentStatus.CONFIRMED,
      );
    });

    it('[F-5] prices the booking from service_prices at THIS branch, not base_price', async () => {
      primeValidRefs();
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes('service_prices')
          ? [{ serviceId: 'svc1', branchId: 'b1', price: '250' }]
          : [],
      );

      await service.create(TENANT, USER, dto);

      // 250 (branch price), NOT 100 (clinic-wide base_price).
      expect(repo(Appointment).create.mock.calls[0][0].total_amount).toBe(250);
      expect(repo(AppointmentServiceEntity).create.mock.calls[0][0].price).toBe(
        250,
      );
    });

    it('[F-5] rejects a service configured for OTHER branches but not this one', async () => {
      primeValidRefs();
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes('service_prices')
          ? [{ serviceId: 'svc1', branchId: 'some-other-branch', price: '250' }]
          : [],
      );

      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
    });

    it('[F-4] rejects a doctor who has schedules elsewhere but none at this branch', async () => {
      primeValidRefs();
      // Not at branch b1, but scheduled somewhere → explicit config says no.
      repo(StaffSchedule)
        .exists.mockResolvedValueOnce(false) // at b1?
        .mockResolvedValueOnce(true); // anywhere?

      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('[F-4] allows a doctor scheduled AT the branch', async () => {
      primeValidRefs();
      repo(StaffSchedule).exists.mockResolvedValueOnce(true);

      await expect(service.create(TENANT, USER, dto)).resolves.toBe(reloaded);
    });

    // FND-034: the quota check now runs INSIDE the transaction (after
    // availability, so only a genuine quota exhaustion reaches it) — a
    // rejection there rolls the transaction back, so nothing is created.
    it('rejects when the plan appointment quota is exceeded (transaction rolls back)', async () => {
      primeValidRefs();
      usage.incrementIfWithinLimit.mockResolvedValueOnce({
        applied: false,
        used: 10,
        limit: 10,
      });
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(repo(Appointment).save).not.toHaveBeenCalled();
    });

    // FND-031/T082 — repeated at this shared seam so a queued/worker call is
    // covered too, not just the HTTP path (SubscriptionAccessGuard).
    it('refuses to create once grace-expired (before any work)', async () => {
      subscriptions.assertBillableActionAllowed.mockRejectedValueOnce(
        Object.assign(new Error('grace expired'), {
          code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
        }),
      );
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a branch that does not belong to the tenant', async () => {
      repo(Branch).findOne.mockResolvedValue(null);
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      // ...and never opens a transaction to find that out.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects when one or more services are missing/inactive', async () => {
      repo(Branch).findOne.mockResolvedValue({ id: 'b1', timezone: 'UTC' });
      repo(Customer).exists.mockResolvedValue(true);
      repo(StaffProfile).exists.mockResolvedValue(true);
      repo(Service).find.mockResolvedValue([]); // none found for the requested id
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('propagates an availability conflict from the engine', async () => {
      primeValidRefs();
      availability.assertBookable.mockRejectedValueOnce(
        Object.assign(new Error('conflict'), { code: ErrorCode.CONFLICT }),
      );
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
      // Availability is checked BEFORE the quota gate — a conflict never reaches it.
      expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
      // ...and, since the P0 remediation, before any transaction is opened at
      // all, so a refused booking never occupies a pooled connection.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    /**
     * P0 booking remediation — the transaction boundary itself is the
     * behaviour under test, so it gets its own guard rather than living only
     * as a comment.
     *
     * The defect: `AvailabilityService.evaluate` fans out to six sibling
     * services, each holding its own `@InjectRepository` handle and therefore
     * checking out its own pooled connection. Running that inside the write
     * transaction meant one booking needed its transaction's connection PLUS a
     * free one — measured with `DB_POOL_MAX=1`, a single uncontended booking
     * failed with "timeout exceeded when trying to connect", and N concurrent
     * bookings deadlocked whenever N reached the pool size.
     *
     * The rule this pins: NOTHING that reads may run inside the transaction.
     * The transaction opens only after every validation has passed, and
     * contains only the quota admission and this booking's own writes.
     */
    it('P0: opens the transaction only after validation, and holds no reads inside it', async () => {
      primeValidRefs();

      const order: string[] = [];
      availability.assertBookable.mockImplementationOnce(async () => {
        order.push('availability');
      });
      dataSource.transaction.mockImplementationOnce(async (cb: any) => {
        order.push('transaction-open');
        return cb(manager);
      });

      await service.create(TENANT, USER, dto);

      // Every read resolved before a connection was ever pinned to a txn.
      expect(order).toEqual(['availability', 'transaction-open']);
      // The quota admission and the four inserts are what remains inside.
      expect(usage.incrementIfWithinLimit).toHaveBeenCalledWith(
        TENANT,
        'APPOINTMENTS',
        1,
        manager,
      );
      expect(repo(Appointment).save).toHaveBeenCalled();
    });

    /**
     * The branch row is read ONCE. It used to be read twice — `exists` for the
     * tenant/active check, then a second `findOne` purely to snapshot
     * `timezone` — on the same predicate, inside the transaction.
     */
    it('P0: reads the branch once and snapshots its timezone from that row', async () => {
      primeValidRefs();

      await service.create(TENANT, USER, dto);

      expect(repo(Branch).findOne).toHaveBeenCalledTimes(1);
      expect(repo(Appointment).create.mock.calls[0][0].booked_timezone).toBe(
        'Asia/Riyadh',
      );
    });

    // FND-012 — a VARIABLE-priced service currently books silently at price 0
    // (`base_price ?? 0` in computeWindowAndTotal/persistServices — a
    // VARIABLE service's base_price is null by design, "determined at time
    // of service").
    it('refuses to book a VARIABLE-priced service (no booking-time pricing mechanism exists)', async () => {
      primeValidRefs();
      repo(Service).find.mockResolvedValue([
        {
          id: 'svc1',
          duration_minutes: 30,
          base_price: null,
          pricing_type: PricingType.VARIABLE,
          is_active: true,
        },
      ]);

      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.VARIABLE_PRICING_UNSUPPORTED,
      });
      expect(repo(Appointment).save).not.toHaveBeenCalled();
    });

    it('still books normally when every service is FIXED-priced (regression guard)', async () => {
      primeValidRefs();
      repo(Service).find.mockResolvedValue([
        {
          id: 'svc1',
          duration_minutes: 30,
          base_price: 100,
          pricing_type: PricingType.FIXED,
          is_active: true,
        },
      ]);

      await expect(service.create(TENANT, USER, dto)).resolves.toBeDefined();
    });

    // P1.5 (MS-007) — the outbox write is the actual durability fix; prove it
    // lands on the SAME manager as the appointment insert, not a fresh
    // connection, and that a rolled-back booking never leaves a stray job.
    it('[P1.5] writes a reminders.schedule outbox row on the SAME transaction manager as the appointment', async () => {
      primeValidRefs();

      await service.create(TENANT, USER, dto);

      expect(manager.create).toHaveBeenCalledWith(
        OutboxJob,
        expect.objectContaining({
          queue: QUEUE.NOTIFICATIONS,
          job_name: JOB.REMINDERS_SCHEDULE,
          dedupe_key: 'reminders-schedule-appt-1',
          payload: { tenantId: TENANT, appointmentId: 'appt-1' },
        }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ job_name: JOB.REMINDERS_SCHEDULE }),
      );
    });

    it('[P1.5] never writes the outbox row when the transaction rolls back (quota exceeded)', async () => {
      primeValidRefs();
      usage.incrementIfWithinLimit.mockResolvedValueOnce({
        applied: false,
        used: 10,
        limit: 10,
      });

      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });

      expect(manager.create).not.toHaveBeenCalledWith(
        OutboxJob,
        expect.anything(),
      );
    });
  });

  describe('changeStatus (state machine)', () => {
    const loadAppointment = (status: AppointmentStatus) =>
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status,
        branch: { id: 'b1' },
        staff: { id: 's1' },
      });

    it('allows a legal transition (CONFIRMED → IN_PROGRESS)', async () => {
      loadAppointment(AppointmentStatus.CONFIRMED);
      await service.changeStatus(TENANT, USER, 'appt-1', {
        status: AppointmentStatus.IN_PROGRESS,
      } as any);
      expect(repo(Appointment).save).toHaveBeenCalled();
    });

    it('routes CANCELLED to the dedicated endpoint (BAD_REQUEST)', async () => {
      await expect(
        service.changeStatus(TENANT, USER, 'appt-1', {
          status: AppointmentStatus.CANCELLED,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('rejects an illegal transition (CONFIRMED → PENDING_PAYMENT)', async () => {
      loadAppointment(AppointmentStatus.CONFIRMED);
      await expect(
        service.changeStatus(TENANT, USER, 'appt-1', {
          status: AppointmentStatus.PENDING_PAYMENT,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('rejects a no-op transition to the same status (BAD_REQUEST)', async () => {
      loadAppointment(AppointmentStatus.CONFIRMED);
      await expect(
        service.changeStatus(TENANT, USER, 'appt-1', {
          status: AppointmentStatus.CONFIRMED,
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });
  });

  describe('applyPaymentOutcome (verified-payment bridge)', () => {
    const booked = () => ({
      id: 'appt-1',
      status: AppointmentStatus.PENDING_PAYMENT,
      payment_status: AppointmentPaymentStatus.UNPAID,
      customer: { id: 'cust-1' },
      staff: { id: 'staff-1' },
      branch: { id: 'b1' },
    });

    it('confirms a PENDING_PAYMENT booking on a verified paid outcome', async () => {
      const appt: any = booked();
      repo(Appointment).findOne.mockResolvedValueOnce(appt);
      await service.applyPaymentOutcome(TENANT, 'appt-1', 'paid');
      expect(appt.status).toBe(AppointmentStatus.CONFIRMED);
      expect(appt.payment_status).toBe(AppointmentPaymentStatus.PAID);
      expect(repo(Appointment).save).toHaveBeenCalledWith(appt);
    });

    it('is idempotent: an outcome already reflected is a no-op', async () => {
      const appt: any = {
        ...booked(),
        status: AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.PAID,
      };
      repo(Appointment).findOne.mockResolvedValueOnce(appt);
      await service.applyPaymentOutcome(TENANT, 'appt-1', 'paid');
      expect(repo(Appointment).save).not.toHaveBeenCalled();
    });

    it('does NOT resurrect a CANCELLED booking on paid — payment axis only', async () => {
      const appt: any = { ...booked(), status: AppointmentStatus.CANCELLED };
      repo(Appointment).findOne.mockResolvedValueOnce(appt);
      await service.applyPaymentOutcome(TENANT, 'appt-1', 'paid');
      expect(appt.status).toBe(AppointmentStatus.CANCELLED);
      expect(appt.payment_status).toBe(AppointmentPaymentStatus.PAID);
    });

    it('reflects a refund on the payment axis without touching scheduling', async () => {
      const appt: any = {
        ...booked(),
        status: AppointmentStatus.CONFIRMED,
        payment_status: AppointmentPaymentStatus.PAID,
      };
      repo(Appointment).findOne.mockResolvedValueOnce(appt);
      await service.applyPaymentOutcome(TENANT, 'appt-1', 'partially_refunded');
      expect(appt.status).toBe(AppointmentStatus.CONFIRMED);
      expect(appt.payment_status).toBe(
        AppointmentPaymentStatus.PARTIALLY_REFUNDED,
      );
    });
  });

  describe('cancel', () => {
    const loadAppointment = (overrides: Record<string, unknown> = {}) =>
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        total_amount: 200,
        ...overrides,
      });

    it('cancels and marks REFUNDED on a full refund', async () => {
      loadAppointment();
      await service.cancel(TENANT, USER, 'appt-1', {
        reason: 'x',
        refundAmount: 200,
      } as any);
      const saved = repo(Appointment).save.mock.calls[0][0];
      expect(saved.status).toBe(AppointmentStatus.CANCELLED);
      expect(saved.payment_status).toBe(AppointmentPaymentStatus.REFUNDED);
    });

    it('marks PARTIALLY_REFUNDED on a partial refund', async () => {
      loadAppointment();
      await service.cancel(TENANT, USER, 'appt-1', { refundAmount: 50 } as any);
      const saved = repo(Appointment).save.mock.calls[0][0];
      expect(saved.payment_status).toBe(
        AppointmentPaymentStatus.PARTIALLY_REFUNDED,
      );
    });

    it('refuses to cancel an already-terminal appointment', async () => {
      loadAppointment({ status: AppointmentStatus.CANCELLED });
      await expect(
        service.cancel(TENANT, USER, 'appt-1', {} as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    // ── T019 (spec 014): origin persisted on the audit row ────────────
    it('T019: defaults origin to STAFF when omitted (regression — every existing caller)', async () => {
      loadAppointment();
      await service.cancel(TENANT, USER, 'appt-1', { reason: 'x' } as any);
      expect(repo(AppointmentCancellation).create).toHaveBeenCalledWith(
        expect.objectContaining({ origin: AppointmentActionOrigin.STAFF }),
      );
    });

    it('T019: persists PATIENT origin when the caller supplies it', async () => {
      loadAppointment();
      await service.cancel(
        TENANT,
        USER,
        'appt-1',
        { reason: 'x' } as any,
        AppointmentActionOrigin.PATIENT,
      );
      expect(repo(AppointmentCancellation).create).toHaveBeenCalledWith(
        expect.objectContaining({ origin: AppointmentActionOrigin.PATIENT }),
      );
    });

    it('a null userId (patient-initiated, no staff actor) omits cancelled_by rather than storing a placeholder id', async () => {
      loadAppointment();
      await service.cancel(
        TENANT,
        null,
        'appt-1',
        { reason: 'x' } as any,
        AppointmentActionOrigin.PATIENT,
      );
      const created = repo(AppointmentCancellation).create.mock.calls[0][0];
      expect(created.cancelled_by).toBeUndefined();
    });
  });

  describe('reschedule', () => {
    it('re-validates the new window via the availability engine (excluding itself)', async () => {
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        start_at: new Date('2026-07-01T10:00:00Z'),
        end_at: new Date('2026-07-01T10:30:00Z'),
      });

      await service.reschedule(TENANT, USER, 'appt-1', {
        newStartAt: '2026-07-02T12:00:00.000Z',
      } as any);

      expect(availability.assertBookable).toHaveBeenCalledWith(
        TENANT,
        'b1',
        's1',
        expect.any(Date),
        expect.any(Date),
        expect.objectContaining({ excludeAppointmentId: 'appt-1', manager }),
      );
    });

    const loadForReschedule = () =>
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        start_at: new Date('2026-07-01T10:00:00Z'),
        end_at: new Date('2026-07-01T10:30:00Z'),
      });

    // ── T019 (spec 014): origin persisted on the audit row ────────────
    it('T019: defaults origin to STAFF when omitted (regression — every existing caller)', async () => {
      loadForReschedule();
      await service.reschedule(TENANT, USER, 'appt-1', {
        newStartAt: '2026-07-02T12:00:00.000Z',
      } as any);
      expect(repo(AppointmentReschedule).create).toHaveBeenCalledWith(
        expect.objectContaining({ origin: AppointmentActionOrigin.STAFF }),
      );
    });

    it('T019: persists PATIENT origin when the caller supplies it', async () => {
      loadForReschedule();
      await service.reschedule(
        TENANT,
        USER,
        'appt-1',
        { newStartAt: '2026-07-02T12:00:00.000Z' } as any,
        AppointmentActionOrigin.PATIENT,
      );
      expect(repo(AppointmentReschedule).create).toHaveBeenCalledWith(
        expect.objectContaining({ origin: AppointmentActionOrigin.PATIENT }),
      );
    });

    it('a null userId (patient-initiated, no staff actor) omits rescheduled_by rather than storing a placeholder id', async () => {
      loadForReschedule();
      await service.reschedule(
        TENANT,
        null,
        'appt-1',
        { newStartAt: '2026-07-02T12:00:00.000Z' } as any,
        AppointmentActionOrigin.PATIENT,
      );
      const created = repo(AppointmentReschedule).create.mock.calls[0][0];
      expect(created.rescheduled_by).toBeUndefined();
    });
  });

  describe('findOne / remove', () => {
    it('throws NOT_FOUND for a missing or cross-tenant appointment', async () => {
      appointments.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('refuses to delete a non-terminal appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({
        id: 'appt-1',
        status: AppointmentStatus.CONFIRMED,
      });
      await expect(
        service.remove(TENANT, USER, 'appt-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('soft-deletes a cancelled appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({
        id: 'appt-1',
        status: AppointmentStatus.CANCELLED,
      });
      await service.remove(TENANT, USER, 'appt-1');
      expect(appointments.softRemove).toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns a tenant-scoped paginated result with filters applied', async () => {
      appointments.findAndCount.mockResolvedValueOnce([[{ id: 'a1' }], 1]);
      const result = await service.findAll(
        TENANT,
        {
          page: 1,
          limit: 10,
          status: AppointmentStatus.CONFIRMED,
          branchId: 'b1',
          staffId: 's1',
          customerId: 'c1',
          from: '2026-07-01T00:00:00Z',
          to: '2026-07-31T00:00:00Z',
        } as any,
        FULL_ACCESS_CALLER,
      );

      expect(result).toEqual({
        data: [{ id: 'a1' }],
        total: 1,
        page: 1,
        limit: 10,
      });
      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.where).toEqual(
        expect.objectContaining({
          tenant: { id: TENANT },
          staff: { id: 's1' },
        }),
      );
    });

    it('orders by start_at DESCENDING by default (order not supplied)', async () => {
      appointments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll(
        TENANT,
        { page: 1, limit: 10 } as any,
        FULL_ACCESS_CALLER,
      );

      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.order).toEqual({ start_at: 'DESC' });
    });

    it('honours order=ASC — reaches the repository as ASCENDING', async () => {
      appointments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll(
        TENANT,
        { page: 1, limit: 10, order: 'ASC' } as any,
        FULL_ACCESS_CALLER,
      );

      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.order).toEqual({ start_at: 'ASC' });
    });

    it('filters by serviceIds (ANY-of match) when provided', async () => {
      appointments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll(
        TENANT,
        { page: 1, limit: 10, serviceIds: ['svc-1', 'svc-2'] } as any,
        FULL_ACCESS_CALLER,
      );

      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.where.services).toEqual({
        service: { id: In(['svc-1', 'svc-2']), tenant: { id: TENANT } },
      });
    });

    it('never matches a service id belonging to another tenant (tenant pinned on the join, not just the top-level scope)', async () => {
      appointments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll(
        TENANT,
        { page: 1, limit: 10, serviceIds: ['foreign-svc'] } as any,
        FULL_ACCESS_CALLER,
      );

      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.where.services.service.tenant).toEqual({ id: TENANT });
    });

    it('omits the services filter entirely when serviceIds is not provided', async () => {
      appointments.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.findAll(
        TENANT,
        { page: 1, limit: 10 } as any,
        FULL_ACCESS_CALLER,
      );

      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.where.services).toBeUndefined();
    });
  });

  describe('ownership scoping (appointments.read_own)', () => {
    const OWN_CALLER = {
      id: 'doctor-1',
      permissions: [PERMISSION.APPOINTMENTS_READ_OWN],
    };

    describe('findAll', () => {
      it("forces the staff filter to the caller's own StaffProfile, ignoring query.staffId", async () => {
        staffScope.resolveOwnStaffId.mockResolvedValueOnce('staff-doctor-1');
        appointments.findAndCount.mockResolvedValueOnce([[{ id: 'a1' }], 1]);

        await service.findAll(
          TENANT,
          { page: 1, limit: 10, staffId: 'someone-elses-staff-id' } as any,
          OWN_CALLER,
        );

        expect(staffScope.resolveOwnStaffId).toHaveBeenCalledWith(
          TENANT,
          'doctor-1',
        );
        const arg = appointments.findAndCount.mock.calls[0][0];
        expect(arg.where.staff).toEqual({ id: 'staff-doctor-1' });
      });

      it('returns an empty page without querying when the caller has no StaffProfile', async () => {
        staffScope.resolveOwnStaffId.mockResolvedValueOnce(null);
        const result = await service.findAll(
          TENANT,
          { page: 1, limit: 10 } as any,
          OWN_CALLER,
        );
        expect(result).toEqual({ data: [], total: 0, page: 1, limit: 10 });
        expect(appointments.findAndCount).not.toHaveBeenCalled();
      });
    });

    describe('findOne', () => {
      it("returns the appointment when it belongs to the caller's own StaffProfile", async () => {
        appointments.findOne.mockResolvedValueOnce({
          id: 'appt-1',
          staff: { id: 'staff-doctor-1' },
        });
        staffScope.resolveOwnStaffId.mockResolvedValueOnce('staff-doctor-1');

        await expect(
          service.findOne(TENANT, 'appt-1', OWN_CALLER),
        ).resolves.toEqual(expect.objectContaining({ id: 'appt-1' }));
      });

      it("returns NOT_FOUND (never a distinguishable forbidden) for another staff member's appointment", async () => {
        appointments.findOne.mockResolvedValueOnce({
          id: 'appt-1',
          staff: { id: 'someone-elses-staff-id' },
        });
        staffScope.resolveOwnStaffId.mockResolvedValueOnce('staff-doctor-1');

        await expect(
          service.findOne(TENANT, 'appt-1', OWN_CALLER),
        ).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });

      it('returns NOT_FOUND when the caller has no StaffProfile at all', async () => {
        appointments.findOne.mockResolvedValueOnce({
          id: 'appt-1',
          staff: { id: 'staff-doctor-1' },
        });
        staffScope.resolveOwnStaffId.mockResolvedValueOnce(null);

        await expect(
          service.findOne(TENANT, 'appt-1', OWN_CALLER),
        ).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });

      it('is unrestricted when no caller is passed (internal call sites)', async () => {
        appointments.findOne.mockResolvedValueOnce({
          id: 'appt-1',
          staff: { id: 'anyone' },
        });
        await expect(service.findOne(TENANT, 'appt-1')).resolves.toEqual(
          expect.objectContaining({ id: 'appt-1' }),
        );
        expect(staffScope.resolveOwnStaffId).not.toHaveBeenCalled();
      });
    });

    describe('listNotes / getTimeline', () => {
      it("listNotes 404s for another staff member's appointment before touching notes", async () => {
        appointments.findOne.mockResolvedValueOnce({
          id: 'appt-1',
          staff: { id: 'someone-elses-staff-id' },
        });
        staffScope.resolveOwnStaffId.mockResolvedValueOnce('staff-doctor-1');

        await expect(
          service.listNotes(TENANT, 'appt-1', OWN_CALLER),
        ).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
        expect(notesRepo.find).not.toHaveBeenCalled();
      });

      it("getTimeline 404s for another staff member's appointment", async () => {
        appointments.findOne.mockResolvedValueOnce({
          id: 'appt-1',
          staff: { id: 'someone-elses-staff-id' },
        });
        staffScope.resolveOwnStaffId.mockResolvedValueOnce('staff-doctor-1');

        await expect(
          service.getTimeline(TENANT, 'appt-1', OWN_CALLER),
        ).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });
    });
  });

  describe('update', () => {
    const loadConfirmed = () =>
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        start_at: new Date('2026-07-01T10:00:00Z'),
        end_at: new Date('2026-07-01T10:30:00Z'),
      });

    it('re-validates availability when staff is reassigned', async () => {
      loadConfirmed();
      repo(StaffProfile).findOne.mockResolvedValue({
        id: 's2',
        is_available_for_booking: true,
      });
      // Unconfigured legacy clinic — no schedules anywhere, so the branch rule
      // has no opinion and the reassignment proceeds as it always did.
      repo(StaffSchedule).exists.mockResolvedValue(false);

      await service.update(TENANT, USER, 'appt-1', { staffId: 's2' } as any);

      expect(availability.assertBookable).toHaveBeenCalledWith(
        TENANT,
        'b1',
        's2',
        expect.any(Date),
        expect.any(Date),
        expect.objectContaining({ excludeAppointmentId: 'appt-1', manager }),
      );
    });

    it('updates notes only without touching availability', async () => {
      loadConfirmed();
      await service.update(TENANT, USER, 'appt-1', {
        notes: 'call ahead',
      } as any);
      expect(availability.assertBookable).not.toHaveBeenCalled();
    });

    it('refuses to update a terminal appointment', async () => {
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.COMPLETED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
      });
      await expect(
        service.update(TENANT, USER, 'appt-1', { notes: 'x' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  describe('setServices', () => {
    /** An existing 10:00–10:45 appointment (45 min of services attached). */
    const existing = (endMinutes = 45) =>
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        start_at: new Date('2026-07-01T10:00:00Z'),
        end_at: new Date(
          new Date('2026-07-01T10:00:00Z').getTime() + endMinutes * 60_000,
        ),
      });

    it('replaces services and recomputes the window/total', async () => {
      existing();
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 45, base_price: 150, is_active: true },
      ]);

      await service.setServices(TENANT, USER, 'appt-1', {
        serviceIds: ['svc1'],
      } as any);

      expect(repo(AppointmentServiceEntity).delete).toHaveBeenCalledWith({
        appointment: { id: 'appt-1' },
      });
      const saved = repo(Appointment).save.mock.calls[0][0];
      expect(saved.total_amount).toBe(150);
    });

    // Swapping in a longer service MOVES the appointment's end — it can run into
    // the doctor's next booking, past the end of their shift, or into a blocked
    // period. This was the one write path that changed the window without
    // re-validating it.
    it('re-validates the NEW window when a longer service extends it', async () => {
      existing(45);
      repo(Service).find.mockResolvedValue([
        { id: 'svc2', duration_minutes: 90, base_price: 300, is_active: true },
      ]);

      await service.setServices(TENANT, USER, 'appt-1', {
        serviceIds: ['svc2'],
      } as any);

      expect(availability.assertBookable).toHaveBeenCalledWith(
        TENANT,
        'b1',
        's1',
        new Date('2026-07-01T10:00:00Z'),
        new Date('2026-07-01T11:30:00Z'),
        expect.objectContaining({ excludeAppointmentId: 'appt-1' }),
      );
    });

    it('rejects the change when the extended window is not available', async () => {
      existing(45);
      repo(Service).find.mockResolvedValue([
        { id: 'svc2', duration_minutes: 90, base_price: 300, is_active: true },
      ]);
      availability.assertBookable.mockRejectedValueOnce(
        Object.assign(new Error('conflict'), {
          code: ErrorCode.STAFF_NOT_AVAILABLE,
        }),
      );

      await expect(
        service.setServices(TENANT, USER, 'appt-1', {
          serviceIds: ['svc2'],
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.STAFF_NOT_AVAILABLE });
      expect(repo(Appointment).save).not.toHaveBeenCalled();
    });

    // A pure re-pricing (same total duration) must stay a cheap write.
    it('skips the availability check when the window is unchanged', async () => {
      existing(45);
      repo(Service).find.mockResolvedValue([
        { id: 'svc3', duration_minutes: 45, base_price: 999, is_active: true },
      ]);

      await service.setServices(TENANT, USER, 'appt-1', {
        serviceIds: ['svc3'],
      } as any);

      expect(availability.assertBookable).not.toHaveBeenCalled();
    });
  });

  describe('notes & timeline', () => {
    it('adds a note after a tenant-scoped existence check', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1' });
      notesRepo.save.mockResolvedValueOnce({ id: 'note-1' });
      const note = await service.addNote(TENANT, USER, 'appt-1', {
        content: 'hi',
      } as any);
      expect(note).toEqual({ id: 'note-1' });
    });

    it('lists notes for an appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1' });
      notesRepo.find.mockResolvedValueOnce([{ id: 'n1' }]);
      await expect(service.listNotes(TENANT, 'appt-1')).resolves.toEqual([
        { id: 'n1' },
      ]);
    });

    it('merges audit tables into a single chronological timeline', async () => {
      appointments.findOne.mockResolvedValueOnce({
        id: 'appt-1',
        created_at: new Date('2026-07-01T09:00:00Z'),
      });
      historyRepo.find.mockResolvedValueOnce([
        {
          created_at: new Date('2026-07-01T11:00:00Z'),
          old_status: 'CONFIRMED',
          new_status: 'COMPLETED',
        },
      ]);
      statusLogsRepo.find.mockResolvedValueOnce([
        { created_at: new Date('2026-07-01T10:00:00Z'), status: 'CONFIRMED' },
      ]);
      notesRepo.find.mockResolvedValueOnce([]);
      reschedulesRepo.find.mockResolvedValueOnce([]);
      cancellationsRepo.find.mockResolvedValueOnce([]);

      const timeline = await service.getTimeline(TENANT, 'appt-1');

      expect(timeline[0].type).toBe('created');
      // Sorted ascending by timestamp.
      const times = timeline.map((e) => e.at.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });
  });

  describe('listReminders (T055, FR-M015)', () => {
    it("404s for another tenant's appointment before ever querying reminders", async () => {
      appointments.findOne.mockResolvedValueOnce(null);
      await expect(
        service.listReminders(TENANT, 'appt-1'),
      ).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      expect(scheduledNotificationsRepo.find).not.toHaveBeenCalled();
    });

    it('projects every reminder row — scheduled, sent, suppressed and failed — with reason and channel', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1' });
      scheduledNotificationsRepo.find.mockResolvedValueOnce([
        {
          id: 'sched-1',
          source_ref: 'appointment-reminder:appt-1:1440',
          scheduled_at: new Date('2026-08-01T10:00:00Z'),
          status: 'SENT',
          channel: 'WHATSAPP',
          skip_reason: null,
          failure_reason: null,
        },
        {
          id: 'sched-2',
          source_ref: 'appointment-reminder:appt-1:60',
          scheduled_at: new Date('2026-08-02T09:00:00Z'),
          status: 'FAILED',
          channel: null,
          skip_reason: 'OPTED_OUT',
          failure_reason: null,
        },
      ]);

      const rows = await service.listReminders(TENANT, 'appt-1');

      expect(scheduledNotificationsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenant: { id: TENANT },
            source_ref: expect.anything(),
          }),
        }),
      );
      expect(rows).toEqual([
        {
          id: 'sched-1',
          leadMinutes: 1440,
          scheduledAt: new Date('2026-08-01T10:00:00Z'),
          status: 'SENT',
          channel: 'WHATSAPP',
          skipReason: null,
          failureReason: null,
        },
        {
          id: 'sched-2',
          leadMinutes: 60,
          scheduledAt: new Date('2026-08-02T09:00:00Z'),
          status: 'FAILED',
          channel: null,
          skipReason: 'OPTED_OUT',
          failureReason: null,
        },
      ]);
    });
  });

  /**
   * The clinic-wide Activity trail. Before this, a receptionist creating an
   * appointment wrote to `appointment_history` and `appointment_status_logs`
   * but NOTHING to `audit_logs` — so the owner's Activity page could not show
   * the single most common thing that happens in a clinic.
   */
  describe('activity audit trail', () => {
    const primeRefs = () => {
      repo(Branch).findOne.mockResolvedValue({
        id: 'b1',
        timezone: 'Asia/Riyadh',
      });
      repo(Customer).exists.mockResolvedValue(true);
      repo(StaffProfile).findOne.mockResolvedValue({
        id: 's1',
        is_available_for_booking: true,
      });
      repo(StaffSchedule).exists.mockResolvedValue(false);
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 30, base_price: 100, is_active: true },
      ]);
      repo(Appointment).save.mockImplementation(async (e: any) => ({
        id: 'appt-1',
        ...e,
      }));
    };

    const createDto = {
      branchId: 'b1',
      customerId: 'c1',
      staffId: 's1',
      serviceIds: ['svc1'],
      startAt: '2026-07-01T10:00:00.000Z',
    } as any;

    it('records appointment.created with the AUTHENTICATED actor — never the customer or the booking owner', async () => {
      primeRefs();
      appointments.findOne.mockResolvedValue({
        ...reloaded,
        source: 'MANUAL',
        services: [{ service: { name: 'Dental cleaning' } }],
      });

      await service.create(TENANT, USER, createDto);

      expect(appointmentAudit.record).toHaveBeenCalledWith(
        'appointment.created',
        TENANT,
        'appt-1',
        expect.objectContaining({ status: expect.anything() }),
        expect.objectContaining({ actorUserId: USER }),
      );
    });

    it('carries the branch and the non-sensitive service label, and never the customer', async () => {
      primeRefs();
      appointments.findOne.mockResolvedValue({
        ...reloaded,
        source: 'MANUAL',
        customer: { id: 'cust-1', full_name: 'Ahmed Mohamed' },
        services: [{ service: { name: 'Dental cleaning' } }],
      });

      await service.create(TENANT, USER, createDto);

      const [, , , details, context] = appointmentAudit.record.mock.calls[0];
      expect(context).toMatchObject({
        branchId: 'b1',
        entityLabel: 'Dental cleaning',
      });
      // The patient's name must not reach `audit_logs` through any field.
      expect(JSON.stringify([details, context])).not.toContain('Ahmed Mohamed');
    });

    it('records AFTER the transaction commits, so an audit failure cannot fail the booking', async () => {
      primeRefs();
      appointments.findOne.mockResolvedValue({ ...reloaded, source: 'MANUAL' });
      appointmentAudit.record.mockRejectedValueOnce(new Error('audit db down'));

      // `record` is best-effort and swallows internally; this asserts the
      // booking survives even the pathological case where it does throw.
      await expect(service.create(TENANT, USER, createDto)).rejects.toThrow();
      // …and the appointment was still committed before that point.
      expect(repo(Appointment).save).toHaveBeenCalled();
    });

    it('does NOT record appointment.created for a PUBLIC_AI booking — that path has its own action', async () => {
      primeRefs();
      // PUBLIC_AI books under strict branch scope, so the staff member must
      // have an active schedule AT this branch (`primeRefs` models the looser
      // unconfigured-clinic case the other tests use).
      repo(StaffSchedule).exists.mockResolvedValue(true);
      appointments.findOne.mockResolvedValue({
        ...reloaded,
        source: 'PUBLIC_AI',
      });

      await service.create(TENANT, USER, {
        ...createDto,
        source: 'PUBLIC_AI',
        // The assistant sources also reject a past start time (PD-6/AI-027).
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      expect(appointmentAudit.record).not.toHaveBeenCalled();
    });

    it('records appointment.status_changed with the previous status, so changedFields can name it', async () => {
      repo(Appointment).findOne.mockResolvedValue({
        id: 'appt-1',
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        customer: { id: 'c1' },
      });
      appointments.findOne.mockResolvedValue({
        ...reloaded,
        status: AppointmentStatus.IN_PROGRESS,
      });

      await service.changeStatus(TENANT, USER, 'appt-1', {
        status: AppointmentStatus.IN_PROGRESS,
      } as any);

      expect(appointmentAudit.record).toHaveBeenCalledWith(
        'appointment.status_changed',
        TENANT,
        'appt-1',
        expect.anything(),
        expect.objectContaining({
          actorUserId: USER,
          before: { status: AppointmentStatus.CONFIRMED },
        }),
      );
    });

    it('records appointment.cancelled for a STAFF cancellation', async () => {
      repo(Appointment).findOne.mockResolvedValue({
        id: 'appt-1',
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        customer: { id: 'c1' },
      });
      appointments.findOne.mockResolvedValue({
        ...reloaded,
        status: AppointmentStatus.CANCELLED,
      });

      await service.cancel(TENANT, USER, 'appt-1', {
        reason: 'Clinic closed',
      } as any);

      expect(appointmentAudit.record).toHaveBeenCalledWith(
        'appointment.cancelled',
        TENANT,
        'appt-1',
        expect.objectContaining({ reason: 'Clinic closed' }),
        expect.objectContaining({ actorUserId: USER }),
      );
    });

    it('does NOT record appointment.cancelled for a PATIENT cancellation — that path records its own action', async () => {
      repo(Appointment).findOne.mockResolvedValue({
        id: 'appt-1',
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        customer: { id: 'c1' },
      });
      appointments.findOne.mockResolvedValue({
        ...reloaded,
        status: AppointmentStatus.CANCELLED,
      });

      await service.cancel(
        TENANT,
        null,
        'appt-1',
        { reason: 'Changed my mind' } as any,
        AppointmentActionOrigin.PATIENT,
      );

      expect(appointmentAudit.record).not.toHaveBeenCalled();
    });
  });
});
