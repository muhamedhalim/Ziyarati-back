import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { QueueEntry } from '../../entities/Calendar&Appointments/QueueEntry';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { BranchUser } from '../../entities/Multi Branch/BranchUser';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { Customer } from '../../entities/CRM/Customer';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppointmentStatus, QueueState } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';
import { AppointmentsService } from '../appointment/appointment.service';
import { zonedYmd, safeZone } from '../scheduling/timezone.util';
import { ActivityAuditService } from '../activity-log/activity-audit.service';
import { CheckInQueueDto } from './dto/check-in-queue.dto';
import { QueryQueueDto } from './dto/query-queue.dto';
import { orderQueueEntries, type OrderableQueueEntry } from './queue-ordering';

/** Additive only. On the Activity allow-list since T023 — this is the writer
 *  that entry had been missing. */
export const QUEUE_AUDIT_ACTION = {
  PATIENT_CHECKED_IN: 'queue.patient_checked_in',
} as const;

/** FR-Q007 — checking in a terminal appointment is refused. */
const TERMINAL_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

/** Unresolved-at-day-close states — see `closeUnresolvedEntries` (T174). */
const UNRESOLVED_STATES: QueueState[] = [
  QueueState.WAITING,
  QueueState.CALLED,
  QueueState.IN_CONSULTATION,
  QueueState.SKIPPED,
];

/** Terminal queue states — no further transition, never re-claimed. */
const TERMINAL_QUEUE_STATES: QueueState[] = [
  QueueState.COMPLETED,
  QueueState.CANCELLED,
  QueueState.NO_SHOW,
];

export interface QueueEntryView {
  id: string;
  position: number | null;
  state: QueueState;
  arrivedAt: Date;
  waitingMinutes: number;
  customer: { id: string; fullName: string };
  staff: { id: string; name: string } | null;
  appointment: {
    id: string;
    startAt: Date;
    status: AppointmentStatus;
    paymentStatus: string;
  };
  blocked?: {
    reason: 'AWAITING_CONFIRMATION';
    requires: 'CONFIRM_APPOINTMENT';
  };
}

export interface QueueListResult {
  data: QueueEntryView[];
  total: number;
  page: number;
  limit: number;
  asOf: string;
}

/**
 * Spec 014 (Clinic Platform Completion) — T169/T170 (US10, data-model.md
 * §4). Queue management does NOT replace the appointment lifecycle
 * (FR-Q004): every transition that has an appointment-side equivalent is
 * driven through the EXISTING, UNCHANGED `AppointmentsService.changeStatus`
 * — never a duplicated write. `ALLOWED_TRANSITIONS` on the appointment side
 * is never widened (R10).
 *
 * Ordering of "claim the queue transition" vs. "drive the appointment":
 * every queue-entry state change is claimed FIRST via a conditional
 * `UPDATE … WHERE state = :from` (checked by affected-row count, never
 * read-then-write — T170/FR-Q009). Only the request that WINS that claim
 * goes on to call `changeStatus`, so `changeStatus` is invoked AT MOST ONCE
 * per queue action even when two callers race — this is what makes T166's
 * single-write property (exactly one status log / history row / event per
 * completion) hold under concurrency, not merely in the single-caller case.
 */
@Injectable()
export class PatientQueueService {
  private readonly logger = new Logger('PatientQueueService');

  constructor(
    @InjectRepository(QueueEntry)
    private readonly entries: Repository<QueueEntry>,
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
    @InjectRepository(BranchUser)
    private readonly branchUsers: Repository<BranchUser>,
    private readonly appointmentsService: AppointmentsService,
    private readonly activityAudit: ActivityAuditService,
  ) {}

  // ───────────────────────────── Check-in ────────────────────────────────── //

