import { AppError } from '../../../common/errors';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppointmentStatus } from '../../../entities/enums';
import { QueryAppointmentsDto } from '../../appointment/dto/query-appointments.dto';
import { DEFAULT_CHANGE_WINDOW_HOURS, isWithinChangeWindow } from '../../patient-actions/patient-change-window.service';
import { safeZone, zonedYmd } from '../../scheduling/timezone.util';
import { AI_CHANNEL } from '../../ai-orchestrator/ai-channel.constants';
import { AI_TOOL } from './ai-tools.constants';
import { type ToolResult } from './ai-tool-args';
import { PERMISSION } from '../../../rbac/rbac.constants';
import { AiToolHandlerBase } from './ai-tool-handler.base';
import type { ToolContext } from './ai-tool-dispatch.service';

// Moved verbatim out of `AiToolDispatchService` (Phase 4 / S-01). Behaviour is unchanged.
/**
 * Appointments in a terminal state — history, not something a patient can still change.
 * Mirrors `AppointmentsService`'s own terminal set.
 */
const CLOSED_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

/**
 * `list_my_appointments`: how many rows are read (cancelled ones still occupy the
 * window, so this is wider than what is shown) and how many are handed to the model.
 */
const MY_APPOINTMENTS_FETCH = 20;
const MY_APPOINTMENTS_MAX = 10;

export class AppointmentChangeToolHandler extends AiToolHandlerBase {
  async rescheduleAppointment(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'Reschedule is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_RESCHEDULE)) {
      const reason = `Forbidden: rescheduling requires the "${PERMISSION.APPOINTMENTS_RESCHEDULE}" permission.`;
      await this.recordAttempt(
        ctx,
        AI_TOOL.RESCHEDULE_APPOINTMENT,
        args,
        'DENIED',
        reason,
      );
      return { success: false, error: reason };
    }
    const rawAppointmentId = this.str(args.appointmentId);
    const newStartAt = this.str(args.newStartAt);
    if (!rawAppointmentId || !newStartAt) {
      return {
        success: false,
        error: 'appointmentId and newStartAt are required.',
      };
    }
    const appointmentId = this.uuid(rawAppointmentId);
    if (!appointmentId) return this.badAppointmentId(ctx);
    const newStart = new Date(newStartAt);
    if (Number.isNaN(newStart.getTime())) {
      return {
        success: false,
        error: 'newStartAt must be a valid ISO-8601 timestamp.',
      };
    }
    const key = `reschedule:${appointmentId}:${newStartAt}`;

    // F-03: a patient-bound turn may only touch that patient's own appointment.
    // Runs on EVERY call (the proposing and the confirming one), and before the
    // ledger short-circuit below, so a replay can never reach another patient's row.
    const owned = await this.assertOwnAppointment(
      ctx,
      AI_TOOL.RESCHEDULE_APPOINTMENT,
      args,
      appointmentId,
    );
    if ('refusal' in owned) return owned.refusal;

    // AI-019/F1/PD-1: irreversible action — a valid, application-issued
    // confirmation is required and NEVER substitutes for the permission
    // check above (already run) or the ownership/business checks inside
    // AppointmentsService.reschedule (still run, below, unconditionally).
    // Skipped only when this EXACT (appointment, newStartAt) pair already
    // has a ledger row — a retried/replayed call must reach `run()`'s own
    // idempotent-replay/in-flight handling below, not be asked to
    // re-confirm an action already decided (FR-027: idempotency semantics
    // are not disturbed by this gate).
    if (!(await this.findByKey(ctx.tenantId, key))) {
      const policy = await this.changePolicyRefusal(
        ctx,
        AI_TOOL.RESCHEDULE_APPOINTMENT,
        args,
        owned.appointment,
      );
      if (policy) return policy;
      // The confirmed move is to THIS instant, in whatever notation the model
      // wrote it — two spellings of one time must not read as two proposals.
      const gate = await this.confirmationGate(
        ctx,
        AI_TOOL.RESCHEDULE_APPOINTMENT,
        args,
        `reschedule:${appointmentId}:${newStart.toISOString()}`,
        'move this appointment',
        async () =>
          owned.appointment
            ? {
                appointment: await this.describeAppointment(
                  ctx.tenantId,
                  owned.appointment,
                ),
                newStartAt: newStart.toISOString(),
                newLocalTime: this.localTimes(
                  newStart.toISOString(),
                  owned.appointment.branch?.timezone,
                ),
              }
            : {},
      );
      if (gate) return gate;
    }

