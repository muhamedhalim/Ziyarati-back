import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

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
import { StaffSchedule } from '../../entities/Staff/StaffSchedule';
import { Service, PricingType } from '../../entities/Services/Service';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';

import {
  AppointmentSource,
  AppointmentStatus,
  AppointmentPaymentStatus,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { AvailabilityService } from '../scheduling/availability.service';
import { UsageService } from '../subscription-billing/usage.service';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import { PERMISSION } from '../../rbac/rbac.constants';

/** Authenticated principal's identity + permission set — enough to apply ownership scoping. */
export interface AppointmentCaller {
  id: string;
  permissions: string[];
}

import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { QueryAppointmentsDto } from './dto/query-appointments.dto';
import { ChangeAppointmentStatusDto } from './dto/change-appointment-status.dto';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { AddAppointmentNoteDto } from './dto/add-appointment-note.dto';
import { SetAppointmentServicesDto } from './dto/set-appointment-services.dto';
import {
  AppointmentCancelledEvent,
  AppointmentCompletedEvent,
  AppointmentConfirmedEvent,
  AppointmentCreatedEvent,
  AppointmentInProgressEvent,
  AppointmentNoShowEvent,
  AppointmentRescheduledEvent,
  AppointmentUpdatedEvent,
} from '../../events/appointment.events';

/** Terminal statuses — no further lifecycle transitions are permitted. */
const TERMINAL_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

/**
 * Allowed status transitions (the appointment lifecycle state-machine).
 * `RESCHEDULED` is reachable only through the reschedule flow, not changeStatus.
 */
const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  [AppointmentStatus.PENDING_PAYMENT]: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.CONFIRMED]: [
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.IN_PROGRESS]: [
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
  ],
  [AppointmentStatus.RESCHEDULED]: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.COMPLETED]: [],
  [AppointmentStatus.CANCELLED]: [],
  [AppointmentStatus.NO_SHOW]: [],
};

/**
 * A service together with the price that applies AT the appointment's branch —
 * from `service_prices` when the clinic has configured one there, else the
 * service's own `base_price`. Carried through window/total computation and
 * snapshotted onto `appointment_services`, so the charged amount is always
 * server-derived.
 */
interface PricedService {
  service: Service;
  price: number;
}

/** A single chronological entry in the unified appointment timeline. */
export interface TimelineEntry {
  type:
    | 'created'
    | 'status_log'
    | 'history'
    | 'note'
    | 'reschedule'
    | 'cancellation';
  at: Date;
  data: Record<string, unknown>;
}