  /**
   * FR-Q001/FR-Q005/FR-Q006/FR-Q007/FR-Q007a. An appointment still
   * `PENDING_PAYMENT` IS accepted — a patient at the desk is never turned
   * away by a payment state — but the returned view carries `blocked` so the
   * queue surfaces the confirmation requirement explicitly.
   */
  async checkIn(
    tenantId: string,
    actorUserId: string,
    dto: CheckInQueueDto,
  ): Promise<QueueEntryView> {
    const appointment = await this.appointments.findOne({
      where: { id: dto.appointmentId, tenant: { id: tenantId } },
      relations: { branch: true, customer: true, staff: { user: true } },
    });
    if (!appointment) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Appointment not found',
      });
    }

    // FR-Q007 — cancelled / completed / no-show appointments are refused.
    if (TERMINAL_APPOINTMENT_STATUSES.includes(appointment.status)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `A ${appointment.status} appointment cannot be checked in`,
      });
    }

    // FR-Q006 — refused when the appointment's branch differs from the
    // caller's own branch. A tenant-wide caller (no branch_users rows at
    // all) may check in at any of their tenant's branches.
    const ownBranchIds = await this.resolveOwnBranchIds(tenantId, actorUserId);
    if (
      ownBranchIds.length > 0 &&
      !ownBranchIds.includes(appointment.branch.id)
    ) {
      throw new AppError(ErrorCode.CONFLICT, {
        message:
          'This appointment belongs to a different branch than the one performing the check-in',
        publicContext: { reason: 'WRONG_BRANCH' },
      });
    }

    const businessDate = zonedYmd(
      new Date(),
      safeZone(appointment.branch.timezone),
    );
    const arrivedAt = new Date();

    // FR-Q005 — a second concurrent check-in for the SAME appointment fails
    // at the database (`UQ_queue_entries_appointment_live`, a partial unique
    // index over live states), mapped by the global TypeORM error mapper to
    // a clean 409 (`CONSTRAINT_MESSAGES` in typeorm-error.mapper.ts) — never
    // an application-level pre-check, which would race.
    const saved = await this.entries.save(
      this.entries.create({
        tenant: { id: tenantId } as Tenant,
        branch: { id: appointment.branch.id } as Branch,
        appointment: { id: appointment.id } as Appointment,
        customer: { id: appointment.customer.id } as Customer,
        staff: { id: appointment.staff.id } as StaffProfile,
        business_date: businessDate,
        state: QueueState.WAITING,
        arrived_at: arrivedAt,
      }),
    );

    // Re-fetch with full relations rather than building the view off `saved`
    // directly: `.save()` returns the entity with relations set to the bare
    // `{ id }` stubs it was created with (e.g. `saved.customer.full_name` is
    // undefined), which would render a blank customer/staff name on the
    // check-in response. `reload` (used by every transition method below)
    // fetches the entry back with `customer`/`staff.user` populated.
    // Activity trail, after the check-in row exists. A check-in is a real
    // front-desk action with a branch and an actor; the label is the treating
    // staff member (an employee), never the patient (ActivityAuditService).
    await this.activityAudit.record({
      tenantId,
      action: QUEUE_AUDIT_ACTION.PATIENT_CHECKED_IN,
      entityType: 'QueueEntry',
      entityId: saved.id,
      actorUserId,
      branchId: appointment.branch.id,
      entityLabel: appointment.staff?.user?.full_name ?? null,
      after: { appointmentId: appointment.id, businessDate },
    });

    return this.reload(tenantId, saved.id);
  }

  // ───────────────────────────── Read ────────────────────────────────────── //

  /** FR-Q008/FR-Q013/FR-Q014. `branchId` is mandatory — a queue is always one branch's one day. */
  async list(
    tenantId: string,
    actorUserId: string,
    dto: QueryQueueDto,
  ): Promise<QueueListResult> {
    const branch = await this.branches.findOne({
      where: { id: dto.branchId, tenant: { id: tenantId } },
    });
    if (!branch) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
    }
    await this.assertOwnBranch(tenantId, actorUserId, branch.id);

    const businessDate =
      dto.date ?? zonedYmd(new Date(), safeZone(branch.timezone));

    const rows = await this.entries.find({
      where: {
        tenant: { id: tenantId },
        branch: { id: branch.id },
        business_date: businessDate,
        ...(dto.staffId ? { staff: { id: dto.staffId } } : {}),
      },
      relations: { appointment: true, customer: true, staff: { user: true } },
    });

    const orderable: (OrderableQueueEntry & { row: QueueEntry })[] = rows.map(
      (row) => ({
        id: row.id,
        state: row.state,
        appointmentStartAt: row.appointment.start_at,
        arrivedAt: row.arrived_at,
        row,
      }),
    );
    const ordered = orderQueueEntries(orderable);

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 200;
    const start = (page - 1) * limit;
    const pageSlice = ordered.slice(start, start + limit);

    const data = pageSlice.map(({ entry, position, waitingMinutes }) =>
      this.toView(entry.row, entry.row.appointment, position, waitingMinutes),
    );

    return {
      data,
      total: rows.length,
      page,
      limit,
      asOf: new Date().toISOString(),
    };
  }

  // ───────────────────────────── Transitions ─────────────────────────────── //

  /** FR-Q009 — exclusive: `UPDATE … WHERE state = 'WAITING'`, checked by affected-row count. */
  async call(
    tenantId: string,
    actorUserId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    await this.assertEntryBranchAccess(tenantId, actorUserId, entryId);
    await this.claim(
      tenantId,
      entryId,
      [QueueState.WAITING],
      QueueState.CALLED,
      {
        called_at: () => 'now()',
        called_by: { id: actorUserId },
      },
    );
    return this.reload(tenantId, entryId);
  }

  /**
   * FR-Q007a/FR-Q007b/FR-Q007c — refuses with `AWAITING_CONFIRMATION` while
   * the appointment is still `PENDING_PAYMENT`. Confirmation happens through
   * the EXISTING `POST /appointments/:id/status` route — this method never
   * confirms an appointment implicitly, and the queue entry is left
   * untouched (still `CALLED`) when refused.
   */
  async start(
    tenantId: string,
    actorUserId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    const entry = await this.assertEntryBranchAccess(
      tenantId,
      actorUserId,
      entryId,
    );

    if (entry.appointment.status === AppointmentStatus.PENDING_PAYMENT) {
      throw new AppError(ErrorCode.AWAITING_CONFIRMATION, {
        publicContext: { requires: 'CONFIRM_APPOINTMENT' },
      });
    }

    await this.claim(
      tenantId,
      entryId,
      [QueueState.CALLED],
      QueueState.IN_CONSULTATION,
      { started_at: () => 'now()' },
    );

    await this.appointmentsService.changeStatus(
      tenantId,
      actorUserId,
      entry.appointment.id,
      {
        status: AppointmentStatus.IN_PROGRESS,
        note: 'Consultation started (queue)',
      },
    );

    return this.reload(tenantId, entryId);
  }

  /** Drives the appointment to `COMPLETED` (FR-Q004) — exactly once (T166). */
  async complete(
    tenantId: string,
    actorUserId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    const entry = await this.assertEntryBranchAccess(
      tenantId,
      actorUserId,
      entryId,
    );

    await this.claim(
      tenantId,
      entryId,
      [QueueState.IN_CONSULTATION],
      QueueState.COMPLETED,
      { ended_at: () => 'now()' },
    );

    await this.appointmentsService.changeStatus(
      tenantId,
      actorUserId,
      entry.appointment.id,
      {
        status: AppointmentStatus.COMPLETED,
        note: 'Consultation completed (queue)',
      },
    );

    return this.reload(tenantId, entryId);
  }

  /** FR-Q010 — a skipped patient leaves the active order, recallable later. */
  async skip(
    tenantId: string,
    actorUserId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    await this.assertEntryBranchAccess(tenantId, actorUserId, entryId);
    await this.claim(
      tenantId,
      entryId,
      [QueueState.CALLED],
      QueueState.SKIPPED,
      {},
    );
    return this.reload(tenantId, entryId);
  }

  /** FR-Q010 — `SKIPPED → WAITING`, never lost. */
  async recall(
    tenantId: string,
    actorUserId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    await this.assertEntryBranchAccess(tenantId, actorUserId, entryId);
    await this.claim(
      tenantId,
      entryId,
      [QueueState.SKIPPED],
      QueueState.WAITING,
      {},
    );
    return this.reload(tenantId, entryId);
  }

  /** FR-Q012 — closes the entry AND records the no-show outcome exactly once. */
  async noShow(
    tenantId: string,
    actorUserId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    const entry = await this.assertEntryBranchAccess(
      tenantId,
      actorUserId,
      entryId,
    );

    await this.claim(
      tenantId,
      entryId,
      [QueueState.WAITING, QueueState.CALLED],
      QueueState.NO_SHOW,
      { ended_at: () => 'now()' },
    );

    await this.appointmentsService.changeStatus(
      tenantId,
      actorUserId,
      entry.appointment.id,
      { status: AppointmentStatus.NO_SHOW, note: 'Marked no-show (queue)' },
    );

    return this.reload(tenantId, entryId);
  }

  // ────────────────────────── Event-driven cleanup ───────────────────────── //

  /**
   * FR-Q011 — consumes the ALREADY-EMITTED `AppointmentCancelledEvent` (no
   * new event class) and closes the live entry, if any. Idempotent: a
   * cancelled appointment with no live entry (or already closed) is a no-op.
   */
  async closeEntryForCancelledAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
    await this.entries
      .createQueryBuilder()
      .update(QueueEntry)
      .set({ state: QueueState.CANCELLED, ended_at: () => 'now()' })
      .where(
        '"tenantId" = :tenantId AND "appointmentId" = :appointmentId AND state NOT IN (:...terminal)',
        {
          tenantId,
          appointmentId,
          terminal: TERMINAL_QUEUE_STATES,
        },
      )
      .execute();
  }

  // ─────────────────────────── Day-close sweep (T174) ────────────────────── //

  /**
   * FR-Q016 — every unresolved entry (still in an active/skipped state) for
   * `business_date <= CURRENT_DATE` is closed to `CANCELLED` — an explicit
   * terminal state, never carried silently into the next day. Scoped to the
   * queue bookkeeping only: it does NOT drive the underlying appointment
   * (unlike the patient-initiated transitions above) — the sweep is closing
   * out a stale FRONT-DESK ROW, not adjudicating what clinically happened to
   * the appointment, so `AppointmentsService.changeStatus` is deliberately
   * not called here.
   *
   * A bulk conditional `UPDATE`, not a read-then-write loop — mirrors
   * `WaitlistService.expireDueEntries`. `<=` (not `=`) `CURRENT_DATE` makes a
   * delayed or manually re-run sweep still correct, and re-running it is a
   * no-op (idempotent): the second run matches nothing, since every row it
   * would have touched is already `CANCELLED`.
   */
  async closeUnresolvedEntries(): Promise<{ closed: number }> {
    const result = await this.entries
      .createQueryBuilder()
      .update(QueueEntry)
      .set({ state: QueueState.CANCELLED, ended_at: () => 'now()' })
      .where('state IN (:...unresolved) AND business_date <= CURRENT_DATE', {
        unresolved: UNRESOLVED_STATES,
      })
      .execute();
    return { closed: result.affected ?? 0 };
  }

  // ─────────────────────────────── Internals ─────────────────────────────── //

  private resolveOwnBranchIds(
    tenantId: string,
    userId: string,
  ): Promise<string[]> {
    return this.branchUsers
      .find({
        where: { tenant: { id: tenantId }, user: { id: userId } },
        relations: { branch: true },
      })
      .then((rows) => rows.map((r) => r.branch.id));
  }

  /** FR-Q014 — a branch-restricted caller may act on/see only their own branch(es). */
  private async assertOwnBranch(
    tenantId: string,
    userId: string,
    branchId: string,
  ): Promise<void> {
    const ownIds = await this.resolveOwnBranchIds(tenantId, userId);
    if (ownIds.length > 0 && !ownIds.includes(branchId)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, {
        message: 'You can only manage the queue for your own branch',
      });
    }
  }

  /**
   * Loads a queue entry scoped to the caller's tenant (a cross-tenant id
   * NEVER distinguishably 404s vs. "wrong branch" — no enumeration) and
   * asserts branch access. Returns the loaded entry (with `appointment`)
   * for callers that need its current appointment status.
   */
  private async assertEntryBranchAccess(
    tenantId: string,
    userId: string,
    entryId: string,
  ): Promise<QueueEntry> {
    const entry = await this.entries.findOne({
      where: { id: entryId, tenant: { id: tenantId } },
      relations: {
        branch: true,
        appointment: true,
        customer: true,
        staff: { user: true },
      },
    });
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Queue entry not found',
      });
    }
    await this.assertOwnBranch(tenantId, userId, entry.branch.id);
    return entry;
  }

  /**
   * T170 — the ONE place every queue-entry state transition is claimed:
   * `UPDATE … WHERE id = :id AND "tenantId" = :tenantId AND state IN
   * (:...from)`, checked by affected-row count, never read-then-write. Only
   * the caller that wins this claim may proceed to drive the appointment
   * (see this class's own docblock).
   */
  private async claim(
    tenantId: string,
    entryId: string,
    from: QueueState[],
    to: QueueState,
    extraSet: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.entries
      .createQueryBuilder()
      .update(QueueEntry)
      .set({ state: to, ...extraSet } as QueryDeepPartialEntity<QueueEntry>)
      .where('id = :id AND "tenantId" = :tenantId AND state IN (:...from)', {
        id: entryId,
        tenantId,
        from,
      })
      .execute();

    if (!result.affected) {
      const current = await this.entries.findOne({
        where: { id: entryId, tenant: { id: tenantId } },
      });
      if (!current) {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Queue entry not found',
        });
      }
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Queue entry is "${current.state}" — expected one of ${from.join(', ')}`,
        publicContext: { state: current.state },
      });
    }
  }

  private async reload(
    tenantId: string,
    entryId: string,
  ): Promise<QueueEntryView> {
    const entry = await this.entries.findOne({
      where: { id: entryId, tenant: { id: tenantId } },
      relations: { appointment: true, customer: true, staff: { user: true } },
    });
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Queue entry not found',
      });
    }
    return this.toView(entry, entry.appointment, null, 0);
  }

  private toView(
    entry: QueueEntry,
    appointment: Appointment,
    position: number | null,
    waitingMinutes: number,
  ): QueueEntryView {
    const blocked =
      appointment.status === AppointmentStatus.PENDING_PAYMENT
        ? ({
            reason: 'AWAITING_CONFIRMATION',
            requires: 'CONFIRM_APPOINTMENT',
          } as const)
        : undefined;

    return {
      id: entry.id,
      position,
      state: entry.state,
      arrivedAt: entry.arrived_at,
      waitingMinutes,
      customer: {
        id: entry.customer.id,
        fullName: entry.customer.full_name ?? '',
      },
      staff: entry.staff
        ? {
            id: entry.staff.id,
            name: entry.staff.title || entry.staff.user?.full_name || '',
          }
        : null,
      appointment: {
        id: appointment.id,
        startAt: appointment.start_at,
        status: appointment.status,
        paymentStatus: appointment.payment_status,
      },
      blocked,
    };
  }
}
