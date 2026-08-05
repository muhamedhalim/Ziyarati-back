import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AppointmentsService } from './appointment.service';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { AppointmentService as AppointmentServiceEntity } from '../../entities/Calendar&Appointments/AppointmentService';
import { AppointmentHistory } from '../../entities/Calendar&Appointments/AppointmentHistory';
import { AppointmentStatusLog } from '../../entities/Calendar&Appointments/AppointmentStatusLog';
import { AppointmentNote } from '../../entities/Calendar&Appointments/AppointmentNote';
import { AppointmentReschedule } from '../../entities/Calendar&Appointments/AppointmentReschedule';
import { AppointmentCancellation } from '../../entities/Calendar&Appointments/AppointmentCancellation';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Service, PricingType } from '../../entities/Services/Service';
import { AvailabilityService } from '../scheduling/availability.service';
import { UsageService } from '../subscription-billing/usage.service';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import {
  AppointmentStatus,
  AppointmentPaymentStatus,
} from '../../entities/enums';
import { ErrorCode } from '../../common/errors';
import { PERMISSION } from '../../rbac/rbac.constants';
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
  let usage: { assertWithinLimit: jest.Mock; increment: jest.Mock; incrementIfWithinLimit: jest.Mock };
  let subscriptions: { assertBillableActionAllowed: jest.Mock };
  let notesRepo: MockRepository;
  let historyRepo: MockRepository;
  let statusLogsRepo: MockRepository;
  let reschedulesRepo: MockRepository;
  let cancellationsRepo: MockRepository;
  let staffProfilesRepo: MockRepository;

  /** Full tenant-wide access — the default caller for existing tests. */
  const FULL_ACCESS_CALLER = { id: USER, permissions: [PERMISSION.APPOINTMENTS_READ] };

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
      incrementIfWithinLimit: jest.fn().mockResolvedValue({ applied: true, used: 0, limit: 100 }),
    };
    subscriptions = { assertBillableActionAllowed: jest.fn().mockResolvedValue(undefined) };
    notesRepo = createMockRepository();
    historyRepo = createMockRepository();
    statusLogsRepo = createMockRepository();
    reschedulesRepo = createMockRepository();
    cancellationsRepo = createMockRepository();
    staffProfilesRepo = createMockRepository();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AppointmentsService,
        { provide: getRepositoryToken(Appointment), useValue: appointments },
        { provide: getRepositoryToken(AppointmentNote), useValue: notesRepo },
        { provide: getRepositoryToken(AppointmentHistory), useValue: historyRepo },
        { provide: getRepositoryToken(AppointmentStatusLog), useValue: statusLogsRepo },
        { provide: getRepositoryToken(AppointmentReschedule), useValue: reschedulesRepo },
        { provide: getRepositoryToken(AppointmentCancellation), useValue: cancellationsRepo },
        { provide: getRepositoryToken(StaffProfile), useValue: staffProfilesRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: AvailabilityService, useValue: availability },
        { provide: UsageService, useValue: usage },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: SubscriptionService, useValue: subscriptions },
      ],
    }).compile();
    service = moduleRef.get(AppointmentsService);
  });

  afterEach(() => jest.clearAllMocks());

  // Convenience: the per-entity stable repos the service obtains via the manager.
  const repo = (entity: unknown) => manager.getRepository(entity) as unknown as MockRepository;

  describe('create', () => {
    const dto = {
      branchId: 'b1',
      customerId: 'c1',
      staffId: 's1',
      serviceIds: ['svc1'],
      startAt: '2026-07-01T10:00:00.000Z',
    } as any;

    const primeValidRefs = () => {
      repo(Branch).exists.mockResolvedValue(true);
      repo(Customer).exists.mockResolvedValue(true);
      repo(StaffProfile).exists.mockResolvedValue(true);
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 30, base_price: 100, is_active: true },
      ]);
      manager.findOne.mockResolvedValue({ id: 'b1', timezone: 'Asia/Riyadh' }); // timezone snapshot
      repo(Appointment).save.mockImplementation(async (e: any) => ({ id: 'appt-1', ...e }));
    };

    it('books through the availability engine and counts the quota atomically (success)', async () => {
      primeValidRefs();

      const result = await service.create(TENANT, USER, dto);

      // FND-034: the quota check-and-increment is now ONE atomic call, INSIDE
      // the transaction (manager passed through), after availability —
      // replacing the old assertWithinLimit-then-later-increment pair.
      expect(usage.incrementIfWithinLimit).toHaveBeenCalledWith(TENANT, 'APPOINTMENTS', 1, manager);
      expect(availability.assertBookable).toHaveBeenCalledWith(
        TENANT,
        'b1',
        's1',
        expect.any(Date),
        expect.any(Date),
        expect.objectContaining({ manager }),
      );
      // New bookings start UNPAID / PENDING_PAYMENT (the two axes are independent).
      const created = repo(Appointment).create.mock.calls[0][0];
      expect(created.status).toBe(AppointmentStatus.PENDING_PAYMENT);
      expect(created.payment_status).toBe(AppointmentPaymentStatus.UNPAID);
      expect(result).toBe(reloaded);
    });

    // FND-034: the quota check now runs INSIDE the transaction (after
    // availability, so only a genuine quota exhaustion reaches it) — a
    // rejection there rolls the transaction back, so nothing is created.
    it('rejects when the plan appointment quota is exceeded (transaction rolls back)', async () => {
      primeValidRefs();
      usage.incrementIfWithinLimit.mockResolvedValueOnce({ applied: false, used: 10, limit: 10 });
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.UNPROCESSABLE_ENTITY,
      });
      expect(repo(Appointment).save).not.toHaveBeenCalled();
    });

    // FND-031/T082 — repeated at this shared seam so a queued/worker call is
    // covered too, not just the HTTP path (SubscriptionAccessGuard).
    it('refuses to create once grace-expired (before any work)', async () => {
      subscriptions.assertBillableActionAllowed.mockRejectedValueOnce(
        Object.assign(new Error('grace expired'), { code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED }),
      );
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a branch that does not belong to the tenant', async () => {
      repo(Branch).exists.mockResolvedValue(false);
      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('rejects when one or more services are missing/inactive', async () => {
      repo(Branch).exists.mockResolvedValue(true);
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
    });

    // FND-012 — a VARIABLE-priced service currently books silently at price 0
    // (`base_price ?? 0` in computeWindowAndTotal/persistServices — a
    // VARIABLE service's base_price is null by design, "determined at time
    // of service").
    it('refuses to book a VARIABLE-priced service (no booking-time pricing mechanism exists)', async () => {
      repo(Branch).exists.mockResolvedValue(true);
      repo(Customer).exists.mockResolvedValue(true);
      repo(StaffProfile).exists.mockResolvedValue(true);
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 30, base_price: null, pricing_type: PricingType.VARIABLE, is_active: true },
      ]);

      await expect(service.create(TENANT, USER, dto)).rejects.toMatchObject({
        code: ErrorCode.VARIABLE_PRICING_UNSUPPORTED,
      });
      expect(repo(Appointment).save).not.toHaveBeenCalled();
    });

    it('still books normally when every service is FIXED-priced (regression guard)', async () => {
      primeValidRefs();
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 30, base_price: 100, pricing_type: PricingType.FIXED, is_active: true },
      ]);

      await expect(service.create(TENANT, USER, dto)).resolves.toBeDefined();
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
        service.changeStatus(TENANT, USER, 'appt-1', { status: AppointmentStatus.CANCELLED } as any),
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
        service.changeStatus(TENANT, USER, 'appt-1', { status: AppointmentStatus.CONFIRMED } as any),
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
      expect(appt.payment_status).toBe(AppointmentPaymentStatus.PARTIALLY_REFUNDED);
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
      await service.cancel(TENANT, USER, 'appt-1', { reason: 'x', refundAmount: 200 } as any);
      const saved = repo(Appointment).save.mock.calls[0][0];
      expect(saved.status).toBe(AppointmentStatus.CANCELLED);
      expect(saved.payment_status).toBe(AppointmentPaymentStatus.REFUNDED);
    });

    it('marks PARTIALLY_REFUNDED on a partial refund', async () => {
      loadAppointment();
      await service.cancel(TENANT, USER, 'appt-1', { refundAmount: 50 } as any);
      const saved = repo(Appointment).save.mock.calls[0][0];
      expect(saved.payment_status).toBe(AppointmentPaymentStatus.PARTIALLY_REFUNDED);
    });

    it('refuses to cancel an already-terminal appointment', async () => {
      loadAppointment({ status: AppointmentStatus.CANCELLED });
      await expect(
        service.cancel(TENANT, USER, 'appt-1', {} as any),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
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
  });

  describe('findOne / remove', () => {
    it('throws NOT_FOUND for a missing or cross-tenant appointment', async () => {
      appointments.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(TENANT, 'nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('refuses to delete a non-terminal appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', status: AppointmentStatus.CONFIRMED });
      await expect(service.remove(TENANT, USER, 'appt-1')).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('soft-deletes a cancelled appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', status: AppointmentStatus.CANCELLED });
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

      expect(result).toEqual({ data: [{ id: 'a1' }], total: 1, page: 1, limit: 10 });
      const arg = appointments.findAndCount.mock.calls[0][0];
      expect(arg.where).toEqual(
        expect.objectContaining({ tenant: { id: TENANT }, staff: { id: 's1' } }),
      );
    });
  });

  describe('ownership scoping (appointments.read_own)', () => {
    const OWN_CALLER = { id: 'doctor-1', permissions: [PERMISSION.APPOINTMENTS_READ_OWN] };

    describe('findAll', () => {
      it('forces the staff filter to the caller\'s own StaffProfile, ignoring query.staffId', async () => {
        staffProfilesRepo.findOne.mockResolvedValueOnce({ id: 'staff-doctor-1' });
        appointments.findAndCount.mockResolvedValueOnce([[{ id: 'a1' }], 1]);

        await service.findAll(
          TENANT,
          { page: 1, limit: 10, staffId: 'someone-elses-staff-id' } as any,
          OWN_CALLER,
        );

        expect(staffProfilesRepo.findOne).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { user: { id: 'doctor-1' }, tenant: { id: TENANT } },
          }),
        );
        const arg = appointments.findAndCount.mock.calls[0][0];
        expect(arg.where.staff).toEqual({ id: 'staff-doctor-1' });
      });

      it('returns an empty page without querying when the caller has no StaffProfile', async () => {
        staffProfilesRepo.findOne.mockResolvedValueOnce(null);
        const result = await service.findAll(TENANT, { page: 1, limit: 10 } as any, OWN_CALLER);
        expect(result).toEqual({ data: [], total: 0, page: 1, limit: 10 });
        expect(appointments.findAndCount).not.toHaveBeenCalled();
      });
    });

    describe('findOne', () => {
      it('returns the appointment when it belongs to the caller\'s own StaffProfile', async () => {
        appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', staff: { id: 'staff-doctor-1' } });
        staffProfilesRepo.findOne.mockResolvedValueOnce({ id: 'staff-doctor-1' });

        await expect(service.findOne(TENANT, 'appt-1', OWN_CALLER)).resolves.toEqual(
          expect.objectContaining({ id: 'appt-1' }),
        );
      });

      it('returns NOT_FOUND (never a distinguishable forbidden) for another staff member\'s appointment', async () => {
        appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', staff: { id: 'someone-elses-staff-id' } });
        staffProfilesRepo.findOne.mockResolvedValueOnce({ id: 'staff-doctor-1' });

        await expect(service.findOne(TENANT, 'appt-1', OWN_CALLER)).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });

      it('returns NOT_FOUND when the caller has no StaffProfile at all', async () => {
        appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', staff: { id: 'staff-doctor-1' } });
        staffProfilesRepo.findOne.mockResolvedValueOnce(null);

        await expect(service.findOne(TENANT, 'appt-1', OWN_CALLER)).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
      });

      it('is unrestricted when no caller is passed (internal call sites)', async () => {
        appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', staff: { id: 'anyone' } });
        await expect(service.findOne(TENANT, 'appt-1')).resolves.toEqual(
          expect.objectContaining({ id: 'appt-1' }),
        );
        expect(staffProfilesRepo.findOne).not.toHaveBeenCalled();
      });
    });

    describe('listNotes / getTimeline', () => {
      it('listNotes 404s for another staff member\'s appointment before touching notes', async () => {
        appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', staff: { id: 'someone-elses-staff-id' } });
        staffProfilesRepo.findOne.mockResolvedValueOnce({ id: 'staff-doctor-1' });

        await expect(service.listNotes(TENANT, 'appt-1', OWN_CALLER)).rejects.toMatchObject({
          code: ErrorCode.NOT_FOUND,
        });
        expect(notesRepo.find).not.toHaveBeenCalled();
      });

      it('getTimeline 404s for another staff member\'s appointment', async () => {
        appointments.findOne.mockResolvedValueOnce({ id: 'appt-1', staff: { id: 'someone-elses-staff-id' } });
        staffProfilesRepo.findOne.mockResolvedValueOnce({ id: 'staff-doctor-1' });

        await expect(service.getTimeline(TENANT, 'appt-1', OWN_CALLER)).rejects.toMatchObject({
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
      repo(StaffProfile).exists.mockResolvedValue(true);

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
      await service.update(TENANT, USER, 'appt-1', { notes: 'call ahead' } as any);
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
    it('replaces services and recomputes the window/total', async () => {
      repo(Appointment).findOne.mockResolvedValueOnce({
        id: 'appt-1',
        tenant: { id: TENANT },
        status: AppointmentStatus.CONFIRMED,
        branch: { id: 'b1' },
        staff: { id: 's1' },
        start_at: new Date('2026-07-01T10:00:00Z'),
      });
      repo(Service).find.mockResolvedValue([
        { id: 'svc1', duration_minutes: 45, base_price: 150, is_active: true },
      ]);

      await service.setServices(TENANT, USER, 'appt-1', { serviceIds: ['svc1'] } as any);

      expect(repo(AppointmentServiceEntity).delete).toHaveBeenCalledWith({
        appointment: { id: 'appt-1' },
      });
      const saved = repo(Appointment).save.mock.calls[0][0];
      expect(saved.total_amount).toBe(150);
    });
  });

  describe('notes & timeline', () => {
    it('adds a note after a tenant-scoped existence check', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1' });
      notesRepo.save.mockResolvedValueOnce({ id: 'note-1' });
      const note = await service.addNote(TENANT, USER, 'appt-1', { content: 'hi' } as any);
      expect(note).toEqual({ id: 'note-1' });
    });

    it('lists notes for an appointment', async () => {
      appointments.findOne.mockResolvedValueOnce({ id: 'appt-1' });
      notesRepo.find.mockResolvedValueOnce([{ id: 'n1' }]);
      await expect(service.listNotes(TENANT, 'appt-1')).resolves.toEqual([{ id: 'n1' }]);
    });

    it('merges audit tables into a single chronological timeline', async () => {
      appointments.findOne.mockResolvedValueOnce({
        id: 'appt-1',
        created_at: new Date('2026-07-01T09:00:00Z'),
      });
      historyRepo.find.mockResolvedValueOnce([
        { created_at: new Date('2026-07-01T11:00:00Z'), old_status: 'CONFIRMED', new_status: 'COMPLETED' },
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
});
