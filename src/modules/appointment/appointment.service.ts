import { Injectable } from '@nestjs/common';
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
import { Service } from '../../entities/Services/Service';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { User } from '../../entities/Auth&RBAC/User';

import { AppointmentSource, AppointmentStatus } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { AvailabilityService } from '../scheduling/availability.service';
import { UsageService } from '../subscription-billing/usage.service';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';

import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { QueryAppointmentsDto } from './dto/query-appointments.dto';
import { ChangeAppointmentStatusDto } from './dto/change-appointment-status.dto';
import { CancelAppointmentDto } from './dto/cancel-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';
import { AddAppointmentNoteDto } from './dto/add-appointment-note.dto';
import { SetAppointmentServicesDto } from './dto/set-appointment-services.dto';

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

/** A single chronological entry in the unified appointment timeline. */
export interface TimelineEntry {
  type: 'created' | 'status_log' | 'history' | 'note' | 'reschedule' | 'cancellation';
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
    private readonly dataSource: DataSource,
    /** The single availability engine: every booking path validates through it. */
    private readonly availability: AvailabilityService,
    private readonly usage: UsageService,
  ) {}

  // ───────────────────────────── Queries ─────────────────────────────────── //

  /** Paginated, tenant-scoped list with optional filters. */
  async findAll(tenantId: string, query: QueryAppointmentsDto) {
    const where: FindOptionsWhere<Appointment> = { tenant: { id: tenantId } };

    if (query.status) where.status = query.status;
    if (query.branchId) where.branch = { id: query.branchId };
    if (query.staffId) where.staff = { id: query.staffId };
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

  /** Single appointment with full relations — tenant-scoped (404 otherwise). */
  async findOne(tenantId: string, id: string): Promise<Appointment> {
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
    return appointment;
  }

  // ───────────────────────────── Creation ────────────────────────────────── //

  async create(
    tenantId: string,
    userId: string,
    dto: CreateAppointmentDto,
  ): Promise<Appointment> {
    // Quota: appointments are a usage-limited resource. No-op under free mode /
    // override; throws 422 when the plan's monthly appointment limit is reached.
    await this.usage.assertWithinLimit(tenantId, USAGE_METRIC.APPOINTMENTS, 1);

    const created = await this.dataSource.transaction(async (manager) => {
      // All references validated within the SAME tenant scope.
      await this.assertBranch(manager, tenantId, dto.branchId);
      await this.assertCustomer(manager, tenantId, dto.customerId);
      await this.assertStaff(manager, tenantId, dto.staffId);
      const services = await this.loadServices(manager, tenantId, dto.serviceIds);

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

      const repo = manager.getRepository(Appointment);
      const status = AppointmentStatus.PENDING_PAYMENT;

      const appointment = repo.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: dto.branchId } as Branch,
        customer: { id: dto.customerId } as Customer,
        staff: { id: dto.staffId } as StaffProfile,
        start_at: startAt,
        end_at: endAt,
        status,
        total_amount: totalAmount,
        currency: dto.currency ?? 'USD',
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

    // Count the booking against the tenant's monthly quota (best-effort).
    await this.usage.increment(tenantId, USAGE_METRIC.APPOINTMENTS, 1);

    return this.findOne(tenantId, created.id);
  }

  // ───────────────────────────── Update ──────────────────────────────────── //

  /** Reassign staff/branch and edit notes. Date/time → reschedule; services → setServices. */
  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateAppointmentDto,
  ): Promise<Appointment> {
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
        await this.assertStaff(manager, tenantId, dto.staffId);
        appointment.staff = { id: dto.staffId } as StaffProfile;
        changes.push('staff reassigned');
        availabilityAffected = true;
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

      await manager.getRepository(Appointment).save(appointment);

      if (changes.length) {
        await this.writeHistory(
          manager,
          tenantId,
          appointment,
          appointment.status,
          appointment.status,
          userId,
          changes.join('; '),
        );
      }
    });

    return this.findOne(tenantId, id);
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

      const services = await this.loadServices(manager, tenantId, dto.serviceIds);

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

      await this.writeStatusLog(manager, tenantId, appointment, dto.status, userId);
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

    return this.findOne(tenantId, id);
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

    return this.findOne(tenantId, id);
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

    return this.findOne(tenantId, id);
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

  async listNotes(tenantId: string, id: string): Promise<AppointmentNote[]> {
    await this.findOne(tenantId, id);
    return this.notes.find({
      where: { appointment: { id }, tenant: { id: tenantId } },
      relations: { user: true },
      order: { created_at: 'DESC' },
    });
  }

  // ───────────────────────────── Timeline ────────────────────────────────── //

  /** Unified, chronological audit trail merged from every audit table. */
  async getTimeline(tenantId: string, id: string): Promise<TimelineEntry[]> {
    const appointment = await this.findOne(tenantId, id);

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

  private async assertStaff(
    manager: EntityManager,
    tenantId: string,
    staffId: string,
  ): Promise<void> {
    const exists = await manager.getRepository(StaffProfile).exists({
      where: { id: staffId, tenant: { id: tenantId } },
    });
    if (!exists) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Staff member not found for this clinic',
      });
    }
  }

  /** Loads + validates services within the tenant; all must exist & be active. */
  private async loadServices(
    manager: EntityManager,
    tenantId: string,
    serviceIds: string[] | undefined,
  ): Promise<Service[]> {
    if (!serviceIds || serviceIds.length === 0) return [];

    const services = await manager.getRepository(Service).find({
      where: { id: In(serviceIds), tenant: { id: tenantId }, is_active: true },
    });

    if (services.length !== serviceIds.length) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'One or more services were not found or are inactive',
      });
    }
    return services;
  }

  /** Snapshots each service's price + duration onto the appointment. */
  private async persistServices(
    manager: EntityManager,
    tenantId: string,
    appointment: Appointment,
    services: Service[],
  ): Promise<void> {
    if (!services.length) return;

    const repo = manager.getRepository(AppointmentServiceEntity);
    const rows = services.map((service) =>
      repo.create({
        appointment: { id: appointment.id } as Appointment,
        service: { id: service.id } as Service,
        tenant: { id: tenantId } as Tenant,
        price: Number(service.base_price ?? 0),
        duration_minutes: service.duration_minutes,
      }),
    );
    await repo.save(rows);
  }

  /** Computes end time (from services unless explicit) and the total amount. */
  private computeWindowAndTotal(
    startAt: Date,
    services: Service[],
    explicitEndAt?: string,
  ): { endAt: Date; totalAmount: number | undefined } {
    const totalMinutes = services.reduce(
      (sum, s) => sum + (s.duration_minutes ?? 0),
      0,
    );
    const totalAmount = services.length
      ? services.reduce((sum, s) => sum + Number(s.base_price ?? 0), 0)
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
        context: { allowed: ALLOWED_TRANSITIONS[from] },
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
}