/**
 * Appointment domain service.
 *
 * ─── TENANT ISOLATION (enforced in EVERY method) ───────────────────────────
 * `tenantId` is always supplied by the controller from the authenticated
 * principal (TenantContext) — NEVER from the request body/URL. It is applied:
 *   • on reads  → `where: { tenant: { id: tenantId } }` (and joined in QB);
 *   • on writes → every row is stamped `tenant: { id: tenantId }`;
 *   • on cross-references → branch/customer/staff/services are re-loaded with a
 *     tenant filter, so an attacker cannot attach another clinic's resources.
 * A row that belongs to another tenant simply "does not exist" (404), so there
 * is no information leak across tenants.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    @InjectRepository(AppointmentNote)
    private readonly notes: Repository<AppointmentNote>,
    @InjectRepository(AppointmentHistory)
    private readonly history: Repository<AppointmentHistory>,
    @InjectRepository(AppointmentStatusLog)
    private readonly statusLogs: Repository<AppointmentStatusLog>,
    @InjectRepository(AppointmentReschedule)
    private readonly reschedules: Repository<AppointmentReschedule>,
    @InjectRepository(AppointmentCancellation)
    private readonly cancellations: Repository<AppointmentCancellation>,
    @InjectRepository(StaffProfile)
    private readonly staffProfiles: Repository<StaffProfile>,
    private readonly dataSource: DataSource,
    /** The single availability engine: every booking path validates through it. */
    private readonly availability: AvailabilityService,
    private readonly usage: UsageService,
    private readonly emitter: EventEmitter2,
    private readonly subscriptions: SubscriptionService,
  ) {}

  // ───────────────────────────── Queries ─────────────────────────────────── //

  /**
   * Resolves the caller's own StaffProfile id in this tenant, or `null` if
   * they aren't linked to one (e.g. an Owner/Manager account with no
   * StaffProfile). Backs the `appointments.read_own` ownership scope — see
   * OWNERSHIP_SCOPED_PERMISSIONS in rbac.constants.ts. A caller with no
   * StaffProfile and only the "_own" permission legitimately owns nothing.
   */
  private async resolveCallerStaffId(
    tenantId: string,
    userId: string,
  ): Promise<string | null> {
    const profile = await this.staffProfiles.findOne({
      where: { user: { id: userId }, tenant: { id: tenantId } },
      select: { id: true },
    });
    return profile?.id ?? null;
  }

  /**
   * Paginated, tenant-scoped list with optional filters.
   *
   * `caller` drives ownership scoping: holding only `appointments.read_own`
   * (not the tenant-wide `appointments.read`) FORCES the staff filter to the
   * caller's own StaffProfile, overriding whatever `query.staffId` the client
   * sent — a doctor can never widen their own scope via the query string.
   */
  async findAll(
    tenantId: string,
    query: QueryAppointmentsDto,
    caller: AppointmentCaller,
  ) {
    const where: FindOptionsWhere<Appointment> = { tenant: { id: tenantId } };

    if (!caller.permissions.includes(PERMISSION.APPOINTMENTS_READ)) {
      const ownStaffId = await this.resolveCallerStaffId(tenantId, caller.id);
      if (!ownStaffId) {
        return { data: [], total: 0, page: query.page, limit: query.limit };
      }
      where.staff = { id: ownStaffId };
    } else if (query.staffId) {
      where.staff = { id: query.staffId };
    }

    if (query.status) where.status = query.status;
    if (query.branchId) where.branch = { id: query.branchId };
    if (query.customerId) where.customer = { id: query.customerId };

    if (query.from && query.to) {
      where.start_at = Between(new Date(query.from), new Date(query.to));
    } else if (query.from) {
      where.start_at = MoreThanOrEqual(new Date(query.from));
    } else if (query.to) {
      where.start_at = LessThan(new Date(query.to));
    }

    const [data, total] = await this.appointments.findAndCount({
      where,
      relations: {
        branch: true,
        customer: true,
        staff: true,
        services: { service: true },
      },
      order: { start_at: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Single appointment with full relations — tenant-scoped (404 otherwise).
   *
   * `caller` is optional so every INTERNAL call site (update/reschedule/
   * cancel/etc., all gated by broader permissions than `appointments.read`)
   * keeps its existing unrestricted behavior. Only the read-only controller
   * routes pass it, to additionally enforce ownership scoping: when the
   * caller holds only `appointments.read_own`, an appointment belonging to a
   * different staff member returns the SAME 404 as a cross-tenant appointment
   * — the established IDOR-safe pattern in this codebase (see StaffController
   * docs) — never a distinguishable "exists but forbidden" response.
   */
  async findOne(
    tenantId: string,
    id: string,
    caller?: AppointmentCaller,
  ): Promise<Appointment> {
    const appointment = await this.appointments.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: {
        branch: true,
        customer: true,
        staff: true,
        services: { service: true },
        booked_by: true,
      },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Appointment not found',
      });
    }

    if (caller && !caller.permissions.includes(PERMISSION.APPOINTMENTS_READ)) {
      const ownStaffId = await this.resolveCallerStaffId(tenantId, caller.id);
      if (!ownStaffId || appointment.staff?.id !== ownStaffId) {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Appointment not found',
        });
      }
    }

    return appointment;
  }

  // ───────────────────────────── Creation ────────────────────────────────── //

  async create(
    tenantId: string,
    userId: string,
    dto: CreateAppointmentDto,
  ): Promise<Appointment> {
    // FND-031: also enforced at the route level (SubscriptionAccessGuard, for
    // the HTTP path) — repeated here so a QUEUED/worker-triggered call into
    // this same seam is covered too (background paths never go through a guard).
    await this.subscriptions.assertBillableActionAllowed(tenantId);

    const created = await this.dataSource.transaction(async (manager) => {
      // All references validated within the same tenant scope AND against the
      // selected BRANCH — a service or doctor belonging to the clinic is not
      // enough, it has to be offered/working at the branch being booked.
      // Public AI bookings are additionally strict (see assertStaffAtBranch).
      const strictBranchScope = dto.source === AppointmentSource.PUBLIC_AI;
      await this.assertBranch(manager, tenantId, dto.branchId);
      await this.assertCustomer(manager, tenantId, dto.customerId);
      await this.assertStaffAtBranch(
        manager,
        tenantId,
        dto.branchId,
        dto.staffId,
        strictBranchScope,
      );
      const services = await this.loadServices(
        manager,
        tenantId,
        dto.branchId,
        dto.serviceIds,
      );

      const startAt = new Date(dto.startAt);
      const { endAt, totalAmount } = this.computeWindowAndTotal(
        startAt,
        services,
        dto.endAt,
      );
      this.assertChronological(startAt, endAt);

      // Single source of truth — validate REAL availability (working hours,
      // calendar slots, blocked periods, holidays, staff time off / active flag,
      // and existing appointment conflicts). Runs inside this transaction so the
      // double-booking check is race-safe.
      await this.availability.assertBookable(
        tenantId,
        dto.branchId,
        dto.staffId,
        startAt,
        endAt,
        { manager },
      );

      // FND-034: quota check-and-increment, atomic, INSIDE this transaction —
      // a rollback (any failure below, or a concurrent double-booking loss)
      // undoes the increment too; a second concurrent request blocks on the
      // usage row's lock until this one commits. Placed after every other
      // validation so only a genuine quota exhaustion reaches this point.
      const admission = await this.usage.incrementIfWithinLimit(
        tenantId,
        USAGE_METRIC.APPOINTMENTS,
        1,
        manager,
      );
      if (!admission.applied) {
        throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
          message: `Usage limit reached for ${USAGE_METRIC.APPOINTMENTS} (${admission.used}/${admission.limit})`,
          publicContext: {
            metric: USAGE_METRIC.APPOINTMENTS,
            used: admission.used,
            limit: admission.limit,
            requested: 1,
          },
        });
      }

      const repo = manager.getRepository(Appointment);

      // Snapshot the branch timezone so the booked local wall-time stays stable
      // even if the branch timezone is later changed.
      const branch = await manager.findOne(Branch, {
        where: { id: dto.branchId, tenant: { id: tenantId } },
        select: { id: true, timezone: true },
      });

      // Insured patients are never charged online — see AppointmentPaymentStatus.INSURANCE.
      const paymentStatus = dto.hasInsurance
        ? AppointmentPaymentStatus.INSURANCE
        : AppointmentPaymentStatus.UNPAID;

      // M-9: `status` used to be PENDING_PAYMENT unconditionally, while the only
      // automatic route to CONFIRMED is a VERIFIED payment event
      // (`applyPaymentOutcome`). So a booking with nothing to pay — insured,
      // zero total, or a clinic that doesn't collect online — waited forever for
      // a payment that could never arrive, and a staff member had to advance it
      // by hand. Now the two axes agree: if no online payment is due, the
      // booking is confirmed at creation. Insurance still never implies PAID;
      // `payment_status` stays INSURANCE.
      const paymentDue = await this.isOnlinePaymentDue(
        manager,
        tenantId,
        dto.hasInsurance === true,
        totalAmount,
      );
      const status = paymentDue
        ? AppointmentStatus.PENDING_PAYMENT
        : AppointmentStatus.CONFIRMED;

      const appointment = repo.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: dto.branchId } as Branch,
        customer: { id: dto.customerId } as Customer,
        staff: { id: dto.staffId } as StaffProfile,
        start_at: startAt,
        end_at: endAt,
        status,
        payment_status: paymentStatus,
        total_amount: totalAmount,
        currency: dto.currency ?? 'SAR',
        booked_timezone: branch?.timezone,
        notes: dto.notes,
        source: dto.source ?? AppointmentSource.MANUAL,
        booked_by: { id: userId } as User,
      });
      const saved = await repo.save(appointment);

      await this.persistServices(manager, tenantId, saved, services);
      await this.writeStatusLog(manager, tenantId, saved, status, userId);
      await this.writeHistory(
        manager,
        tenantId,
        saved,
        undefined,
        status,
        userId,
        'Appointment created',
      );

      return saved;
    });

    const appointment = await this.findOne(tenantId, created.id);
    this.emitter.emit(
      AppointmentCreatedEvent.eventName,
      new AppointmentCreatedEvent(
        tenantId,
        appointment.id,
        appointment.customer!.id,
        appointment.staff!.id,
        appointment.branch!.id,
        appointment.start_at,
      ),
    );
    return appointment;
  }

  // ───────────────────────────── Update ──────────────────────────────────── //

  /** Reassign staff/branch and edit notes. Date/time → reschedule; services → setServices. */
  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateAppointmentDto,
  ): Promise<Appointment> {
    let emittedChanges: string[] = [];
    let madeChanges = false;
    await this.dataSource.transaction(async (manager) => {
      const appointment = await this.loadForWrite(manager, tenantId, id);
      this.assertNotTerminal(appointment, 'updated');

      const changes: string[] = [];
      let availabilityAffected = false;

      if (dto.branchId && dto.branchId !== appointment.branch?.id) {
        await this.assertBranch(manager, tenantId, dto.branchId);
        appointment.branch = { id: dto.branchId } as Branch;
        changes.push('branch reassigned');
        availabilityAffected = true;
      }

      if (dto.staffId && dto.staffId !== appointment.staff?.id) {
        // Validate against the branch the appointment will END UP at — a branch
        // reassignment in the same call has already been applied above, so
        // moving both at once is checked as the pair it actually is.
        await this.assertStaffAtBranch(
          manager,
          tenantId,
          appointment.branch!.id,
          dto.staffId,
          appointment.source === AppointmentSource.PUBLIC_AI,
        );
        appointment.staff = { id: dto.staffId } as StaffProfile;
        changes.push('staff reassigned');
        availabilityAffected = true;
      } else if (
        dto.branchId &&
        dto.branchId !== undefined &&
        availabilityAffected
      ) {
        // Branch moved but staff did not: the EXISTING doctor must work at the
        // new branch, otherwise the move silently creates the exact
        // cross-branch booking this check exists to prevent.
        await this.assertStaffAtBranch(
          manager,
          tenantId,
          appointment.branch!.id,
          appointment.staff!.id,
          appointment.source === AppointmentSource.PUBLIC_AI,
        );
      }

      // Reassigning the branch or staff changes the availability context, so the
      // (new branch, new staff, current window) must be re-validated through the
      // single engine — not just the previous staff-overlap check.
      if (availabilityAffected) {
        await this.availability.assertBookable(
          tenantId,
          appointment.branch.id,
          appointment.staff.id,
          appointment.start_at,
          appointment.end_at,
          { excludeAppointmentId: appointment.id, manager },
        );
      }

      if (dto.notes !== undefined) {
        appointment.notes = dto.notes;
        changes.push('notes updated');
      }

      if (changes.length > 0) {
        await manager.getRepository(Appointment).save(appointment);
      }

      if (changes.length) {
        madeChanges = true;
        await this.writeHistory(
          manager,
          tenantId,
          appointment,
          appointment.status,
          appointment.status,
          userId,
          changes.join('; '),
        );
        emittedChanges = [...changes];
      }
    });

    const appointment = await this.findOne(tenantId, id);
    if (madeChanges) {
      this.emitter.emit(
        AppointmentUpdatedEvent.eventName,
        new AppointmentUpdatedEvent(
          tenantId,
          appointment.id,
          appointment.customer!.id,
          emittedChanges.join('; '),
        ),
      );
    }
    return appointment;
  }

  /** Replace the appointment's services and recompute duration + total. */
  async setServices(
    tenantId: string,
    userId: string,
    id: string,
    dto: SetAppointmentServicesDto,
  ): Promise<Appointment> {
    await this.dataSource.transaction(async (manager) => {
      const appointment = await this.loadForWrite(manager, tenantId, id);
      this.assertNotTerminal(appointment, 'modified');

      // Priced at the appointment's OWN branch, so replacing the service set
      // never silently re-prices it off the clinic-wide `base_price`.
      const services = await this.loadServices(
        manager,
        tenantId,
        appointment.branch!.id,
        dto.serviceIds,
      );

      // Replace set: clear existing rows for THIS appointment, then re-add.
      await manager.getRepository(AppointmentServiceEntity).delete({
        appointment: { id: appointment.id },
      });

      const { endAt, totalAmount } = this.computeWindowAndTotal(
        appointment.start_at,
        services,
      );
      this.assertChronological(appointment.start_at, endAt);

      appointment.end_at = endAt;
      appointment.total_amount = totalAmount;
      await manager.getRepository(Appointment).save(appointment);

      await this.persistServices(manager, tenantId, appointment, services);
      await this.writeHistory(
        manager,
        tenantId,
        appointment,
        appointment.status,
        appointment.status,
        userId,
        `Services updated (${services.length} service(s))`,
      );
    });

    return this.findOne(tenantId, id);
  }

  // ─────────────────────────── Status lifecycle ──────────────────────────── //

  async changeStatus(
    tenantId: string,
    userId: string,
    id: string,
    dto: ChangeAppointmentStatusDto,
  ): Promise<Appointment> {
    if (dto.status === AppointmentStatus.CANCELLED) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Use the cancel endpoint to cancel an appointment',
      });
    }

    await this.dataSource.transaction(async (manager) => {
      const appointment = await this.loadForWrite(manager, tenantId, id);
      this.assertTransition(appointment.status, dto.status);

      const previous = appointment.status;
      appointment.status = dto.status;
      await manager.getRepository(Appointment).save(appointment);

      await this.writeStatusLog(
        manager,
        tenantId,
        appointment,
        dto.status,
        userId,
      );
      await this.writeHistory(
        manager,
        tenantId,
        appointment,
        previous,
        dto.status,
        userId,
        dto.note ?? `Status changed ${previous} → ${dto.status}`,
      );
    });

    const updated = await this.findOne(tenantId, id);
    this.emitStatusEvent(tenantId, updated, dto.status);
    return updated;
  }

  // ─────────────────────────── Cancellation ──────────────────────────────── //

  async cancel(
    tenantId: string,
    userId: string,
    id: string,
    dto: CancelAppointmentDto,
  ): Promise<Appointment> {
    await this.dataSource.transaction(async (manager) => {
      const appointment = await this.loadForWrite(manager, tenantId, id);

      if (TERMINAL_STATUSES.includes(appointment.status)) {
        throw new AppError(ErrorCode.CONFLICT, {
          message: `Appointment cannot be cancelled from status "${appointment.status}"`,
        });
      }

      const previous = appointment.status;
      appointment.status = AppointmentStatus.CANCELLED;
      // Reflect a recorded refund on the payment axis.
      if (dto.refundAmount && dto.refundAmount > 0) {
        appointment.payment_status =
          appointment.total_amount &&
          dto.refundAmount < appointment.total_amount
            ? AppointmentPaymentStatus.PARTIALLY_REFUNDED
            : AppointmentPaymentStatus.REFUNDED;
      }
      await manager.getRepository(Appointment).save(appointment);

      await manager.getRepository(AppointmentCancellation).save(
        manager.getRepository(AppointmentCancellation).create({
          appointment: { id: appointment.id } as Appointment,
          tenant: { id: tenantId } as Tenant,
          reason: dto.reason,
          cancelled_by: { id: userId } as User,
          refund_amount: dto.refundAmount,
        }),
      );

      await this.writeStatusLog(
        manager,
        tenantId,
        appointment,
        AppointmentStatus.CANCELLED,
        userId,
      );
      await this.writeHistory(
        manager,
        tenantId,
        appointment,
        previous,
        AppointmentStatus.CANCELLED,
        userId,
        dto.reason ? `Cancelled: ${dto.reason}` : 'Cancelled',
      );
    });

    const cancelled = await this.findOne(tenantId, id);
    this.emitter.emit(
      AppointmentCancelledEvent.eventName,
      new AppointmentCancelledEvent(
        tenantId,
        cancelled.id,
        cancelled.customer!.id,
        dto.reason,
      ),
    );
    return cancelled;
  }

  // ─────────────────────────── Reschedule ────────────────────────────────── //

  async reschedule(
    tenantId: string,
    userId: string,
    id: string,
    dto: RescheduleAppointmentDto,
  ): Promise<Appointment> {
    await this.dataSource.transaction(async (manager) => {
      const appointment = await this.loadForWrite(manager, tenantId, id);
      this.assertNotTerminal(appointment, 'rescheduled');

      const oldStart = appointment.start_at;
      const oldEnd = appointment.end_at;
      const durationMs = oldEnd.getTime() - oldStart.getTime();

      const newStart = new Date(dto.newStartAt);
      const newEnd = dto.newEndAt
        ? new Date(dto.newEndAt)
        : new Date(newStart.getTime() + durationMs);
      this.assertChronological(newStart, newEnd);

      // Re-validate the NEW window through the single availability engine
      // (working hours, slots, blocks, holidays, time off, conflicts) inside the
      // transaction, excluding this appointment from its own occupancy check.
      await this.availability.assertBookable(
        tenantId,
        appointment.branch.id,
        appointment.staff.id,
        newStart,
        newEnd,
        { excludeAppointmentId: appointment.id, manager },
      );

      appointment.start_at = newStart;
      appointment.end_at = newEnd;
      await manager.getRepository(Appointment).save(appointment);

      // Audit row (entity carries reason + actor; slots are out of scope here).
      await manager.getRepository(AppointmentReschedule).save(
        manager.getRepository(AppointmentReschedule).create({
          appointment: { id: appointment.id } as Appointment,
          tenant: { id: tenantId } as Tenant,
          reason: dto.reason,
          rescheduled_by: { id: userId } as User,
        }),
      );

      await this.writeHistory(
        manager,
        tenantId,
        appointment,
        appointment.status,
        appointment.status,
        userId,
        `Rescheduled ${oldStart.toISOString()} → ${newStart.toISOString()}` +
          (dto.reason ? ` (${dto.reason})` : ''),
      );
    });

    const rescheduled = await this.findOne(tenantId, id);
    this.emitter.emit(
      AppointmentRescheduledEvent.eventName,
      new AppointmentRescheduledEvent(
        tenantId,
        rescheduled.id,
        rescheduled.customer!.id,
        rescheduled.start_at,
      ),
    );
    return rescheduled;
  }

  // ───────────────────────────── Notes ───────────────────────────────────── //

  async addNote(
    tenantId: string,
    userId: string,
    id: string,
    dto: AddAppointmentNoteDto,
  ): Promise<AppointmentNote> {
    // Ownership/tenant check — throws 404 if it belongs to another tenant.
    await this.findOne(tenantId, id);

    const note = this.notes.create({
      appointment: { id } as Appointment,
      tenant: { id: tenantId } as Tenant,
      user: { id: userId } as User,
      content: dto.content,
    });
    return this.notes.save(note);
  }

  async listNotes(
    tenantId: string,
    id: string,
    caller?: AppointmentCaller,
  ): Promise<AppointmentNote[]> {
    await this.findOne(tenantId, id, caller); // throws 404 if not owned & caller lacks full read
    return this.notes.find({
      where: { appointment: { id }, tenant: { id: tenantId } },
      relations: { user: true },
      order: { created_at: 'DESC' },
    });
  }

  // ───────────────────────────── Timeline ────────────────────────────────── //

  /** Unified, chronological audit trail merged from every audit table. */
  async getTimeline(
    tenantId: string,
    id: string,
    caller?: AppointmentCaller,
  ): Promise<TimelineEntry[]> {
    const appointment = await this.findOne(tenantId, id, caller);

    const scope = { appointment: { id }, tenant: { id: tenantId } } as const;

    const [history, statusLogs, notes, reschedules, cancellations] =
      await Promise.all([
        this.history.find({ where: scope, order: { created_at: 'ASC' } }),
        this.statusLogs.find({ where: scope, order: { created_at: 'ASC' } }),
        this.notes.find({
          where: scope,
          relations: { user: true },
          order: { created_at: 'ASC' },
        }),
        this.reschedules.find({
          where: scope,
          relations: { rescheduled_by: true },
          order: { created_at: 'ASC' },
        }),
        this.cancellations.find({
          where: scope,
          relations: { cancelled_by: true },
          order: { created_at: 'ASC' },
        }),
      ]);

    const entries: TimelineEntry[] = [
      {
        type: 'created',
        at: appointment.created_at,
        data: { status: AppointmentStatus.PENDING_PAYMENT },
      },
      ...history.map<TimelineEntry>((h) => ({
        type: 'history',
        at: h.created_at,
        data: {
          oldStatus: h.old_status,
          newStatus: h.new_status,
          note: h.note,
          changedBy: h.changed_by,
        },
      })),
      ...statusLogs.map<TimelineEntry>((s) => ({
        type: 'status_log',
        at: s.created_at,
        data: { status: s.status, triggeredBy: s.triggered_by },
      })),
      ...notes.map<TimelineEntry>((n) => ({
        type: 'note',
        at: n.created_at,
        data: { content: n.content, author: n.user?.id },
      })),
      ...reschedules.map<TimelineEntry>((r) => ({
        type: 'reschedule',
        at: r.created_at,
        data: { reason: r.reason, by: r.rescheduled_by?.id },
      })),
      ...cancellations.map<TimelineEntry>((c) => ({
        type: 'cancellation',
        at: c.created_at,
        data: {
          reason: c.reason,
          by: c.cancelled_by?.id,
          refundAmount: c.refund_amount,
        },
      })),
    ];

    return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  // ─────────────────── Payment outcome (system-triggered) ────────────────── //

  /**
   * Reflect a VERIFIED payment outcome on the booking. Invoked by the payment
   * domain events (webhook / verify / reconciliation) — never from client
   * input, and never from a browser redirect. Idempotent: redelivering an
   * outcome the booking already reflects is a no-op.
   *
   * 'paid' → payment axis PAID and, while the scheduling status is still
   * PENDING_PAYMENT, it advances to CONFIRMED — a booking is confirmed ONLY by
   * verified payment. Refund outcomes touch the payment axis alone (the
   * scheduling status is a business decision handled via cancel/status APIs).
   */
  async applyPaymentOutcome(
    tenantId: string,
    appointmentId: string,
    outcome: 'paid' | 'refunded' | 'partially_refunded',
    triggeredBy = 'system:payment',
  ): Promise<void> {
    const confirmed = await this.dataSource.transaction(async (manager) => {
      const appointment = await this.loadForWrite(
        manager,
        tenantId,
        appointmentId,
      );

      const targetPayment =
        outcome === 'paid'
          ? AppointmentPaymentStatus.PAID
          : outcome === 'refunded'
            ? AppointmentPaymentStatus.REFUNDED
            : AppointmentPaymentStatus.PARTIALLY_REFUNDED;

      const paymentChanged = appointment.payment_status !== targetPayment;
      const shouldConfirm =
        outcome === 'paid' &&
        appointment.status === AppointmentStatus.PENDING_PAYMENT;

      if (!paymentChanged && !shouldConfirm) return false;

      appointment.payment_status = targetPayment;
      const previous = appointment.status;
      if (shouldConfirm) appointment.status = AppointmentStatus.CONFIRMED;
      await manager.getRepository(Appointment).save(appointment);

      if (shouldConfirm) {
        await this.writeStatusLog(
          manager,
          tenantId,
          appointment,
          AppointmentStatus.CONFIRMED,
          triggeredBy,
        );
        await this.writeHistory(
          manager,
          tenantId,
          appointment,
          previous,
          AppointmentStatus.CONFIRMED,
          triggeredBy,
          'Confirmed by verified payment',
        );
      }
      return shouldConfirm;
    });

    if (confirmed) {
      const updated = await this.findOne(tenantId, appointmentId);
      this.emitStatusEvent(tenantId, updated, AppointmentStatus.CONFIRMED);
    }
  }

  // ───────────────────────────── Delete ──────────────────────────────────── //

  /**
   * Soft-delete an appointment. Only permitted for already-closed records
   * (CANCELLED / NO_SHOW) — active or completed appointments are preserved for
   * reporting and must be cancelled first.
   */
  async remove(tenantId: string, userId: string, id: string): Promise<void> {
    const appointment = await this.findOne(tenantId, id);

    if (
      appointment.status !== AppointmentStatus.CANCELLED &&
      appointment.status !== AppointmentStatus.NO_SHOW
    ) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'Only cancelled or no-show appointments can be deleted. Cancel it first.',
      });
    }

    await this.appointments.softRemove(appointment);
  }

  // ════════════════════════════ Private helpers ══════════════════════════════ //

  /** Loads an appointment (minimal relations) for a write, tenant-scoped. */
  private async loadForWrite(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<Appointment> {
    const appointment = await manager.getRepository(Appointment).findOne({
      where: { id, tenant: { id: tenantId } },
      relations: { staff: true, branch: true },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Appointment not found',
      });
    }
    return appointment;
  }

  private async assertBranch(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
  ): Promise<void> {
    const exists = await manager.getRepository(Branch).exists({
      where: { id: branchId, tenant: { id: tenantId }, is_active: true },
    });
    if (!exists) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Branch not found or inactive for this clinic',
      });
    }
  }

  private async assertCustomer(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<void> {
    const exists = await manager.getRepository(Customer).exists({
      where: { id: customerId, tenant: { id: tenantId } },
    });
    if (!exists) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Customer not found for this clinic',
      });
    }
  }

  /**
   * F-4 / F-3 — validates the doctor against the TENANT *and* the BRANCH.
   *
   * This check used to be tenant-only. `StaffProfile` has no branch relation, so
   * the only structural link is `staff_schedules.branchId` — and it was
   * consulted solely inside `AvailabilityService`, which fails OPEN when a staff
   * member has no positive windows (`ENFORCE_AVAILABILITY_WHEN_UNDEFINED =
   * false`). "No schedule at this branch" therefore meant "no constraint", and a
   * doctor who works only at branch A could be booked at branch B at any hour.
   *
   * Explicit configuration wins, exactly as for branch-scoped services: a doctor
   * with schedules SOMEWHERE must have one HERE; a doctor with none anywhere is
   * unconfigured legacy data and is allowed through, so clinics that book
   * manually without maintaining schedules are not broken by this. `strict`
   * (used by the public AI flow) removes that allowance.
   *
   * Runs against the transaction's `manager`, so it sees the same snapshot the
   * rest of the booking does.
   */
  private async assertStaffAtBranch(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    staffId: string,
    strict: boolean,
  ): Promise<void> {
    const staff = await manager.getRepository(StaffProfile).findOne({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!staff) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found for this clinic',
      });
    }

    const atBranch = await manager.getRepository(StaffSchedule).exists({
      where: {
        tenant: { id: tenantId },
        staff: { id: staffId },
        branch: { id: branchId },
        is_active: true,
      },
    });
    if (atBranch) return;

    if (!strict) {
      const anywhere = await manager.getRepository(StaffSchedule).exists({
        where: {
          tenant: { id: tenantId },
          staff: { id: staffId },
          is_active: true,
        },
      });
      if (!anywhere) return;
    }

    throw new AppError(ErrorCode.CONFLICT, {
      message: 'This staff member does not work at the selected branch',
      publicContext: { branchId, staffId },
    });
  }

  /**
   * Loads + validates services within the tenant AND the branch, resolving the
   * price that actually applies at that branch.
   *
   * F-5 — `Service` has no branch relation, so this used to be tenant-only and
   * always priced from `Service.base_price`. But `service_prices (serviceId,
   * branchId, price, is_active)` has existed since the baseline schema with
   * `UNIQUE(serviceId, branchId)`; nothing read it, so a clinic could neither
   * restrict a service to certain branches nor price it per branch — a
   * configured branch price was silently ignored at booking time.
   *
   * The rule (D1), explicit configuration wins:
   *  - service HAS active `service_prices` rows → it is offered only at those
   *    branches, at that branch's price;
   *  - service has NONE → unconfigured legacy data, offered everywhere at
   *    `base_price`.
   *
   * So clinics that never configure branch pricing are unaffected, and clinics
   * that do get real per-branch restriction. The resolved price is what gets
   * snapshotted onto the appointment and summed into the total — the amount is
   * therefore always server-derived, never influenced by the caller.
   */
  private async loadServices(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    serviceIds: string[] | undefined,
  ): Promise<PricedService[]> {
    if (!serviceIds || serviceIds.length === 0) return [];

    const services = await manager.getRepository(Service).find({
      where: { id: In(serviceIds), tenant: { id: tenantId }, is_active: true },
    });

    if (services.length !== serviceIds.length) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'One or more services were not found or are inactive',
      });
    }

    // FND-012/AD-11: variable pricing is BLOCKED, not built — there is no
    // booking-time pricing mechanism (the operator would need to enter a
    // price at time of service, a workflow this feature does not add). A
    // VARIABLE service's `base_price` is null by design; without this check
    // `computeWindowAndTotal`/`persistServices`'s `base_price ?? 0` would
    // silently record the booking at a zero price. Shared by both `create`
    // and `setServices` (both call this method).
    const variable = services.filter(
      (s) => s.pricing_type === PricingType.VARIABLE,
    );
    if (variable.length > 0) {
      throw new AppError(ErrorCode.VARIABLE_PRICING_UNSUPPORTED, {
        publicContext: { serviceIds: variable.map((s) => s.id) },
      });
    }

    return this.resolveBranchPrices(manager, tenantId, branchId, services);
  }

  /**
   * Applies the branch-service rule above and returns each service with the
   * price that governs at `branchId`. Throws when a service is configured for
   * other branches but not this one.
   */
  private async resolveBranchPrices(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    services: Service[],
  ): Promise<PricedService[]> {
    const ids = services.map((s) => s.id);

    // Two narrow reads instead of a per-service loop: the rows for THIS branch,
    // and which services are branch-configured at all.
    const rows: { serviceId: string; price: string; branchId: string }[] =
      await manager.query(
        `SELECT "serviceId", "branchId", price
         FROM service_prices
        WHERE "tenantId" = $1 AND "serviceId" = ANY($2) AND is_active = true`,
        [tenantId, ids],
      );

    const priceHere = new Map<string, number>();
    const configuredAnywhere = new Set<string>();
    for (const row of rows) {
      configuredAnywhere.add(row.serviceId);
      if (row.branchId === branchId)
        priceHere.set(row.serviceId, Number(row.price));
    }

    const notOffered = services.filter(
      (s) => configuredAnywhere.has(s.id) && !priceHere.has(s.id),
    );
    if (notOffered.length > 0) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'One or more services are not offered at the selected branch',
        publicContext: { branchId, serviceIds: notOffered.map((s) => s.id) },
      });
    }

    return services.map((service) => ({
      service,
      price: priceHere.get(service.id) ?? Number(service.base_price ?? 0),
    }));
  }

  /** Snapshots each service's BRANCH price + duration onto the appointment. */
  private async persistServices(
    manager: EntityManager,
    tenantId: string,
    appointment: Appointment,
    services: PricedService[],
  ): Promise<void> {
    if (!services.length) return;

    const repo = manager.getRepository(AppointmentServiceEntity);
    const rows = services.map(({ service, price }) =>
      repo.create({
        appointment: { id: appointment.id } as Appointment,
        service: { id: service.id } as Service,
        tenant: { id: tenantId } as Tenant,
        price,
        duration_minutes: service.duration_minutes,
      }),
    );
    await repo.save(rows);
  }

  /** Computes end time (from services unless explicit) and the total amount. */
  private computeWindowAndTotal(
    startAt: Date,
    services: PricedService[],
    explicitEndAt?: string,
  ): { endAt: Date; totalAmount: number | undefined } {
    const totalMinutes = services.reduce(
      (sum, { service }) => sum + (service.duration_minutes ?? 0),
      0,
    );
    // Branch-resolved prices, so the total is what the clinic actually charges
    // at THIS branch — and is derived server-side in every case.
    const totalAmount = services.length
      ? services.reduce((sum, { price }) => sum + price, 0)
      : undefined;

    let endAt: Date;
    if (explicitEndAt) {
      endAt = new Date(explicitEndAt);
    } else if (totalMinutes > 0) {
      endAt = new Date(startAt.getTime() + totalMinutes * 60_000);
    } else {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Provide endAt or at least one service to derive the duration',
      });
    }

    return { endAt, totalAmount };
  }

  /**
   * Is an ONLINE payment actually expected for this booking?
   *
   * Three independent ways the answer is no, all of which previously still
   * produced a `PENDING_PAYMENT` booking that nothing could ever advance:
   *   1. the patient has health insurance — never charged online, by policy;
   *   2. there is nothing payable (no services, or a zero total); or
   *   3. the clinic does not collect online payment at all
   *      (`tenant_settings.payment_required = false`).
   *
   * Read through the transaction's manager so the decision is taken on the same
   * snapshot as the rest of the booking. A missing settings row is treated as
   * "payment required", preserving the column's own default rather than
   * silently confirming bookings for a clinic whose settings never got created.
   */
  private async isOnlinePaymentDue(
    manager: EntityManager,
    tenantId: string,
    hasInsurance: boolean,
    totalAmount: number | undefined,
  ): Promise<boolean> {
    if (hasInsurance) return false;
    if (!totalAmount || totalAmount <= 0) return false;

    const rows: { payment_required: boolean }[] = await manager.query(
      `SELECT payment_required FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    return rows[0]?.payment_required ?? true;
  }

  private assertChronological(startAt: Date, endAt: Date): void {
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      endAt <= startAt
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Appointment end time must be after the start time',
      });
    }
  }

  private assertNotTerminal(appointment: Appointment, verb: string): void {
    if (TERMINAL_STATUSES.includes(appointment.status)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A ${appointment.status} appointment cannot be ${verb}`,
      });
    }
  }

  private assertTransition(
    from: AppointmentStatus,
    to: AppointmentStatus,
  ): void {
    if (from === to) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Appointment is already in status "${to}"`,
      });
    }
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Illegal status transition: ${from} → ${to}`,
        publicContext: { allowed: ALLOWED_TRANSITIONS[from] },
      });
    }
  }

  private async writeStatusLog(
    manager: EntityManager,
    tenantId: string,
    appointment: Appointment,
    status: AppointmentStatus,
    triggeredBy: string,
  ): Promise<void> {
    const repo = manager.getRepository(AppointmentStatusLog);
    await repo.save(
      repo.create({
        appointment: { id: appointment.id } as Appointment,
        tenant: { id: tenantId } as Tenant,
        status,
        triggered_by: triggeredBy,
      }),
    );
  }

  private async writeHistory(
    manager: EntityManager,
    tenantId: string,
    appointment: Appointment,
    oldStatus: AppointmentStatus | undefined,
    newStatus: AppointmentStatus,
    changedBy: string,
    note?: string,
  ): Promise<void> {
    const repo = manager.getRepository(AppointmentHistory);
    await repo.save(
      repo.create({
        appointment: { id: appointment.id } as Appointment,
        tenant: { id: tenantId } as Tenant,
        changed_by: changedBy,
        old_status: oldStatus,
        new_status: newStatus,
        note,
      }),
    );
  }

  private emitStatusEvent(
    tenantId: string,
    appointment: Appointment,
    status: AppointmentStatus,
  ): void {
    const customerId = appointment.customer!.id;
    const id = appointment.id;

    switch (status) {
      case AppointmentStatus.CONFIRMED:
        this.emitter.emit(
          AppointmentConfirmedEvent.eventName,
          new AppointmentConfirmedEvent(
            tenantId,
            id,
            customerId,
            appointment.start_at,
          ),
        );
        break;
      case AppointmentStatus.COMPLETED:
        this.emitter.emit(
          AppointmentCompletedEvent.eventName,
          new AppointmentCompletedEvent(tenantId, id, customerId),
        );
        break;
      case AppointmentStatus.NO_SHOW:
        this.emitter.emit(
          AppointmentNoShowEvent.eventName,
          new AppointmentNoShowEvent(tenantId, id, customerId),
        );
        break;
      case AppointmentStatus.IN_PROGRESS:
        this.emitter.emit(
          AppointmentInProgressEvent.eventName,
          new AppointmentInProgressEvent(tenantId, id, customerId),
        );
        break;
      default:
        break;
    }
  }
}
