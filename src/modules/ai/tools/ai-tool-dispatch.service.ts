import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError } from '../../../common/errors';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppointmentSource, AppointmentStatus } from '../../../entities/enums';
import { AppointmentsService } from '../../appointment/appointment.service';
import { QueryAppointmentsDto } from '../../appointment/dto/query-appointments.dto';
import {
  DEFAULT_CHANGE_WINDOW_HOURS,
  isWithinChangeWindow,
} from '../../patient-actions/patient-change-window.service';
import { PublicDiscoveryService } from '../../public-discovery/public-discovery.service';
import {
  AvailabilityService,
  DayWindows,
  PUBLIC_AVAILABILITY_HORIZON_DAYS,
} from '../../scheduling/availability.service';
import { safeZone, zonedYmd } from '../../scheduling/timezone.util';
import { DashboardMetricService } from '../../analytics/dashboard-metric.service';
import { SubscriptionService } from '../../subscription-billing/subscription.service';
import { UsageService } from '../../subscription-billing/usage.service';
import { CustomerService } from '../../crm/customer.service';
import { StaffService } from '../../staff/staff.service';
import { TenantService } from '../../tenant/tenant.service';
import { BranchService } from '../../tenant/branch.service';
import { PaymentLinkService } from '../../payments/payment-link.service';
import { AiToolCall } from '../providers/ai-provider.interface';
import { AiAnalyticsService } from '../ai-analytics.service';
import { HandoverRequestService } from '../handover-request.service';
import { AI_TOOL } from './ai-tools.constants';
import { AI_PUBLIC_TOOL } from './ai-public-booking-tools.constants';
import { PublicBookingContextService } from '../../public-booking/public-booking-context.service';
import {
  ConversationSessionService,
  SESSION_UNSET,
} from '../../ai-orchestrator/conversation-session.service';
import { WhatsappBotActorService } from '../../whatsapp/whatsapp-bot-actor.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  AI_ADMIN_TOOL,
  AI_ADMIN_TOOL_PERMISSION,
  AiAdminToolName,
} from './ai-admin-tools.constants';
import { PERMISSION } from '../../../rbac/rbac.constants';

/** Days searched when the model gives no `daysAhead` — a week reads naturally. */
const DEFAULT_AVAILABILITY_DAYS = 7;

/**
 * How many days WITH slots to collect before stopping.
 *
 * Three is enough to give a patient a real choice and short enough that a
 * booked-out doctor does not cost the full 14-day horizon on every question.
 */
const MAX_ALTERNATIVE_DAYS = 3;

/**
 * Plain-language explanation of each `DayWindows.reason`.
 *
 * These exist so the model states the ACTUAL cause instead of collapsing every
 * empty day into "the doctor is unavailable" — the single behaviour that made
 * the assistant repeat itself for four turns straight. Deliberately English:
 * the model translates into the patient's language, and non-ASCII text costs
 * roughly 1.5x in the prompt budget for no gain.
 */
const AVAILABILITY_REASON_TEXT: Record<string, string> = {
  not_working_that_day: 'The doctor is not rostered to work that day.',
  fully_booked: 'The doctor works that day but every slot is already taken.',
  holiday: 'The clinic is closed that day for a holiday.',
  time_off: 'The doctor is on leave that day.',
  staff_inactive: 'This doctor is not currently taking bookings at all.',
  no_gap_long_enough:
    'The doctor has free time that day, but no single gap long enough for the selected service.',
  day_already_past: "That day's working hours have already finished.",
  no_availability: 'There are no bookable times on that day.',
};

/** What an availability tool hands back to the model. */
interface AvailabilityAnswer {
  timezone: string;
  requestedDate?: string;
  appointmentMinutes?: number;
  days: { date: string; slots: { startAt: string; localTime: string }[] }[];
  nextAvailable: {
    date: string;
    slots: { startAt: string; localTime: string }[];
  }[];
  slotCount: number;
  requestedDayReason?: string;
  requestedDayExplanation?: string;
  guidance: string;
}

/** Context for a tool execution, all bound server-side (never from the model). */
export interface ToolContext {
  tenantId: string;
  /** Authenticated user driving the AI turn — the booking actor (booked_by). */
  actorUserId?: string;
  /**
   * Permission slugs of the acting user (empty for anonymous/guest turns) —
   * the SAME array `PermissionsGuard` checks. Gates both the Dashboard
   * Assistant's admin tools AND the booking tools (mirrors the exact
   * permission the real Appointments controller requires for each action —
   * e.g. a CUSTOMER-role principal can create but not cancel/reschedule via
   * chat, same as they cannot via the REST API).
   */
  permissions?: string[];
  /**
   * The customer this conversation belongs to, when known server-side (e.g.
   * resolved from a WhatsApp contact) — used as the booking subject when the
   * model doesn't supply `customerId` itself. Never trusted from the model.
   */
  customerId?: string;
  aiConversationId: string;
  /** Optional linked human conversation (for audit). */
  conversationId?: string;
  /**
   * The server-verified acting principal. Public booking tools need it to prove
   * the guest owns this conversation before reading or writing its selections —
   * tenant scoping alone cannot do that, because every guest shares the one
   * discovery tenant.
   */
  principal?: AuthenticatedUser;
  /**
   * The transport this turn runs on ('WHATSAPP', 'WEBSOCKET', …), set by
   * `AiExecutionService`. Only used to decide whether a successful discovery call
   * is remembered for the next turn (see `remembered`) — never for authorisation.
   */
  channel?: string;
  /**
   * The persisted user message this turn is answering — set by `AiExecutionService`
   * from the row it just saved, never from the model or the client. Every tool
   * call in one turn shares it, so it is what lets the confirmation gate tell
   * "the patient replied" from "the model called the tool a second time" (F-04).
   * Absent means the caller cannot prove a later turn, so nothing is confirmable.
   */
  turnId?: string;
}

/** The structured result handed back to the model as the `tool` message. */
type ToolResult = Record<string, unknown>;

/**
 * How many services / doctors the WhatsApp ESTABLISHED BOOKING CONTEXT lists. The
 * block shares `AI_PROMPT_BOOKING_CONTEXT_TOKENS` (500) and is truncated from the
 * END; a clinic with more than this is pointed at the list tools for the rest.
 */
const WHATSAPP_CONTEXT_MAX_SERVICES = 8;
const WHATSAPP_CONTEXT_MAX_DOCTORS = 6;

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

/**
 * Executes the model's tool calls against the EXISTING domain services — the
 * model never writes to appointment tables.
 *
 * Safety properties:
 *  - Tenant is bound from context, never from tool arguments; every referenced
 *    resource is re-validated for tenant ownership inside the reused services.
 *  - Booking/reschedule/cancel go through AppointmentsService, which runs the
 *    transactional `assertBookable` race-safe double-booking check — no booking
 *    logic is duplicated here.
 *  - Every write tool is idempotent: a deterministic idempotency key + the
 *    `uq_ai_tool_call_idem` unique index means a retried or repeated booking
 *    executes at most once; a prior SUCCEEDED call replays its result.
 *  - AI-008/C1: for every one of the 26 tools, an attempted call — allowed,
 *    denied, or refused — produces exactly one queryable `ai_tool_calls`
 *    row (`contracts/ai-tool-call-ledger.md` §Guarantee). Two mechanisms,
 *    by design, not one: a business-action WRITE claims a real idempotency
 *    key via `run()` (PENDING → EXECUTING → SUCCEEDED/FAILED, replayable);
 *    a denial, a refusal, or one of the 7 session-state public tools
 *    records under the non-claiming `attempt:<tool>:<uuid>` namespace via
 *    `recordAttempt`/`recordSessionAttempt` (terminal on insert, never
 *    replayed). Claiming and recording are separable concerns (FR-023) —
 *    recording never depends on reaching the claim.
 */
@Injectable()
export class AiToolDispatchService {
  private readonly logger = new Logger('AiToolDispatchService');

  constructor(
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
    private readonly discovery: PublicDiscoveryService,
    private readonly dashboardMetrics: DashboardMetricService,
    private readonly subscriptions: SubscriptionService,
    private readonly usage: UsageService,
    private readonly customers: CustomerService,
    private readonly staff: StaffService,
    private readonly aiAnalytics: AiAnalyticsService,
    private readonly dataSource: DataSource,
    private readonly handovers: HandoverRequestService,
    /** `payment_required` business rule for the auto-payment-link decision. */
    private readonly tenants: TenantService,
    /** Reused verbatim — same create()/assertChargeable() path as the manual staff flow. */
    private readonly paymentLinks: PaymentLinkService,
    /** Resolves the SELECTED clinic's tenant from persisted session state. */
    private readonly bookingContext: PublicBookingContextService,
    /** The selected clinic's own least-privilege `ai-bot` principal. */
    private readonly botActor: WhatsappBotActorService,
    /** Used to run a public booking under that principal (never the guest's). */
    private readonly tenantContext: TenantContextService,
    /** AI-019/F1: backs the application-issued confirmation gate on irreversible actions. */
    private readonly sessions: ConversationSessionService,
    /** Own-clinic branch discovery for the WhatsApp channel toolset. */
    private readonly branches: BranchService,
  ) {}