    return this.run(
      ctx,
      AI_TOOL.RESCHEDULE_APPOINTMENT,
      key,
      args,
      async () => {
        const appt = await this.appointments.reschedule(
          ctx.tenantId,
          ctx.actorUserId!,
          appointmentId,
          {
            newStartAt,
            reason: this.str(args.reason),
          },
        );
        return {
          appointmentId: appt.id,
          resultJson: {
            appointmentId: appt.id,
            startAt: appt.start_at,
            endAt: appt.end_at,
          },
          toolResult: {
            success: true,
            appointmentId: appt.id,
            startAt: appt.start_at,
            endAt: appt.end_at,
          },
        };
      },
    );
  }

  async cancelAppointment(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error:
          'Cancellation is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_CANCEL)) {
      const reason = `Forbidden: cancellation requires the "${PERMISSION.APPOINTMENTS_CANCEL}" permission.`;
      await this.recordAttempt(
        ctx,
        AI_TOOL.CANCEL_APPOINTMENT,
        args,
        'DENIED',
        reason,
      );
      return { success: false, error: reason };
    }
    const rawAppointmentId = this.str(args.appointmentId);
    if (!rawAppointmentId) {
      return { success: false, error: 'appointmentId is required.' };
    }
    const appointmentId = this.uuid(rawAppointmentId);
    if (!appointmentId) return this.badAppointmentId(ctx);
    const key = `cancel:${appointmentId}`;

    // F-03 — see rescheduleAppointment: ownership on every call, before the ledger.
    const owned = await this.assertOwnAppointment(
      ctx,
      AI_TOOL.CANCEL_APPOINTMENT,
      args,
      appointmentId,
    );
    if ('refusal' in owned) return owned.refusal;

    // AI-019/F1/PD-1: irreversible action — see rescheduleAppointment's
    // identical gate immediately above for the full rationale. A valid
    // confirmation never substitutes for the permission check above
    // (already run) or the ownership check inside AppointmentsService.cancel
    // (still run, below, unconditionally). Skipped only when this EXACT
    // appointmentId already has a ledger row (FR-027 idempotency).
    if (!(await this.findByKey(ctx.tenantId, key))) {
      const policy = await this.changePolicyRefusal(
        ctx,
        AI_TOOL.CANCEL_APPOINTMENT,
        args,
        owned.appointment,
      );
      if (policy) return policy;
      const gate = await this.confirmationGate(
        ctx,
        AI_TOOL.CANCEL_APPOINTMENT,
        args,
        `cancel:${appointmentId}`,
        'cancel this appointment',
        async () =>
          owned.appointment
            ? {
                appointment: await this.describeAppointment(
                  ctx.tenantId,
                  owned.appointment,
                ),
              }
            : {},
      );
      if (gate) return gate;
    }

    return this.run(ctx, AI_TOOL.CANCEL_APPOINTMENT, key, args, async () => {
      const appt = await this.appointments.cancel(
        ctx.tenantId,
        ctx.actorUserId!,
        appointmentId,
        {
          reason: this.str(args.reason),
        },
      );
      return {
        appointmentId: appt.id,
        resultJson: { appointmentId: appt.id, status: appt.status },
        toolResult: {
          success: true,
          appointmentId: appt.id,
          status: appt.status,
        },
      };
    });
  }

  // ───────────── Patient-bound appointment changes (F-03/F-05/F-06/F-27) ───────────── //
  //
  // A WhatsApp turn is one patient talking to one clinic, and the conversation
  // carries that patient's id (`ctx.customerId`, written by the trusted webhook
  // bridge, never by the model). Everything below is enforced HERE, on the server:
  // which appointments a patient may touch, whether the clinic's change window is
  // still open, and that the patient — not the model — was asked before anything
  // irreversible ran. A staff principal (no bound customer) keeps its permission-
  // based authority over the whole tenant, exactly as the REST API gives it.

  /**
   * One sentence for "no such appointment", "another clinic's appointment" and
   * "another patient's appointment", so the answer is never an existence oracle.
   */
  static readonly NOT_THIS_PATIENTS_APPOINTMENT =
    'No upcoming appointment with that id belongs to this patient. Call list_my_appointments and use an id it returns.';

  badAppointmentId(ctx: ToolContext): ToolResult {
    return this.badId(
      'appointmentId',
      ctx.customerId ? 'list_my_appointments' : 'the tool that listed it',
    );
  }

  /**
   * F-03. On a patient-bound turn the appointment must be that patient's own
   * (same tenant AND same customer); anything else is refused with the one
   * uniform message. Returns the appointment it loaded so the caller does not
   * read it twice, or `{}` for a principal with no bound customer.
   *
   * A WhatsApp turn with NO bound customer is refused outright: the bot actor
   * holds tenant-wide cancel/reschedule permission, so "no patient" must never
   * quietly mean "any patient". The channel only ever NARROWS here — it can
   * turn a call into a refusal, never into an allowance.
   */
  async assertOwnAppointment(
    ctx: ToolContext,
    tool: string,
    args: Record<string, unknown>,
    appointmentId: string,
  ): Promise<{ refusal: ToolResult } | { appointment?: Appointment }> {
    if (!ctx.customerId) {
      if (ctx.channel !== AI_CHANNEL.WHATSAPP) return {};
      const reason = 'No patient is identified for this conversation.';
      await this.recordAttempt(ctx, tool, args, 'DENIED', reason);
      return {
        refusal: {
          success: false,
          error: `${reason} An appointment cannot be changed from here: offer to connect the person with the clinic team (request_human_handover).`,
        },
      };
    }
    let appointment: Appointment | null = null;
    try {
      appointment = await this.appointments.findOne(
        ctx.tenantId,
        appointmentId,
      );
    } catch (err) {
      // `findOne` is tenant-scoped and throws a 404 for a row that is not there.
      if (!(err instanceof AppError)) throw err;
    }
    if (!appointment || appointment.customer?.id !== ctx.customerId) {
      await this.recordAttempt(
        ctx,
        tool,
        args,
        'DENIED',
        'Appointment not found for this patient.',
      );
      return {
        refusal: {
          success: false,
          error: AppointmentChangeToolHandler.NOT_THIS_PATIENTS_APPOINTMENT,
        },
      };
    }
    return { appointment };
  }

  /**
   * F-05. The clinic's `cancellation_hours` window, read live and compared with
   * the SAME rule the signed patient link applies (`isWithinChangeWindow`), plus
   * "is it still a live appointment". Checked BEFORE a confirmation is asked
   * for, so the patient is never asked to agree to something the server will
   * refuse. Only for a patient-bound turn (`appointment` is set): the window is
   * a rule about patients, and staff act under their own permission.
   */
  async changePolicyRefusal(
    ctx: ToolContext,
    tool: string,
    args: Record<string, unknown>,
    appointment: Appointment | undefined,
  ): Promise<ToolResult | null> {
    if (!appointment) return null;
    if (CLOSED_APPOINTMENT_STATUSES.includes(appointment.status)) {
      const reason = `This appointment is ${appointment.status
        .toLowerCase()
        .replace('_', ' ')} and can no longer be changed.`;
      await this.recordAttempt(ctx, tool, args, 'REFUSED', reason);
      return { success: false, error: reason };
    }
    const hours = await this.changeWindowHours(ctx.tenantId);
    if (!isWithinChangeWindow(appointment.start_at, hours)) {
      const reason = `Clinic policy: an appointment can only be changed at least ${hours} hours before it starts, and this one starts sooner.`;
      await this.recordAttempt(ctx, tool, args, 'REFUSED', reason);
      return {
        success: false,
        blockedReason: 'WINDOW_CLOSED',
        changeWindowHours: hours,
        error: `${reason} Do not cancel or move it. Tell the patient, and offer to connect them with the clinic team (request_human_handover).`,
      };
    }
    return null;
  }

  async changeWindowHours(tenantId: string): Promise<number> {
    const settings = await this.tenants.getSettings(tenantId);
    return settings.cancellation_hours ?? DEFAULT_CHANGE_WINDOW_HOURS;
  }

  /**
   * F-04 / F-27. Returns `null` when the patient has confirmed (the caller
   * proceeds), otherwise the refusal to hand the model:
   *  - no proposal yet → the server records exactly what is being confirmed and
   *    asks the model to put it to the patient and STOP;
   *  - a proposal made in THIS turn → refused again: the patient has had no turn
   *    in which to answer, so the model cannot confirm on their behalf.
   * The confirming call arrives in a later user turn and needs no token (a tool
   * result does not survive into the next turn, which is why a token the model
   * had to carry made every real confirmation fail).
   */
  async confirmationGate(
    ctx: ToolContext,
    tool: string,
    args: Record<string, unknown>,
    gateKey: string,
    action: string,
    /** What the patient is being asked to confirm — built only when a proposal is actually issued. */
    summary: () => Promise<Record<string, unknown>>,
  ): Promise<ToolResult | null> {
    const state = await this.verifyConfirmation(ctx, gateKey);
    if (state === 'confirmed') return null;
    if (state === 'same_turn') {
      await this.recordAttempt(
        ctx,
        tool,
        args,
        'REFUSED',
        'Confirmation was already requested in this turn; waiting for the patient.',
      );
      return {
        success: false,
        confirmationRequired: true,
        awaitingPatientReply: true,
        error:
          'The patient has not answered yet. Do not call this tool again in this reply: send them the confirmation question now, and act only after they answer.',
      };
    }
    const confirmationToken = await this.issueConfirmation(ctx, gateKey);
    await this.recordAttempt(
      ctx,
      tool,
      args,
      'REFUSED',
      `Requires confirmation before it will ${action}.`,
    );
    return {
      success: false,
      confirmationRequired: true,
      confirmationToken,
      ...(await summary()),
      error: `Nothing has changed yet. Tell the patient exactly what will happen (details above), ask them to confirm, then STOP and wait for their reply. Only after they agree, in their next message, call this tool again with the same arguments to ${action}.`,
    };
  }

  /** `HH:mm` and date of an instant in the branch's own zone. */
  localTimes(
    iso: string,
    timezone: string | null | undefined,
  ): { date: string; time: string; timezone: string } {
    const zone = safeZone(timezone);
    return {
      date: zonedYmd(new Date(iso), zone),
      time: this.localHhmm(iso, zone),
      timezone: zone,
    };
  }

  /** Doctor names for a set of staff-profile ids, tenant-scoped. Best effort. */
  async doctorNames(
    tenantId: string,
    staffIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (staffIds.length === 0) return names;
    try {
      const rows: { id: string; name: string | null }[] =
        await this.dataSource.query(
          `SELECT sp.id, u.full_name AS name
             FROM staff_profiles sp JOIN users u ON u.id = sp.user_id
            WHERE sp."tenantId" = $1 AND sp.id = ANY($2::uuid[])`,
          [tenantId, staffIds],
        );
      for (const r of rows) if (r.name) names.set(r.id, this.oneLine(r.name));
    } catch (err) {
      this.logger.warn(`could not read doctor names: ${this.msg(err)}`);
    }
    return names;
  }

  /**
   * An appointment as the patient should hear it — date and time in the branch's
   * own zone, doctor, branch, services. Read from the row, so a confirmation
   * question can only ever name what the appointment really is.
   */
  async describeAppointment(
    tenantId: string,
    appointment: Appointment,
    names?: Map<string, string>,
  ): Promise<Record<string, unknown>> {
    const doctors =
      names ??
      (await this.doctorNames(
        tenantId,
        appointment.staff?.id ? [appointment.staff.id] : [],
      ));
    const startIso = appointment.start_at.toISOString();
    return {
      appointmentId: appointment.id,
      status: appointment.status,
      startAt: startIso,
      local: this.localTimes(startIso, appointment.branch?.timezone),
      branch: appointment.branch?.name
        ? this.oneLine(appointment.branch.name)
        : null,
      doctor:
        (appointment.staff?.id && doctors.get(appointment.staff.id)) || null,
      services: (appointment.services ?? [])
        .map((s) => s.service?.name)
        .filter((n): n is string => !!n)
        .map((n) => this.oneLine(n)),
    };
  }

  /**
   * F-27 / F-06. The patient's own upcoming appointments — the only source of an
   * `appointmentId` for cancel/reschedule, so the patient is never asked to type
   * one and the model never has to guess one. Bound to the conversation's customer
   * server-side; a model-supplied id is not an input at all.
   */
  async listMyAppointments(ctx: ToolContext): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_READ)) {
      const reason = `Forbidden: listing appointments requires the "${PERMISSION.APPOINTMENTS_READ}" permission.`;
      await this.recordAttempt(
        ctx,
        AI_TOOL.LIST_MY_APPOINTMENTS,
        {},
        'DENIED',
        reason,
      );
      return { success: false, error: reason };
    }
    if (!ctx.customerId) {
      return {
        success: false,
        error:
          'No patient is identified for this conversation, so there is no appointment list to show. Offer to connect the person with the clinic team (request_human_handover).',
      };
    }
    const query = Object.assign(new QueryAppointmentsDto(), {
      customerId: ctx.customerId,
      from: new Date().toISOString(),
      order: 'ASC' as const,
      page: 1,
      limit: MY_APPOINTMENTS_FETCH,
    });
    const { data } = await this.appointments.findAll(ctx.tenantId, query, {
      id: ctx.actorUserId!,
      permissions: ctx.permissions ?? [],
    });
    const upcoming = data
      .filter((a) => !CLOSED_APPOINTMENT_STATUSES.includes(a.status))
      .slice(0, MY_APPOINTMENTS_MAX);
    const hours = await this.changeWindowHours(ctx.tenantId);
    const names = await this.doctorNames(
      ctx.tenantId,
      upcoming.flatMap((a) => (a.staff?.id ? [a.staff.id] : [])),
    );
    const appointments = await Promise.all(
      upcoming.map(async (a) => ({
        ...(await this.describeAppointment(ctx.tenantId, a, names)),
        // Server-computed, so the model does not have to do date arithmetic
        // against a policy it has not been shown.
        canChangeOnline: isWithinChangeWindow(a.start_at, hours),
      })),
    );
    return {
      success: true,
      count: appointments.length,
      changeWindowHours: hours,
      appointments,
      guidance:
        appointments.length === 0
          ? 'This patient has no upcoming appointment. Say so, and offer to book one.'
          : 'Refer to an appointment by its date, time and doctor — never show the id. Only these appointments can be cancelled or moved; one with canChangeOnline false is inside the clinic change window, so do not try it: offer to connect the patient with the clinic team instead.',
    };
  }

}