  /** Parse + route one tool call. Never throws — returns a result for the model. */
  async execute(ctx: ToolContext, call: AiToolCall): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return {
        success: false,
        error: 'Invalid tool arguments (not valid JSON).',
      };
    }

    try {
      switch (call.name) {
        case AI_TOOL.SEARCH_CLINICS:
          return await this.searchClinics(ctx, args);
        case AI_TOOL.GET_CLINIC_DETAILS:
          return await this.getClinicDetails(ctx, args);
        case AI_TOOL.SEARCH_PUBLIC_AVAILABILITY:
          return await this.searchPublicAvailability(ctx, args);
        case AI_TOOL.GET_BRANCH_INFO:
          return await this.remembered(
            ctx,
            args,
            await this.getBranchInfo(ctx, args),
          );
        case AI_TOOL.GET_DOCTOR_SCHEDULE:
          return await this.remembered(
            ctx,
            args,
            await this.getDoctorSchedule(ctx, args),
          );
        case AI_TOOL.LIST_CLINIC_BRANCHES: {
          const branchList = await this.listClinicBranches(ctx);
          // A clinic with ONE branch has no choice to make: that branch is the
          // working branch from the first call on.
          const only =
            Array.isArray(branchList.branches) &&
            branchList.branches.length === 1
              ? (branchList.branches[0] as { id?: string }).id
              : undefined;
          return await this.remembered(ctx, { branchId: only }, branchList);
        }
        case AI_TOOL.LIST_CLINIC_DOCTORS:
          return await this.remembered(
            ctx,
            args,
            await this.listClinicDoctors(ctx, args),
          );
        case AI_TOOL.LIST_CLINIC_SERVICES:
          return await this.remembered(
            ctx,
            args,
            await this.listClinicServices(ctx, args),
          );
        case AI_TOOL.CHECK_AVAILABILITY:
          return await this.remembered(
            ctx,
            args,
            await this.checkAvailability(ctx, args),
          );
        case AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS:
          return await this.getCustomerInsuranceStatus(ctx, args);
        case AI_TOOL.BOOK_APPOINTMENT:
          return await this.bookAppointment(ctx, args);
        case AI_TOOL.RESCHEDULE_APPOINTMENT:
          return await this.rescheduleAppointment(ctx, args);
        case AI_TOOL.CANCEL_APPOINTMENT:
          return await this.cancelAppointment(ctx, args);
        case AI_TOOL.LIST_MY_APPOINTMENTS:
          return await this.listMyAppointments(ctx);
        case AI_TOOL.REQUEST_HUMAN_HANDOVER:
          return await this.requestHumanHandover(ctx, args);
        // ── Public booking (anonymous visitors) ────────────────────────────
        // Recorded like its siblings: it used to return without writing any
        // row at all, so a booking that dead-ended at the city step left no
        // trace in `ai_tool_calls` and the failure was invisible to the
        // monitoring surfaces.
        case AI_PUBLIC_TOOL.LIST_CITIES:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.listCities(),
          );
        // AI-008/C1 (FR-026): these 7 session-state tools never call
        // run() — recordSessionAttempt records one attempt-only row per
        // call, on the same terms as a denial, regardless of outcome.
        case AI_PUBLIC_TOOL.SELECT_CLINIC:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.selectClinic(ctx, args),
          );
        case AI_PUBLIC_TOOL.SELECT_BRANCH:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.selectBranch(ctx, args),
          );
        case AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.listBranchServices(ctx),
          );
        case AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.listBranchDoctors(ctx),
          );
        case AI_PUBLIC_TOOL.SELECT_SERVICE:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.selectService(ctx, args),
          );
        case AI_PUBLIC_TOOL.SELECT_DOCTOR:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.selectDoctor(ctx, args),
          );
        case AI_PUBLIC_TOOL.SELECT_SLOT:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.selectSlot(ctx, args),
          );
        case AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT:
          return await this.bookPublicAppointment(ctx, args);
        case AI_ADMIN_TOOL.GET_DASHBOARD_KPIS:
        case AI_ADMIN_TOOL.GET_SUBSCRIPTION_STATUS:
        case AI_ADMIN_TOOL.GET_USAGE_QUOTA:
        case AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW:
        case AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW:
        case AI_ADMIN_TOOL.GET_STAFF_OVERVIEW:
        case AI_ADMIN_TOOL.GET_AI_USAGE_REPORT:
        case AI_ADMIN_TOOL.GET_AI_MONITORING_SUMMARY:
          return await this.executeAdminTool(ctx, call.name, args);
        default:
          return { success: false, error: `Unknown tool "${call.name}".` };
      }
    } catch (err) {
      // Defensive: business errors are handled per-tool; this catches the rest.
      return { success: false, error: this.msg(err) };
    }
  }

  // ───────────────────────── Dashboard Assistant tools ────────────────────── //

  /**
   * Permission-gated dispatch for the read-only admin toolset. Every branch
   * delegates to an EXISTING tenant-scoped service — no new queries. A
   * denied call is recorded as its own terminal `DENIED` row via
   * `recordAttempt` (AI-008, T067) — a namespaced attempt key, never a
   * claim, so a retried denial can never race a legitimate later grant.
   */
  private async executeAdminTool(
    ctx: ToolContext,
    name: AiAdminToolName,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const required = AI_ADMIN_TOOL_PERMISSION[name];
    if (!(ctx.permissions ?? []).includes(required)) {
      const reason = `Forbidden: this question requires the "${required}" permission.`;
      await this.recordAttempt(ctx, name, args, 'DENIED', reason);
      return { success: false, error: reason };
    }

    return this.run(
      ctx,
      name,
      `admin:${name}:${randomUUID()}`,
      args,
      async () => {
        const data = await this.runAdminTool(ctx, name, args);
        return {
          toolResult: { success: true, ...data },
          resultJson: { tool: name },
        };
      },
    );
  }

  private async runAdminTool(
    ctx: ToolContext,
    name: AiAdminToolName,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case AI_ADMIN_TOOL.GET_DASHBOARD_KPIS: {
        const rows = await this.dashboardMetrics.getMetrics(ctx.tenantId, {});
        const kpis: Record<string, unknown> = {};
        for (const r of rows)
          kpis[r.metric_key] =
            r.metric_value != null ? Number(r.metric_value) : null;
        return { kpis };
      }
      case AI_ADMIN_TOOL.GET_SUBSCRIPTION_STATUS: {
        const sub = await this.subscriptions.getCurrent(ctx.tenantId);
        return { subscription: sub };
      }
      case AI_ADMIN_TOOL.GET_USAGE_QUOTA: {
        const breakdown = await this.usage.getBreakdown(ctx.tenantId);
        return { usage: breakdown };
      }
      case AI_ADMIN_TOOL.GET_APPOINTMENT_OVERVIEW: {
        // Same ownership scoping the REST endpoint applies: if the acting
        // user only holds appointments.read_own (e.g. a doctor), this
        // overview is scoped to their own appointments too — never a way to
        // see tenant-wide totals through chat that the REST API would deny.
        const result = await this.appointments.findAll(
          ctx.tenantId,
          {
            status: this.str(args.status) as never,
            from: this.str(args.from),
            to: this.str(args.to),
            page: 1,
            limit: 1,
          } as never,
          { id: ctx.actorUserId ?? '', permissions: ctx.permissions ?? [] },
        );
        return {
          totalAppointments: result.total,
          filters: { status: args.status, from: args.from, to: args.to },
        };
      }
      case AI_ADMIN_TOOL.GET_PATIENT_OVERVIEW: {
        const result = await this.customers.list(ctx.tenantId, {
          isActive:
            typeof args.isActive === 'boolean' ? args.isActive : undefined,
          page: 1,
          limit: 1,
        } as never);
        return { totalPatients: result.total };
      }
      case AI_ADMIN_TOOL.GET_STAFF_OVERVIEW: {
        const result = await this.staff.findAll(ctx.tenantId, {
          branchId: this.str(args.branchId),
          page: 1,
          limit: 1,
        } as never);
        return { totalStaff: result.total };
      }
      case AI_ADMIN_TOOL.GET_AI_USAGE_REPORT:
        return this.aiAnalytics.usage(ctx.tenantId, {
          from: this.str(args.from),
          to: this.str(args.to),
        });
      case AI_ADMIN_TOOL.GET_AI_MONITORING_SUMMARY:
        return this.aiAnalytics.conversations(ctx.tenantId, {
          from: this.str(args.from),
          to: this.str(args.to),
        });
      default:
        return {};
    }
  }

  // ───────────────────────── Public discovery tools ──────────────────────── //

  /**
   * Cross-tenant public clinic search — read-only, safe for anonymous chats.
   *
   * TWO things changed here, both of them causes of the "no clinics available"
   * dead end:
   *
   *  1. `cityId` is now honoured. `PublicDiscoveryService.searchClinics` has
   *     always taken a city (the REST endpoint passes one), but the TOOL schema
   *     exposed only `query` — which matches clinic/slug/service names and
   *     nothing else. So the one thing the model had after asking "which city?"
   *     was a city NAME, and the only place to put it was `query`, where it
   *     matched nothing and produced a confident "there are no clinics".
   *  2. An accepted `cityId` is RECORDED on the session, server-side, after the
   *     database has confirmed the city exists. That is what lets the next turn
   *     continue instead of starting over — see
   *     `PublicBookingContextService.describeSelection`.
   */
  private async searchClinics(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = this.str(args.query);
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    // Validate BEFORE recording: the session only ever holds ids the database
    // confirmed, so an id the model invented is rejected here rather than
    // stored and trusted later. The SHAPE is checked first because `findCity`
    // casts to `uuid` — a city NAME passed here would raise in the driver
    // instead of simply not matching.
    const citySupplied = !!this.str(args.cityId);
    const cityId = this.uuid(args.cityId);
    const city = cityId ? await this.discovery.findCity(cityId) : null;
    if (citySupplied && !city) {
      return {
        success: false,
        error:
          'That cityId is not a city the platform knows. Pass the UUID exactly as list_cities returned it — never a city name — or call search_clinics with no cityId to search every bookable clinic.',
      };
    }

    return this.run(
      ctx,
      AI_TOOL.SEARCH_CLINICS,
      `search_clinics:${randomUUID()}`,
      args,
      async () => {
        const clinics = await this.discovery.searchClinics(
          query,
          limit,
          city?.id,
        );

        // Public (guest) turns only. A staff turn shares this tool but has no
        // public booking session to carry, and writing one would be noise.
        if (city && ctx.principal?.guest) {
          await this.bookingContext.patchSelection(
            ctx.tenantId,
            ctx.aiConversationId,
            { selectedCityId: city.id },
          );
        }

        return {
          toolResult: {
            success: true,
            count: clinics.length,
            clinics,
            ...(city ? { cityId: city.id, cityRecorded: true } : {}),
            // Spelled out because the two ids are both uuids and sit in the
            // same result: a model that grabbed `cityId` and passed it to
            // select_clinic got a bare "Clinic not found" and gave up.
            ...(clinics.length > 0
              ? {
                  usage:
                    'To choose one of these, pass its own `clinics[].id` to select_clinic. The `cityId` in this result is the search filter, never a clinic.',
                }
              : {}),
            ...(clinics.length === 0
              ? {
                  guidance: city
                    ? 'No bookable clinic has a branch in that city. Retry with no cityId before telling the visitor there is nothing available.'
                    : 'No clinic is currently opted in to public booking. Say so plainly and offer a human handover.',
                }
              : {}),
          },
          resultJson: { count: clinics.length, cityId: city?.id ?? null },
        };
      },
    );
  }

  /** Branches, doctors and services (with prices) for a chosen clinic. */
  private async getClinicDetails(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const clinicId = this.uuid(args.clinicId);
    if (!clinicId) return this.badId('clinicId', 'search_clinics');
    return this.run(
      ctx,
      AI_TOOL.GET_CLINIC_DETAILS,
      `clinic_details:${randomUUID()}`,
      args,
      async () => {
        const detail = await this.discovery.clinicDetail(clinicId);
        return {
          toolResult: { success: true, ...detail },
          resultJson: { clinicId },
        };
      },
    );
  }

  /**
   * REAL bookable times for a publicly-discovered clinic's branch + doctor,
   * over a DATE RANGE rather than a single day.
   *
   * THE BUG THIS FIXES. This tool used to take one mandatory `date` and return
   * a bare `windows: []` when that day had nothing — no reason, no alternative.
   * The assistant could only translate that into "the doctor is unavailable",
   * and since every follow-up question hit the same dead end it repeated the
   * same sentence turn after turn. Three changes close that:
   *
   *  1. `date` is now OPTIONAL — omitted, it answers the open-ended "when is
   *     the doctor free?" from today onward, in the BRANCH's timezone.
   *  2. When the requested day is empty, the search CONTINUES forward and the
   *     result carries `nextAvailable`. The model cannot fail to offer
   *     alternatives, because they are already in its hand.
   *  3. Slot length comes from the SELECTED SERVICE, resolved server-side —
   *     never from the model, and never absent. Previously `slotMinutes` was
   *     an optional model argument that in practice was never sent, so the
   *     tool returned raw 10:00–20:00 windows and the model invented times
   *     inside them, including ones too short for the actual appointment.
   */
  private async searchPublicAvailability(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // Ids are OPTIONAL now: on the public widget the branch and doctor already
    // live on the server-side booking session, so the model has nothing to get
    // wrong (and nothing an injection could redirect). An explicitly supplied
    // id is still honoured and still fully validated downstream.
    const resolved = await this.resolveBranchAndStaff(ctx, args);
    if ('error' in resolved) return resolved.error;
    const { branchId, staffId, serviceMinutes } = resolved;

    const date = this.str(args.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        success: false,
        error:
          'date must be YYYY-MM-DD, resolved from the date in the context block.',
      };
    }

    return this.run(
      ctx,
      AI_TOOL.SEARCH_PUBLIC_AVAILABILITY,
      `pub_avail:${randomUUID()}`,
      args,
      async () => {
        const result = await this.availabilityAnswer(
          (from, to, slotMinutes, maxDays) =>
            this.discovery.publicRangeAvailability(branchId, staffId, {
              fromDate: from,
              toDate: to,
              slotMinutes,
              maxDaysWithSlots: maxDays,
              notBefore: new Date(),
            }),
          {
            branchId,
            requestedDate: date,
            daysAhead: args.daysAhead,
            slotMinutes: serviceMinutes,
          },
        );
        return {
          toolResult: { success: true, ...result },
          resultJson: {
            branchId,
            staffId,
            requestedDate: result.requestedDate ?? null,
            slotCount: result.slotCount,
          },
        };
      },
    );
  }

  /**
   * The shared "answer an availability question" routine behind both
   * `search_public_availability` and `check_availability`.
   *
   * It exists so the two channels cannot drift on the part that actually
   * matters — the FALLBACK. `search` is the only thing that differs between
   * them (public tenant-from-branch resolution vs. tenant-from-context), and
   * it is injected; every rule about what to search, how far, and what to say
   * when a day is empty lives here, once.
   *
   * COST. The first pass asks only for the requested day. A second pass runs
   * ONLY if that day came back empty, and stops as soon as
   * `MAX_ALTERNATIVE_DAYS` days with slots are found — so the normal
   * "yes, Tuesday works" path costs exactly one day's queries.
   */
  private async availabilityAnswer(
    search: (
      fromDate: string,
      toDate: string,
      slotMinutes: number | undefined,
      maxDaysWithSlots: number | undefined,
    ) => Promise<{ timezone: string; days: DayWindows[] }>,
    opts: {
      branchId: string;
      requestedDate?: string;
      daysAhead?: unknown;
      slotMinutes?: number;
    },
  ): Promise<AvailabilityAnswer> {
    const horizon = Math.min(
      Math.max(
        typeof opts.daysAhead === 'number' && Number.isFinite(opts.daysAhead)
          ? Math.trunc(opts.daysAhead)
          : DEFAULT_AVAILABILITY_DAYS,
        1,
      ),
      PUBLIC_AVAILABILITY_HORIZON_DAYS,
    );

    // The branch's own timezone decides what "today" is — not the server's and
    // not the visitor's. A branch in Asia/Riyadh is already on tomorrow while a
    // visitor in Europe is still on today, and the availability engine reads
    // `date` as the BRANCH's local calendar date.
    const zone = await this.branchZone(opts.branchId);
    const today = zonedYmd(new Date(), zone);
    const from =
      opts.requestedDate && opts.requestedDate > today
        ? opts.requestedDate
        : today;

    // Pass 1 — exactly the day asked about (or today when open-ended).
    const first = await search(
      from,
      opts.requestedDate ? from : this.addDays(from, horizon - 1),
      opts.slotMinutes,
      opts.requestedDate ? undefined : MAX_ALTERNATIVE_DAYS,
    );
    const withSlots = first.days.filter((d) => d.available);
    if (withSlots.length > 0) {
      return this.availabilityPayload(first.timezone, withSlots, [], {
        requestedDate: opts.requestedDate,
        requestedDayReason: undefined,
        slotMinutes: opts.slotMinutes,
      });
    }

    // Pass 2 — nothing on the requested day. Keep looking instead of reporting
    // a dead end; THIS is what the old single-day tool could never do.
    const requestedDayReason = first.days[0]?.reason ?? 'no_availability';
    const alt = await search(
      this.addDays(from, 1),
      this.addDays(from, horizon),
      opts.slotMinutes,
      MAX_ALTERNATIVE_DAYS,
    );
    return this.availabilityPayload(
      alt.timezone,
      [],
      alt.days.filter((d) => d.available),
      {
        requestedDate: opts.requestedDate,
        requestedDayReason,
        slotMinutes: opts.slotMinutes,
      },
    );
  }

  /** Model-facing shape: local times, an explicit reason, and explicit guidance. */
  private availabilityPayload(
    timezone: string,
    days: DayWindows[],
    nextAvailable: DayWindows[],
    meta: {
      requestedDate?: string;
      requestedDayReason?: string;
      slotMinutes?: number;
    },
  ): AvailabilityAnswer {
    const render = (list: DayWindows[]) =>
      list.map((d) => ({
        date: d.date,
        // Times are rendered in the BRANCH's zone as well as ISO. The model
        // was previously handed only UTC instants and had to convert them
        // itself to tell a patient "2 PM" — a step it got wrong.
        slots: d.windows.map((w) => ({
          startAt: w.startTime,
          localTime: this.localHhmm(w.startTime, timezone),
        })),
      }));

    const slotCount =
      days.reduce((s, d) => s + d.windows.length, 0) +
      nextAvailable.reduce((s, d) => s + d.windows.length, 0);

    return {
      timezone,
      ...(meta.requestedDate ? { requestedDate: meta.requestedDate } : {}),
      ...(meta.slotMinutes ? { appointmentMinutes: meta.slotMinutes } : {}),
      days: render(days),
      nextAvailable: render(nextAvailable),
      slotCount,
      ...(meta.requestedDayReason
        ? {
            requestedDayReason: meta.requestedDayReason,
            requestedDayExplanation:
              AVAILABILITY_REASON_TEXT[meta.requestedDayReason] ??
              'There are no bookable times on that day.',
          }
        : {}),
      guidance:
        slotCount > 0
          ? meta.requestedDayReason
            ? 'The requested day has nothing — say why (requestedDayExplanation), then offer the times in `nextAvailable` with their dates. Do NOT stop at "unavailable".'
            : 'Offer these times using `localTime`, grouped by date. Never invent a time that is not listed.'
          : 'Nothing is bookable in the searched window. Say so plainly, give the reason, and offer to connect the visitor with the clinic team — do not repeat the same refusal if they ask again.',
    };
  }

  /**
   * WHERE a branch is and WHEN it is open.
   *
   * On the public widget it takes NO arguments — the branch comes from the
   * server-side booking session, so there is no id for a prompt injection to
   * point at another clinic. On an authenticated channel (WhatsApp / staff)
   * `branchId` is required and is scoped to `ctx.tenantId`, so it can only
   * ever resolve a branch this clinic owns.
   */
  private async getBranchInfo(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const guest = this.isGuest(ctx);
    let branchId = this.uuid(args.branchId);
    if (guest) {
      const fromSession = await this.sessionBranch(ctx);
      if ('error' in fromSession) return fromSession.error;
      branchId = fromSession.branchId;
    } else if (!branchId) {
      return this.badId('branchId', 'list_clinic_branches');
    }

    return this.run(
      ctx,
      AI_TOOL.GET_BRANCH_INFO,
      `branch_info:${randomUUID()}`,
      args,
      async () => {
        const info = await this.discovery.branchInfo(branchId!, {
          // Guests have no tenant of their own; the public eligibility
          // predicate applies instead. Staff/WhatsApp turns are scoped to
          // their own clinic and nothing else.
          tenantId: guest ? undefined : ctx.tenantId,
        });
        const published = info.workingHours.filter((d) => d.status === 'OPEN');
        return {
          toolResult: {
            success: true,
            ...info,
            guidance: info.workingHoursConfigured
              ? `Report only the days listed. ${published.length} day(s) are OPEN; a day marked CLOSED is a closure the clinic set, and NOT_PUBLISHED means the clinic never entered hours for it — say that, never "we are closed" and never a guessed time.`
              : 'This clinic has NOT published any working hours. Say exactly that and offer to connect the visitor with the clinic team. Never invent hours.',
          },
          resultJson: {
            branchId,
            workingHoursConfigured: info.workingHoursConfigured,
            openDays: published.length,
          },
        };
      },
    );
  }

  /**
   * A doctor's recurring weekly roster — "when does Dr. X work?", which the
   * assistant previously answered by running an availability check for one
   * arbitrary day and reporting its failure.
   *
   * Same id posture as `getBranchInfo`: session-resolved for a guest,
   * tenant-scoped for an authenticated turn.
   */
  private async getDoctorSchedule(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const guest = this.isGuest(ctx);
    let tenantId = ctx.tenantId;
    let branchId = this.uuid(args.branchId);
    let staffId = this.uuid(args.staffId);

    if (guest) {
      const booking = await this.requirePublicContext(ctx, 'doctor');
      tenantId = booking.tenantId;
      branchId = booking.branchId;
      staffId = booking.staffId!;
    } else if (!branchId || !staffId) {
      return this.badId(
        'branchId and staffId',
        'list_clinic_branches / list_clinic_doctors',
      );
    }

    return this.run(
      ctx,
      AI_TOOL.GET_DOCTOR_SCHEDULE,
      `doctor_schedule:${randomUUID()}`,
      args,
      async () => {
        const schedule = await this.discovery.doctorSchedule(
          tenantId,
          branchId!,
          staffId!,
        );
        return {
          toolResult: {
            success: true,
            ...schedule,
            guidance: schedule.weekly.length
              ? "These are the doctor's working days. If the visitor wants to BOOK, follow this with the availability tool — a rostered day can still be fully booked."
              : 'This doctor has no working days configured at this branch. Say so and offer another doctor or the clinic team; do not present it as a temporary shortage.',
          },
          resultJson: {
            branchId,
            staffId,
            workingDays: schedule.weekly.length,
          },
        };
      },
    );
  }

  // ─────────────────── Availability resolution helpers ───────────────────── //

  /**
   * Branch + doctor for an availability query, and the SERVICE DURATION the
   * slots must be sized to.
   *
   * On the public widget all three come from the server-side booking session —
   * the same source the booking itself uses — so the slot length offered to the
   * visitor is by construction the length that will actually be booked. The
   * deterministic REST flow (`PublicBookingFlowService.availability`) already
   * derived it this way; the AI path did not, which is why it offered raw
   * open-hours windows instead of bookable slots.
   */
  private async resolveBranchAndStaff(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<
    | { branchId: string; staffId: string; serviceMinutes?: number }
    | { error: ToolResult }
  > {
    if (this.isGuest(ctx)) {
      let booking;
      try {
        booking = await this.requirePublicContext(ctx, 'doctor');
      } catch (err) {
        return {
          error: {
            success: false,
            error: this.msg(err),
          },
        };
      }
      return {
        branchId: booking.branchId,
        staffId: booking.staffId!,
        serviceMinutes: await this.selectedServiceMinutes(
          booking.tenantId,
          booking.branchId,
          booking.serviceIds,
        ),
      };
    }

    const branchId = this.uuid(args.branchId);
    const staffId = this.uuid(args.staffId);
    if (!branchId || !staffId) {
      return {
        error: this.badId(
          'branchId and staffId',
          'get_clinic_details / list_branch_doctors',
        ),
      };
    }
    return { branchId, staffId };
  }

  /** Branch resolved from the public booking session, as a tool-shaped result. */
  private async sessionBranch(
    ctx: ToolContext,
  ): Promise<{ branchId: string } | { error: ToolResult }> {
    try {
      const booking = await this.requirePublicContext(ctx, 'branch');
      return { branchId: booking.branchId };
    } catch (err) {
      return { error: { success: false, error: this.msg(err) } };
    }
  }

  /**
   * Total duration of the services this conversation selected — the real length
   * of the appointment being booked, so a 45-minute service never gets offered
   * a 30-minute gap. Zero selected services returns `undefined`, which leaves
   * the engine returning whole free windows exactly as before.
   */
  private async selectedServiceMinutes(
    tenantId: string,
    branchId: string,
    serviceIds: string[],
  ): Promise<number | undefined> {
    if (!serviceIds?.length) return undefined;
    const offered = await this.discovery.listBranchServices(tenantId, branchId);
    const byId = new Map<string, number>(
      offered.map((s) => [s.id, Number(s.durationMinutes) || 0]),
    );
    const total = serviceIds.reduce((sum, id) => sum + (byId.get(id) ?? 0), 0);
    return total > 0 ? total : undefined;
  }

  /** The branch's IANA zone — what "today" and every local time mean here. */
  private async branchZone(branchId: string): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT timezone FROM branches WHERE id = $1::uuid LIMIT 1`,
      [branchId],
    );
    return safeZone(rows[0]?.timezone as string | undefined);
  }

  /** 'HH:MM' of an ISO instant in `zone` — what the patient is actually told. */
  private localHhmm(iso: string, zone: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(iso));
    } catch {
      return iso.slice(11, 16);
    }
  }

  /** `days` calendar days after a YYYY-MM-DD, as YYYY-MM-DD. */
  private addDays(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  }

  // ───────────────── WhatsApp booking working set (F-28) ───────────────── //
  //
  // Tool results live for one turn: only user and assistant messages are replayed,
  // so on the patient's next message the model had no branch id, no doctor id and
  // no price, and re-ran discovery from the top — five calls before it could book,
  // against a loop that allowed four. The public widget solved this with a pinned,
  // server-verified block built from `selected*` session keys; this is the same
  // mechanism for the own-clinic toolset.
  //
  // What is stored is ONLY two ids (the branch and the doctor a successful call
  // last used), in the existing server-write-only `selectedBranchId` /
  // `selectedDoctorId` keys. Everything the model is shown is re-read from the
  // database each turn (`describeOwnClinicContext`), so a branch closed or a
  // doctor removed since simply drops out instead of being pinned stale.

  /**
   * Passes `result` through untouched; on a SUCCESSFUL WhatsApp call records the
   * branch / doctor it used. `args` are the model's, so each id is shape-checked
   * before it is written and re-proved against the tenant before it is ever shown.
   */
  private async remembered(
    ctx: ToolContext,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<ToolResult> {
    if (
      ctx.channel === 'WHATSAPP' &&
      !this.isGuest(ctx) &&
      result.success !== false
    ) {
      await this.rememberOwnClinicSelection(ctx, {
        branchId: this.uuid(args.branchId),
        staffId: this.uuid(args.staffId),
      });
    }
    return result;
  }

  /** Best effort: a failed note must never fail the tool call that produced it. */
  private async rememberOwnClinicSelection(
    ctx: ToolContext,
    ids: { branchId?: string; staffId?: string },
  ): Promise<void> {
    if (!ids.branchId && !ids.staffId) return;
    try {
      const prior = await this.sessions.get(ctx.tenantId, ctx.aiConversationId);
      const patch: Parameters<
        PublicBookingContextService['patchSelection']
      >[2] = {};
      if (ids.branchId && ids.branchId !== prior.selectedBranchId) {
        patch.selectedBranchId = ids.branchId;
        // A doctor belongs to one branch's roster: moving to another branch
        // drops the previous doctor unless this same call names one.
        patch.selectedDoctorId = SESSION_UNSET;
      }
      if (ids.staffId && ids.staffId !== prior.selectedDoctorId) {
        patch.selectedDoctorId = ids.staffId;
      }
      if (Object.keys(patch).length === 0) return;
      await this.bookingContext.patchSelection(
        ctx.tenantId,
        ctx.aiConversationId,
        patch,
      );
    } catch (err) {
      this.logger.warn(
        `could not remember the booking working set for ${ctx.aiConversationId}: ${this.msg(err)}`,
      );
    }
  }

  /**
   * The ESTABLISHED BOOKING CONTEXT block for a WHATSAPP turn, or `null` when the
   * conversation has not worked on a branch yet (a first turn costs no prompt
   * budget) or the branch it worked on is gone.
   *
   * Every line is read from the database now, through the same discovery
   * queries the tools use, so the block can never disagree with a tool result.
   * Ordered most-valuable-first because the budget truncates from the END.
   */
  async describeOwnClinicContext(
    tenantId: string,
    aiConversationId: string,
  ): Promise<string | null> {
    const session = await this.sessions.get(tenantId, aiConversationId);
    const branchId = this.uuid(session.selectedBranchId);
    if (!branchId) return null;

    const branches = (await this.branches.findAll(tenantId)).filter(
      (b) => b.is_active,
    );
    const branch = branches.find((b) => b.id === branchId);
    if (!branch) return null;

    const [doctors, services] = await Promise.all([
      this.discovery.listBranchDoctors(tenantId, branchId),
      this.discovery.listBranchServices(tenantId, branchId),
    ]);

    const lines: string[] = [
      `branch: ${this.oneLine(branch.name)}${
        branch.address ? ` (${this.oneLine(branch.address)})` : ''
      } (id ${branch.id})`,
    ];

    const doctorId = this.uuid(session.selectedDoctorId);
    if (doctorId) {
      const doctor = doctors.find((x) => x.id === doctorId);
      lines.push(
        doctor
          ? `doctor last used: ${this.oneLine(doctor.name)} (id ${doctor.id})`
          : 'CLEARED (no longer valid, ask the patient again): doctor',
      );
    }

    const shownServices = services.slice(0, WHATSAPP_CONTEXT_MAX_SERVICES);
    if (shownServices.length) {
      lines.push(
        'services at this branch (price exactly as the clinic published it):',
      );
      for (const s of shownServices) {
        const price =
          s.price == null
            ? 'price NOT PUBLISHED — never a number, never "free"'
            : `price ${s.price}`;
        lines.push(
          `  - ${this.oneLine(s.name)} (id ${s.id}): ${s.durationMinutes} min, ${price}`,
        );
      }
      if (services.length > shownServices.length) {
        lines.push(
          `  (${services.length - shownServices.length} more — call list_clinic_services)`,
        );
      }
    }

    const shownDoctors = doctors.slice(0, WHATSAPP_CONTEXT_MAX_DOCTORS);
    if (shownDoctors.length) {
      lines.push(
        `doctors at this branch: ${shownDoctors
          .map((x) => `${this.oneLine(x.name)} (id ${x.id})`)
          .join('; ')}${
          doctors.length > shownDoctors.length
            ? ` (+${doctors.length - shownDoctors.length} more — call list_clinic_doctors)`
            : ''
        }`,
      );
    }

    const others = branches.filter((b) => b.id !== branchId);
    if (others.length) {
      lines.push(
        `other branches: ${others
          .slice(0, 5)
          .map((b) => `${this.oneLine(b.name)} (id ${b.id})`)
          .join('; ')}`,
      );
    }

    return [
      'ESTABLISHED BOOKING CONTEXT (re-read from the database this turn).',
      'These ids and prices came from earlier tool calls in this conversation. Use them directly instead of looking them up again, and never show an id to the patient. For a different branch, call list_clinic_doctors / list_clinic_services with that branch.',
      ...lines.map((l) => (l.startsWith('  ') ? l : `- ${l}`)),
    ].join('\n');
  }

  /**
   * Clinic-owned text (a branch, service or doctor name) placed in a SYSTEM
   * message: collapsed to one short line so a name can neither break the block's
   * structure nor carry a paragraph of instructions into it.
   */
  private oneLine(text: string | null | undefined): string {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  // ───────────────────────── Own-clinic discovery (WhatsApp) ─────────────── //
  //
  // Tenant-bound equivalent of the guest discovery tools above, for a channel
  // (WhatsApp) whose turns are AUTHENTICATED (the tenant's own bot actor,
  // never a guest) and therefore have no public booking session to resolve a
  // branch from, and no `clinicId` to pass get_clinic_details — the acting
  // principal already represents exactly one clinic: `ctx.tenantId`.
  //
  // Every method below takes its tenant ONLY from `ctx.tenantId`. `branchId`
  // is re-validated for ownership before any doctor/service lookup — a
  // branch belonging to another tenant must produce a plain refusal, never
  // data (matches `badId`'s existing non-oracle posture for a malformed id).

  /** THIS clinic's own active branches — id, name, address only (no phone/timezone). */
  private async listClinicBranches(ctx: ToolContext): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    return this.run(
      ctx,
      AI_TOOL.LIST_CLINIC_BRANCHES,
      `clinic_branches:${randomUUID()}`,
      {},
      async () => {
        const all = await this.branches.findAll(ctx.tenantId);
        const branches = all
          .filter((b) => b.is_active)
          .map((b) => ({
            id: b.id,
            name: b.name,
            address: b.address ?? null,
          }));
        return {
          toolResult: { success: true, count: branches.length, branches },
          resultJson: { count: branches.length },
        };
      },
    );
  }

  /** Doctors at one of THIS clinic's own branches. */
  private async listClinicDoctors(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    const branchId = this.uuid(args.branchId);
    if (!branchId) return this.badId('branchId', 'list_clinic_branches');

    return this.run(
      ctx,
      AI_TOOL.LIST_CLINIC_DOCTORS,
      `clinic_doctors:${randomUUID()}`,
      args,
      async () => {
        // Ownership check INSIDE the executor, before the lookup: a branch
        // id from another tenant must refuse plainly (recorded as a normal
        // FAILED_PERMANENT ledger row via AppError, same as getClinicDetails'
        // not-found path) rather than silently returning an empty doctor
        // list — which reads to the model as "this branch has no doctors"
        // and invites a wrong answer to the patient.
        await this.branches.findOne(ctx.tenantId, branchId);
        const doctors = await this.discovery.listBranchDoctors(
          ctx.tenantId,
          branchId,
        );
        return {
          toolResult: { success: true, count: doctors.length, doctors },
          resultJson: { branchId, count: doctors.length },
        };
      },
    );
  }

  /** Services (with prices) at one of THIS clinic's own branches. */
  private async listClinicServices(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    const branchId = this.uuid(args.branchId);
    if (!branchId) return this.badId('branchId', 'list_clinic_branches');

    return this.run(
      ctx,
      AI_TOOL.LIST_CLINIC_SERVICES,
      `clinic_services:${randomUUID()}`,
      args,
      async () => {
        // See listClinicDoctors' identical comment above.
        await this.branches.findOne(ctx.tenantId, branchId);
        const services = await this.discovery.listBranchServices(
          ctx.tenantId,
          branchId,
        );
        return {
          toolResult: {
            success: true,
            count: services.length,
            ...this.servicesForModel(services),
          },
          resultJson: { branchId, count: services.length },
        };
      },
    );
  }

  // ─────────────────────────────── Tools ─────────────────────────────────── //

  /** Read-only — no idempotency dedup, but still audited. */
  private async checkAvailability(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // AI-020/PD-2: this staff-facing tool carries no permission requirement
    // of its own (any authenticated staff turn may check availability), but
    // it was reachable by an unauthenticated guest turn too, despite never
    // being part of the advertised guest catalog — closing the gap
    // narrowly, on the same "no acting user" precondition already used by
    // the core write tools (bookAppointment et al.), rather than widening
    // what guests are advertised.
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'This tool is not available in this context (no acting user).',
      };
    }
    const branchId = this.uuid(args.branchId);
    const staffId = this.uuid(args.staffId);
    const date = this.str(args.date);
    if (!branchId || !staffId) {
      return {
        success: false,
        error: 'branchId and staffId are required.',
      };
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, error: 'date must be YYYY-MM-DD.' };
    }
    return this.run(
      ctx,
      AI_TOOL.CHECK_AVAILABILITY,
      `check:${randomUUID()}`,
      args,
      async () => {
        // Same fallback contract as the public tool — one shared routine, so
        // the WhatsApp/staff channel can never regress to "unavailable, full
        // stop" while the widget offers alternatives.
        const result = await this.availabilityAnswer(
          (from, to, slotMinutes, maxDays) =>
            this.availability.rangeWindows(ctx.tenantId, {
              branchId,
              staffId,
              fromDate: from,
              toDate: to,
              slotMinutes,
              maxDaysWithSlots: maxDays,
              notBefore: new Date(),
            }),
          {
            branchId,
            requestedDate: date,
            daysAhead: args.daysAhead,
            slotMinutes:
              typeof args.slotMinutes === 'number'
                ? args.slotMinutes
                : undefined,
          },
        );
        return {
          toolResult: { success: true, ...result },
          resultJson: {
            branchId,
            staffId,
            requestedDate: result.requestedDate ?? null,
            slotCount: result.slotCount,
          },
        };
      },
    );
  }

  /**
   * Read-only lookup of the patient's on-file insurance answer, so the model
   * can confirm a returning patient's answer instead of asking cold every
   * time. Gated (AI-003): the server-bound customer for this conversation
   * needs no extra permission, but an id the model merely supplied in
   * `args` — not already bound — requires a real `customers.read`
   * permission, or one call per known id enumerates the whole tenant's
   * insurance-status roster.
   */
  private async getCustomerInsuranceStatus(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // AI-020/PD-2: same "no acting user" narrowing as checkAvailability
    // above — this staff-facing tool was reachable by an unauthenticated
    // guest turn despite never being advertised to guests. The AI-003 gate
    // below still applies for authenticated staff supplying an unbound
    // customerId; this precondition additionally closes the guest gap the
    // AI-003 gate alone did not cover (a guest with no acting user at all
    // never reaches that check). Recorded on the same DENIED terms the
    // AI-003 gate below already uses (AI-008/T055) — a guest hitting this
    // tool at all is itself a foreign-id/no-context probe worth auditing,
    // not a silent drop.
    if (this.isGuest(ctx)) {
      const reason =
        'This tool is not available in this context (no acting user).';
      await this.recordAttempt(
        ctx,
        AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
        args,
        'DENIED',
        reason,
      );
      return { success: false, error: reason };
    }
    // F-8 (second site): same inversion, and it matters more here — this tool
    // is NOT permission-gated, and `resolveInsurance` WRITES through
    // `setInsuranceStatus`. With the model's id winning, a prompt injection
    // could read and then overwrite a stranger's health-insurance flag.
    const boundCustomerId = ctx.customerId;
    const customerId = boundCustomerId ?? this.str(args.customerId);
    if (!customerId) {
      return {
        success: false,
        error: 'No customer is bound to this conversation yet.',
      };
    }
    // AI-003: an id the model supplied (not the server-bound identity) needs
    // a real customer-read permission — checked here, before any lookup, so
    // the refusal never doubles as an existence oracle (FR-011, FR-083).
    if (
      !boundCustomerId &&
      !(ctx.permissions ?? []).includes(PERMISSION.CUSTOMERS_READ)
    ) {
      const reason = `Forbidden: reading another customer's insurance status requires the "${PERMISSION.CUSTOMERS_READ}" permission.`;
      // AI-008/T067: this permission gate was added by this same feature
      // (T038) — recorded on the same terms as the finding's original 11
      // gated tools, so it does not reintroduce the exact gap AI-008 exists
      // to close.
      await this.recordAttempt(
        ctx,
        AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
        args,
        'DENIED',
        reason,
      );
      return { success: false, error: reason };
    }
    return this.run(
      ctx,
      AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
      `insurance_status:${randomUUID()}`,
      args,
      async () => {
        const customer = await this.customers.findOneOrThrow(
          ctx.tenantId,
          customerId,
        );
        const hasInsurance = customer.has_health_insurance ?? null;
        return {
          toolResult: {
            success: true,
            hasInsurance,
            known: hasInsurance !== null,
          },
          resultJson: { customerId, hasInsurance },
        };
      },
    );
  }

  private async bookAppointment(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (this.isGuest(ctx)) {
      return {
        success: false,
        error: 'Booking is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_CREATE)) {
      const reason = `Forbidden: booking requires the "${PERMISSION.APPOINTMENTS_CREATE}" permission.`;
      await this.recordAttempt(
        ctx,
        AI_TOOL.BOOK_APPOINTMENT,
        args,
        'DENIED',
        reason,
      );
      return { success: false, error: reason };
    }
    const branchId = this.str(args.branchId);
    // F-8: the SERVER-bound customer wins. This used to be the other way round
    // (`args.customerId ?? ctx.customerId`), and since `customerId` is a
    // REQUIRED tool parameter the model supplied it on essentially every call —
    // so the trusted binding was almost never the value used. `assertCustomer`
    // only checks tenant membership, so a hallucinated or prompt-injected UUID
    // booked an appointment against the wrong patient inside the same clinic.
    // A model-supplied id is now honoured only when there is no binding at all.
    const customerId = ctx.customerId ?? this.str(args.customerId);
    const staffId = this.str(args.staffId);
    const startAt = this.str(args.startAt);
    if (!branchId || !customerId || !staffId || !startAt) {
      return {
        success: false,
        error: 'branchId, customerId, staffId and startAt are required.',
      };
    }
    const serviceIds = Array.isArray(args.serviceIds)
      ? args.serviceIds.filter((s): s is string => typeof s === 'string')
      : undefined;
    // Undefined means "the model didn't say" — resolved against the on-file
    // value (defaulting to false) INSIDE the idempotent executor below, so a
    // retried turn never re-derives a different answer than the one it acted on.
    const hasInsuranceArg =
      typeof args.hasInsurance === 'boolean' ? args.hasInsurance : undefined;

    // Deterministic key: the same (conversation, staff, start) booking intent can
    // execute at most once, even across retried turns.
    const key = `book:${ctx.aiConversationId}:${staffId}:${startAt}`;

    return this.run(ctx, AI_TOOL.BOOK_APPOINTMENT, key, args, async () => {
      // Deterministic, backend-owned decision (FR: "the AI collects the
      // answer, the backend decides") — never trusts tool-call prose, only
      // this resolved boolean.
      const hasInsurance = await this.resolveInsurance(
        ctx.tenantId,
        customerId,
        hasInsuranceArg,
      );

      const appt = await this.appointments.create(
        ctx.tenantId,
        ctx.actorUserId!,
        {
          branchId,
          customerId,
          staffId,
          startAt,
          serviceIds,
          notes: this.str(args.notes),
          source: AppointmentSource.WHATSAPP_BOT,
          hasInsurance,
        },
      );

      // Insured bookings never get a payment link, full stop — checked here
      // (not just left to maybeCreatePaymentLink) so the intent reads clearly.
      const paymentLink = hasInsurance
        ? undefined
        : await this.maybeCreatePaymentLink(ctx.tenantId, appt);

      return {
        appointmentId: appt.id,
        resultJson: {
          appointmentId: appt.id,
          status: appt.status,
          paymentStatus: appt.payment_status,
          startAt: appt.start_at,
          endAt: appt.end_at,
          hasInsurance,
          paymentLinkToken: paymentLink?.token,
        },
        toolResult: {
          success: true,
          appointmentId: appt.id,
          status: appt.status,
          paymentStatus: appt.payment_status,
          startAt: appt.start_at,
          endAt: appt.end_at,
          hasInsurance,
          ...(paymentLink ? { paymentLink } : {}),
        },
      };
    });
  }

  /**
   * Resolves the effective insurance answer for this booking: an explicit
   * turn answer wins (and is persisted onto the customer for next time);
   * otherwise falls back to the on-file value; otherwise `false` (the safe
   * default — payment collection is never silently skipped just because the
   * model forgot to ask). This is the ONLY place that decision is made.
   */
  private async resolveInsurance(
    tenantId: string,
    customerId: string,
    arg: boolean | undefined,
  ): Promise<boolean> {
    let stored: boolean | null = null;
    try {
      const customer = await this.customers.findOneOrThrow(
        tenantId,
        customerId,
      );
      stored = customer.has_health_insurance ?? null;
    } catch {
      // An invalid customerId surfaces properly from AppointmentsService's own
      // assertCustomer check right after this — nothing to do here but fall
      // through with "unknown".
    }

    if (arg === undefined) return stored === true;

    if (arg !== stored) {
      await this.customers
        .setInsuranceStatus(tenantId, customerId, arg)
        .catch((err) =>
          this.logger.warn(
            `could not persist insurance status for customer ${customerId}: ${this.msg(err)}`,
          ),
        );
    }
    return arg;
  }

  /**
   * Auto-generates a shareable payment link for an uninsured booking, but
   * ONLY when the tenant's own business rule (`payment_required`) calls for
   * online payment — the backend decision the FR requires. Reuses
   * `PaymentLinkService.create()` verbatim (same marketplace-chargeability
   * gate, same server-priced amount the manual staff flow gets). Never
   * throws: a payments-side failure (clinic not yet payment-approved, no
   * payable total, etc.) must not block a booking that already succeeded.
   */
  private async maybeCreatePaymentLink(
    tenantId: string,
    appt: Appointment,
  ): Promise<
    | { token: string; amount: number; currency: string; expiresAt?: string }
    | undefined
  > {
    try {
      const settings = await this.tenants.getSettings(tenantId);
      if (!settings.payment_required) return undefined;

      const amount = Number(appt.total_amount ?? 0);
      if (!(amount > 0)) return undefined;

      const link = await this.paymentLinks.create(tenantId, {
        appointmentId: appt.id,
        amount,
      });
      return {
        token: link.link_token,
        amount: Number(link.amount),
        currency: appt.currency,
        expiresAt: link.expires_at?.toISOString(),
      };
    } catch (err) {
      this.logger.warn(
        `payment link auto-generation skipped for appointment ${appt.id}: ${this.msg(err)}`,
      );
      return undefined;
    }
  }

  // ─────────────────────── Public booking (anonymous) ─────────────────────── //
  //
  // Every tool below is safe for a principal with NO permissions and NO clinic
  // tenant, because of three invariants:
  //   1. the clinic tenant is re-derived server-side from the persisted branch
  //      selection (`PublicBookingContextService`), never taken from an argument;
  //   2. each `select_*` VALIDATES against live data before recording, so the
  //      session can never hold a combination the backend would not accept; and
  //   3. the write itself runs as the SELECTED clinic's `ai-bot` actor, so the
  //      visitor is never granted `appointments.create`.

  /**
   * The cities that have bookable clinics — AND the counts that stop an empty
   * list from being read as an empty platform.
   *
   * `branches.city_id` is nullable, so a perfectly bookable clinic that never
   * recorded a city contributes no city here. The model used to receive a bare
   * `{ cities: [] }` and told the visitor "no clinics are available for public
   * booking", which is a claim this tool cannot support. It now reports what it
   * actually knows: how many bookable clinics exist, how many of them are not
   * placed in any city, and what to do next.
   */
  private async listCities(): Promise<ToolResult> {
    const { cities, bookableClinics, clinicsWithoutCity } =
      await this.discovery.cityCoverage();

    const guidance =
      bookableClinics === 0
        ? 'No clinic has opted in to public booking. Say so plainly and offer a human handover.'
        : cities.length === 0
          ? 'Cities are not recorded for these clinics. Bookable clinics DO exist — call search_clinics with no arguments and offer them. Never tell the visitor there are no clinics.'
          : clinicsWithoutCity > 0
            ? 'Some bookable clinics have no city recorded. If the visitor does not want any of these cities, call search_clinics with no arguments to offer the rest.'
            : 'Ask which city, then pass its id to search_clinics as cityId.';

    return {
      success: true,
      cities,
      cityCount: cities.length,
      bookableClinics,
      clinicsWithoutCity,
      guidance,
    };
  }

  /**
   * Records the chosen clinic, and auto-selects its branch when there is only
   * one — a single-branch clinic should not make the visitor "choose" from a
   * list of one.
   */
  private async selectClinic(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const clinicId = this.uuid(args.clinicId);
    if (!clinicId) return this.badId('clinicId', 'search_clinics');

    // Throws if the clinic is not publicly bookable — same check the booking
    // itself will make, so an ineligible clinic is rejected at selection time
    // rather than silently at the end.
    //
    // The bare "Clinic not found" it used to surface was true but unusable:
    // observed live, the model passed the CITY's uuid as `clinicId` (a
    // well-formed uuid, so the shape check could not catch it), read the
    // refusal as "this clinic does not exist", and escalated to a human rather
    // than re-reading the id from the search result it already had. The
    // rejection is unchanged — only what the model is told to do next.
    let detail: Awaited<ReturnType<typeof this.discovery.clinicDetail>>;
    try {
      detail = await this.discovery.clinicDetail(clinicId);
    } catch {
      return {
        success: false,
        error:
          'No bookable clinic has that id. It must be the `id` of one of the CLINIC objects search_clinics returned — not a city id, a branch id, or a name. Re-read it from that result and call select_clinic again; only report a problem to the visitor if the id you sent really was one of those clinic ids.',
      };
    }
    const branches = detail.branches;

    // FR-022: only a genuine re-selection (something was already chosen)
    // needs guidance — a visitor's very first clinic pick has nothing to
    // "re-select".
    const prior = await this.bookingContext.getSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      ctx.principal,
    );
    const hadPriorSelection = Boolean(
      prior.selectedDoctorId ||
      prior.selectedServiceIds?.length ||
      prior.selectedStartAt,
    );

    const only = branches.length === 1 ? branches[0] : undefined;
    const session = await this.bookingContext.patchSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      {
        selectedClinicId: clinicId,
        selectedBranchId: only?.id,
        // AI-006: a new clinic invalidates every downstream choice.
        // SESSION_UNSET, not `undefined` — `clean()` drops `undefined` to
        // PRESERVE the existing value, which is exactly why this reset
        // silently never worked before. SESSION_UNSET genuinely clears it.
        selectedDoctorId: SESSION_UNSET,
        selectedServiceIds: SESSION_UNSET,
        selectedStartAt: SESSION_UNSET,
      },
    );

    return {
      success: true,
      clinic: detail.clinic,
      branches,
      branchAutoSelected: !!only,
      selectedBranch: only ?? null,
      ...(hadPriorSelection
        ? { reselectionGuidance: this.reselectionGuidance(session.language) }
        : {}),
    };
  }

  /**
   * FR-022: reaches the visitor through the assistant's reply, so it is
   * produced in the conversation's OWN language — never a fixed English
   * literal injected into an Arabic conversation. "Actionable" is asserted
   * on structure (resolves analysis finding G11): names exactly which
   * selections were cleared (service, doctor, time slot) and that they need
   * choosing again — an opaque failure or a bare "please try again" both
   * fail this. Contrast with T106/T114's machine-consumed codes: this text
   * is read by a person, not parsed by a client, so it carries no code.
   */
  private reselectionGuidance(language?: string): string {
    if (language === 'ar') {
      return 'بما أنك اخترت عيادة جديدة، تم إلغاء اختيارك السابق للخدمة والطبيب والموعد. الرجاء اختيار الخدمة والطبيب والموعد مرة أخرى لهذه العيادة.';
    }
    return 'Since you switched clinics, your previous service, doctor, and time-slot selections were cleared. Please choose the service, doctor, and time slot again for this clinic.';
  }

  private async selectBranch(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const branchId = this.uuid(args.branchId);
    if (!branchId) return this.badId('branchId', 'get_clinic_details');

    // Resolving the branch's owner IS the ownership check: if it does not
    // belong to the selected clinic, the ids disagree and we refuse.
    const owner = await this.bookingContext.resolveTenantFromBranch(branchId);
    const session = await this.bookingContext.getSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      ctx.principal,
    );
    if (session.selectedClinicId && session.selectedClinicId !== owner) {
      return {
        success: false,
        error: 'That branch does not belong to the selected clinic.',
      };
    }

    await this.bookingContext.patchSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      {
        selectedClinicId: owner,
        selectedBranchId: branchId,
        // Doctors and services are branch-specific — a branch change invalidates them.
        selectedDoctorId: undefined,
        selectedServiceIds: undefined,
        selectedStartAt: undefined,
      },
    );
    return { success: true, branchId };
  }

  private async listBranchServices(ctx: ToolContext): Promise<ToolResult> {
    const booking = await this.requirePublicContext(ctx, 'branch');
    const services = await this.discovery.listBranchServices(
      booking.tenantId,
      booking.branchId,
    );
    return { success: true, ...this.servicesForModel(services) };
  }

  /**
   * `price: null` means the clinic has not PUBLISHED a price — it does not mean
   * the service is free, which is exactly how the model reported it to a patient
   * ("it's dental, and it's free"), and on WhatsApp it once filled the gap with a
   * number it had never been given (F-26). Naming the state explicitly costs one
   * field and removes the only reading that could produce either. Shared by the
   * public and the WhatsApp service lists so they can never disagree.
   */
  private servicesForModel<T extends { price: number | null }>(
    services: T[],
  ): {
    services: (T & { priceStatus: 'NOT_PUBLISHED' | 'PUBLISHED' })[];
    guidance: string;
  } {
    return {
      services: services.map((s) => ({
        ...s,
        priceStatus: s.price == null ? 'NOT_PUBLISHED' : 'PUBLISHED',
      })),
      guidance:
        'durationMinutes is how long the appointment takes. A service with priceStatus NOT_PUBLISHED has no published price — say the clinic has not listed one; NEVER call it free and NEVER state a number for it. Only price 0 is free.',
    };
  }

  private async listBranchDoctors(ctx: ToolContext): Promise<ToolResult> {
    const booking = await this.requirePublicContext(ctx, 'branch');
    const doctors = await this.discovery.listBranchDoctors(
      booking.tenantId,
      booking.branchId,
    );
    return { success: true, doctors };
  }

  private async selectService(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const proposed = Array.isArray(args.serviceIds) ? args.serviceIds : [];
    const serviceIds = proposed
      .map((s) => this.uuid(s))
      .filter((s): s is string => !!s);
    if (serviceIds.length === 0 || serviceIds.length !== proposed.length) {
      return this.badId('Every serviceIds entry', 'list_branch_services');
    }

    const booking = await this.requirePublicContext(ctx, 'branch');
    const offered = await this.discovery.listBranchServices(
      booking.tenantId,
      booking.branchId,
    );
    const offeredIds = new Set(offered.map((s) => s.id));

    const rejected = serviceIds.filter((id) => !offeredIds.has(id));
    if (rejected.length > 0) {
      return {
        success: false,
        error:
          'One or more of those services are not offered at the selected branch.',
        rejectedServiceIds: rejected,
      };
    }

    await this.bookingContext.patchSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      {
        selectedServiceIds: serviceIds,
      },
    );
    return {
      success: true,
      services: offered.filter(
        (s) => offeredIds.has(s.id) && serviceIds.includes(s.id),
      ),
    };
  }

  private async selectDoctor(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const staffId = this.uuid(args.staffId);
    if (!staffId) return this.badId('staffId', 'list_branch_doctors');

    const booking = await this.requirePublicContext(ctx, 'branch');
    const doctors = await this.discovery.listBranchDoctors(
      booking.tenantId,
      booking.branchId,
    );
    if (!doctors.some((d) => d.id === staffId)) {
      return {
        success: false,
        error: 'That doctor does not work at the selected branch.',
      };
    }

    await this.bookingContext.patchSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      {
        selectedDoctorId: staffId,
        // The doctor's calendar differs, so a previously chosen time is stale.
        selectedStartAt: undefined,
      },
    );
    return { success: true, staffId };
  }

  private async selectSlot(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const startAt = this.str(args.startAt);
    if (!startAt || Number.isNaN(new Date(startAt).getTime())) {
      return {
        success: false,
        error: 'startAt must be a valid ISO-8601 timestamp.',
      };
    }
    // Requires a doctor first: a time means nothing without whose calendar it is.
    await this.requirePublicContext(ctx, 'doctor');
    await this.bookingContext.patchSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      {
        selectedStartAt: startAt,
      },
    );
    return { success: true, startAt };
  }

  /**
   * Creates the appointment for an anonymous visitor.
   *
   * Takes NO resource ids — clinic, branch, service, doctor and time all come
   * from the validated session, so there is nothing here for a prompt injection
   * to redirect. Reuses `AppointmentsService.create` verbatim, which re-runs
   * every check (branch ⊂ clinic, service offered at branch, doctor works at
   * branch, slot free) transactionally, so a selection that has gone stale
   * during the conversation fails at commit rather than booking wrongly.
   */
  private async bookPublicAppointment(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const fullName = this.str(args.fullName);
    const phone = this.str(args.phone);
    if (!fullName || !phone) {
      return {
        success: false,
        error: 'fullName and phone are required to book.',
      };
    }

    const booking = await this.requirePublicContext(ctx, 'book');
    const hasInsurance =
      typeof args.hasInsurance === 'boolean' ? args.hasInsurance : false;

    // Deterministic key on the SESSION-resolved values, so a retried turn books
    // at most once even though the model supplied no ids.
    const key = `public_book:${ctx.aiConversationId}:${booking.staffId}:${booking.startAt}`;

    return this.run(
      ctx,
      AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT,
      key,
      args,
      async () => {
        // Act as the SELECTED clinic's bot, in that clinic's tenant context — the
        // guest principal is never elevated and never leaves its own tenant.
        const bot = await this.botActor.ensureBotActor(booking.tenantId);

        const appt = await this.tenantContext.run(async () => {
          this.tenantContext.setPrincipal(bot);

          const customer = await this.customers.findOrCreateForBooking(
            booking.tenantId,
            {
              fullName,
              phone,
              email: this.str(args.email),
            },
          );

          // Bind the customer server-side so nothing later in this conversation
          // can retarget the booking at someone else's record.
          await this.bookingContext.patchSelection(
            ctx.tenantId,
            ctx.aiConversationId,
            {
              bookingCustomerId: customer.id,
            },
          );

          return this.appointments.create(booking.tenantId, bot.id, {
            branchId: booking.branchId,
            customerId: customer.id,
            staffId: booking.staffId!,
            startAt: booking.startAt!,
            serviceIds: booking.serviceIds,
            notes: this.str(args.notes),
            source: AppointmentSource.PUBLIC_AI,
            hasInsurance,
          });
        });

        const paymentLink = hasInsurance
          ? undefined
          : await this.maybeCreatePaymentLink(booking.tenantId, appt);

        return {
          appointmentId: appt.id,
          // `run()` replays THIS object verbatim on a retried turn, so it must
          // carry `success` — otherwise the replay hands the model a result with
          // no success flag and it cannot tell the booking worked.
          resultJson: {
            success: true,
            appointmentId: appt.id,
            tenantId: booking.tenantId,
            branchId: booking.branchId,
            status: appt.status,
            paymentStatus: appt.payment_status,
            hasInsurance,
          },
          toolResult: {
            success: true,
            appointmentId: appt.id,
            status: appt.status,
            paymentStatus: appt.payment_status,
            startAt: appt.start_at,
            endAt: appt.end_at,
            totalAmount: appt.total_amount ?? null,
            currency: appt.currency,
            hasInsurance,
            // The booked branch's own IANA timezone — `findOne()` already
            // loads the `branch` relation, so this is free. A booking-capable
            // client (the ZiyaraTech Marketplace) needs this to label the
            // appointment time correctly; guessing the visitor's browser
            // timezone would be wrong whenever it differs from the clinic's.
            timezone: appt.branch.timezone,
            ...(paymentLink ? { paymentLink } : {}),
          },
        };
      },
      // AI-024: the resolved clinic tenant — set only where it differs
      // from ctx.tenantId (the conversation/discovery tenant), which for
      // every public booking it does.
      booking.tenantId,
    );
  }

  /** Resolves the booking context, turning a missing step into model-readable guidance. */
  private async requirePublicContext(
    ctx: ToolContext,
    need: 'branch' | 'doctor' | 'book',
  ) {
    return this.bookingContext.requireContext(
      ctx.tenantId,
      ctx.aiConversationId,
      ctx.principal,
      need,
    );
  }

  private async rescheduleAppointment(
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

  private async cancelAppointment(
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
  private static readonly NOT_THIS_PATIENTS_APPOINTMENT =
    'No upcoming appointment with that id belongs to this patient. Call list_my_appointments and use an id it returns.';

  private badAppointmentId(ctx: ToolContext): ToolResult {
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
  private async assertOwnAppointment(
    ctx: ToolContext,
    tool: string,
    args: Record<string, unknown>,
    appointmentId: string,
  ): Promise<{ refusal: ToolResult } | { appointment?: Appointment }> {
    if (!ctx.customerId) {
      if (ctx.channel !== 'WHATSAPP') return {};
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
          error: AiToolDispatchService.NOT_THIS_PATIENTS_APPOINTMENT,
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
  private async changePolicyRefusal(
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

  private async changeWindowHours(tenantId: string): Promise<number> {
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
  private async confirmationGate(
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
  private localTimes(
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
  private async doctorNames(
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
  private async describeAppointment(
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
  private async listMyAppointments(ctx: ToolContext): Promise<ToolResult> {
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

  /**
   * Channel-agnostic Live Agent Handover trigger — the only tool that works
   * identically whether the model decided to call it because the customer
   * typed "I want a human" over WhatsApp (no socket to emit `ai:handover`
   * from), the web widget, or the dashboard. Delegates entirely to
   * `HandoverRequestService.create` (same service the socket path and the
   * REST endpoint use) — no duplicated escalation logic.
   */
  private async requestHumanHandover(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const reason =
      this.str(args.reason) ??
      'Requested by the customer during an AI conversation.';
    const key = `handover:${ctx.aiConversationId}`;

    return this.run(
      ctx,
      AI_TOOL.REQUEST_HUMAN_HANDOVER,
      key,
      args,
      async () => {
        // A web guest's request is filed under the clinic it selected (F-07);
        // every other principal escalates within its own tenant, as before.
        const handover = await this.handovers.requestForCustomer(
          ctx.tenantId,
          ctx.principal,
          {
            aiConversationId: ctx.aiConversationId,
            reason,
          },
        );
        return {
          toolResult: {
            success: true,
            handoverId: handover.id,
            message:
              'A human agent has been notified and will join this conversation shortly.',
          },
          resultJson: { handoverId: handover.id },
        };
      },
    );
  }

  // ───────────────── Idempotent execution + audit ledger ──────────────────── //

  /**
   * AI-008/C1 (FR-023): recording that a call was ATTEMPTED and claiming an
   * idempotency key for a business-action WRITE are separable concerns —
   * this is the record step. Used for a `DENIED` or `REFUSED` outcome,
   * which never reaches `run()`'s claim step below (the permission check
   * that produces them runs and returns before `run()` is ever called).
   *
   * Never claims anything — always inserts under the non-claiming
   * `attempt:` key namespace (T066), so it can never pre-claim, block, or
   * collide with a real business-action claim (FR-027). Never replays —
   * every denial is its own fresh attempt, by design (FR-024: "a denial
   * followed by a retry is two attempts and therefore two records").
   * Best-effort: a ledger write failure here degrades to a logged warning
   * and never fails the attempt itself (FR-028, matching the turn-metric
   * record's existing posture).
   */
  private async recordAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    status: 'DENIED' | 'REFUSED',
    reason: string,
  ): Promise<void> {
    await this.writeAttemptRow(ctx, toolName, args, status, reason);
  }

  /**
   * AI-008/C1 (FR-026): the seven public-booking session-state tools
   * (`selectClinic`…`selectSlot`) never call `run()` at all, on success or
   * failure — they record on the SAME `attempt:` terms as a denial, one row
   * per call, regardless of outcome. Deliberately NOT idempotency-claimed
   * (no `PENDING`/`EXECUTING`, no replay) — these are session-state writes,
   * not business-action writes, and MUST NOT acquire semantics they do not
   * need (FR-026): there is no side effect here to dedupe, and a real claim
   * key would misrepresent the record kind.
   */
  private async recordSessionAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    try {
      const result = await fn();
      const status = result.success === false ? 'REFUSED' : 'SUCCEEDED';
      const reason =
        result.success === false && typeof result.error === 'string'
          ? result.error
          : null;
      await this.writeAttemptRow(ctx, toolName, args, status, reason);
      return result;
    } catch (err) {
      await this.writeAttemptRow(ctx, toolName, args, 'REFUSED', this.msg(err));
      throw err;
    }
  }

  /**
   * Is this turn a public guest (or otherwise has no acting user)?
   *
   * `!ctx.actorUserId` alone answers a different question. `AiExecutionService`
   * fills `actorUserId` from `getUser().id`, and a guest principal's id is
   * its session subject — so for every guest turn `actorUserId` is set, the
   * "no acting user" gates never fired, and the guest branches of
   * `get_branch_info` / `get_doctor_schedule` / availability were unreachable
   * from the real widget (F-01). `principal.guest` is the authoritative signal
   * (see `actorUserId()` below, which already relies on it for the audit rows);
   * a missing `actorUserId` is kept as guest too, so no turn that has no user
   * at all is ever treated as authenticated.
   */
  private isGuest(ctx: ToolContext): boolean {
    return !ctx.actorUserId || ctx.principal?.guest === true;
  }

  /**
   * AI-017 (FR-033, FR-034): the acting STAFF principal, explicit null for
   * guests — never a guest's own principal id. `ctx.actorUserId` alone is
   * not sufficient (a guest turn's `ToolContext` can carry `actorUserId`
   * too, from `this.ctx.getUser()?.id` upstream in `ai-execution.service.ts`
   * without a guest check — that field means something different there:
   * "is a real user bound to this conversation," which is separately true
   * or false for guests). `ctx.principal?.guest` is the authoritative
   * signal.
   */
  private actorUserId(ctx: ToolContext): string | null {
    if (ctx.principal?.guest) return null;
    return ctx.actorUserId ?? null;
  }

  /** Shared by `recordAttempt` and `recordSessionAttempt` — one INSERT, never a claim. */
  private async writeAttemptRow(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    status: 'DENIED' | 'REFUSED' | 'SUCCEEDED',
    reason: string | null,
  ): Promise<void> {
    const key = `attempt:${toolName}:${randomUUID()}`;
    try {
      await this.dataSource.query(
        `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, conversation_id, tool_name, arguments, status, error, idempotency_key, correlation_id, actor_user_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          ctx.tenantId,
          ctx.aiConversationId,
          ctx.conversationId ?? null,
          toolName,
          JSON.stringify(args),
          status,
          reason,
          key,
          // AI-016 (FR-030, FR-032): written as explicit null when none can
          // be established, never omitted, so an operator can tell "not
          // recorded" from "not applicable."
          this.tenantContext.getCorrelationId(),
          this.actorUserId(ctx),
        ],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to record ${status} attempt for ${toolName}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Claim the idempotency key, run `executor`, and record the outcome. Replays a
   * prior SUCCEEDED call and reports in-flight or terminal/unknown outcomes
   * without replaying a potentially completed side effect. The claim step
   * (FR-023) — byte-for-byte unchanged by the record/claim split above.
   */
  private async run(
    ctx: ToolContext,
    toolName: string,
    key: string,
    args: Record<string, unknown>,
    executor: () => Promise<{
      toolResult: ToolResult;
      resultJson: unknown;
      appointmentId?: string;
    }>,
    /**
     * AI-024 (FR-035, FR-036, C4): the tenant OWNING the resource acted
     * upon, when it differs from `ctx.tenantId` (the conversation tenant —
     * today, only `bookPublicAppointment`'s resolved clinic tenant).
     * Additive: `tenant_id` on the claim row is never repurposed or
     * overwritten — it stays the conversation tenant, byte-identical to
     * before this parameter existed. Omitted (`undefined`) for every other
     * caller, which is exactly "same as tenant_id" (null).
     */
    resourceTenantId?: string,
  ): Promise<ToolResult> {
    const existing = await this.findByKey(ctx.tenantId, key);
    if (existing) {
      if (existing.status === 'SUCCEEDED') {
        return { ...(existing.result as ToolResult), idempotentReplay: true };
      }
      if (existing.status === 'PENDING' || existing.status === 'EXECUTING') {
        return {
          success: false,
          error: 'A matching action is already in progress.',
        };
      }
      // FAILED → allow a retry by reopening the same ledger row.
      return {
        success: false,
        error:
          'This action was already attempted and requires manual verification.',
      };
    }

    // Claim atomically; on a concurrent race the conflicting row already owns it.
    // AI-016/AI-017/AI-024 (FR-030, FR-032, FR-033, FR-034, FR-035, FR-036):
    // correlation_id, actor_user_id, and resource_tenant_id are additive to
    // this claim insert — the ON CONFLICT/idempotency semantics, and
    // tenant_id itself, are unchanged (FR-027, FR-036).
    const claimed = await this.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, conversation_id, tool_name, arguments, status, idempotency_key, correlation_id, actor_user_id, resource_tenant_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6, $7, $8, $9)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        ctx.tenantId,
        ctx.aiConversationId,
        ctx.conversationId ?? null,
        toolName,
        JSON.stringify(args),
        key,
        this.tenantContext.getCorrelationId(),
        this.actorUserId(ctx),
        // Null means "same as tenant_id" — only set when it genuinely
        // differs (today: bookPublicAppointment's resolved clinic tenant).
        resourceTenantId && resourceTenantId !== ctx.tenantId
          ? resourceTenantId
          : null,
      ],
    );
    const id: string | undefined = claimed[0]?.id;
    if (!id) {
      const raced = await this.findByKey(ctx.tenantId, key);
      if (raced?.status === 'SUCCEEDED')
        return { ...(raced.result as ToolResult), idempotentReplay: true };
      return {
        success: false,
        error: 'A matching action is already in progress.',
      };
    }

    return this.executeAndRecord(id, executor);
  }

  private async executeAndRecord(
    id: string,
    executor: () => Promise<{
      toolResult: ToolResult;
      resultJson: unknown;
      appointmentId?: string;
    }>,
  ): Promise<ToolResult> {
    try {
      await this.dataSource.query(
        `UPDATE ai_tool_calls SET status='EXECUTING' WHERE id=$1 AND status='PENDING'`,
        [id],
      );
      const { toolResult, resultJson, appointmentId } = await executor();
      await this.dataSource.query(
        `UPDATE ai_tool_calls
         SET status='SUCCEEDED', result=$2::jsonb, appointment_id=$3, completed_at=now()
         WHERE id=$1`,
        [id, JSON.stringify(resultJson), appointmentId ?? null],
      );
      return toolResult;
    } catch (err) {
      const state =
        err instanceof AppError ? 'FAILED_PERMANENT' : 'UNKNOWN_OUTCOME';
      const message =
        err instanceof AppError
          ? this.msg(err)
          : 'Unknown execution outcome; manual verification is required.';
      await this.dataSource.query(
        `UPDATE ai_tool_calls SET status=$2, error=$3, completed_at=now() WHERE id=$1`,
        [id, state, message],
      );
      this.logger.warn(`tool call ${id} ${state}`);
      // Returned to the model so it can apologize / offer an alternative.
      return { success: false, error: message };
    }
  }

  private async findByKey(
    tenantId: string,
    key: string,
  ): Promise<{ id: string; status: string; result: unknown } | null> {
    const rows = await this.dataSource.query(
      `SELECT id, status, result FROM ai_tool_calls WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantId, key],
    );
    return rows[0] ?? null;
  }

  // ──────────── AI-019/F1/PD-1: application-issued confirmation gate ─────── //

  private static readonly CONFIRMATION_TTL_MS = 5 * 60 * 1000;

  /**
   * Has the person confirmed the exact action in `key`?
   *
   * The application recorded the proposal itself (`issueConfirmation`), keyed to
   * this conversation, the action and the appointment (and, for a move, the new
   * time), together with the user message it was made in. It counts as confirmed
   * only when ALL of these hold — the model's say-so is never read (FR-073):
   *  - a live, unexpired proposal exists for exactly this key;
   *  - it was made in an EARLIER user turn than this call (F-04). Within one turn
   *    the model could otherwise propose and "confirm" on the patient's behalf
   *    with no human reply in between, which is the gate defeating itself;
   *  - this call can prove its own turn (`ctx.turnId`).
   * Confirmed consumes the proposal, so one "yes" authorises one execution. An
   * expired proposal is dropped so a later call starts clean. A same-turn call
   * leaves the proposal in place — the question is still waiting for its answer.
   *
   * Deliberately takes no token: a tool result does not survive into the next
   * turn, so a model asked to hand one back could not, and every genuine "yes"
   * then read as a fresh request (F-27). Nothing is lost — the token was only
   * ever as trustworthy as the model that carried it.
   */
  private async verifyConfirmation(
    ctx: ToolContext,
    key: string,
  ): Promise<'confirmed' | 'same_turn' | 'none'> {
    const session = await this.sessions.get(ctx.tenantId, ctx.aiConversationId);
    const pending = session.pendingConfirmations?.[key];
    if (!pending) return 'none';
    const remaining = { ...(session.pendingConfirmations ?? {}) };
    if (!(new Date(pending.expiresAt).getTime() > Date.now())) {
      delete remaining[key];
      await this.sessions.patch(ctx.tenantId, ctx.aiConversationId, {
        pendingConfirmations: remaining,
      });
      return 'none';
    }
    if (!ctx.turnId || !pending.turnId || pending.turnId === ctx.turnId) {
      return 'same_turn';
    }
    delete remaining[key];
    await this.sessions.patch(ctx.tenantId, ctx.aiConversationId, {
      pendingConfirmations: remaining,
    });
    return 'confirmed';
  }

  /**
   * Records what is being proposed for this (conversation, action, appointment)
   * and the turn it was proposed in, so a LATER turn's identical call can be
   * independently verified. Returns the token for callers that still carry one.
   */
  private async issueConfirmation(
    ctx: ToolContext,
    key: string,
  ): Promise<string> {
    const token = randomUUID();
    const session = await this.sessions.get(ctx.tenantId, ctx.aiConversationId);
    await this.sessions.patch(ctx.tenantId, ctx.aiConversationId, {
      pendingConfirmations: {
        ...(session.pendingConfirmations ?? {}),
        [key]: {
          token,
          expiresAt: new Date(
            Date.now() + AiToolDispatchService.CONFIRMATION_TTL_MS,
          ).toISOString(),
          turnId: ctx.turnId,
        },
      },
    });
    return token;
  }

  // ──────────────────────────── small helpers ────────────────────────────── //

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
  }

  /**
   * A resource id the model proposed, accepted ONLY if it is a real UUID.
   *
   * Every public lookup casts its id to `uuid` in SQL, so a value that is not
   * one does not "find nothing" — it makes Postgres raise, and the driver's own
   * message (`invalid input syntax for type uuid: "..."`) came straight back as
   * the tool's error. Observed live: the model, handed a clinic named
   * `owner@inovra`, passed the NAME as `clinicId`; the model read the resulting
   * driver error as a platform fault, told the visitor the system had failed,
   * and escalated to a human — when all that had happened was a wrong argument
   * it could have corrected by re-reading the search result.
   *
   * Checking the shape first turns that into an ordinary, recoverable refusal
   * and keeps schema details out of the conversation.
   */
  private uuid(v: unknown): string | undefined {
    const s = this.str(v)?.trim();
    return s &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      ? s
      : undefined;
  }

  /** The refusal for a malformed id — names the recovery, leaks no schema. */
  private badId(field: string, source: string): ToolResult {
    return {
      success: false,
      error: `${field} must be the UUID exactly as returned by ${source} — not a name, and not a value you composed. Re-read it from that result and try again.`,
    };
  }

  private msg(err: unknown): string {
    if (err instanceof AppError) return err.message;
    return err instanceof Error ? err.message : 'Tool execution failed.';
  }
}
