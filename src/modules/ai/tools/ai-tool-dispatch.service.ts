import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppointmentSource } from '../../../entities/enums';
import { AppointmentsService } from '../../appointment/appointment.service';
import { PublicDiscoveryService } from '../../public-discovery/public-discovery.service';
import { AvailabilityService, DayWindows, PUBLIC_AVAILABILITY_HORIZON_DAYS } from '../../scheduling/availability.service';
import { safeZone, zonedYmd } from '../../scheduling/timezone.util';
import { promptLine } from '../prompt/untrusted-text';
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
import { AI_CHANNEL } from '../../ai-orchestrator/ai-channel.constants';
import { AI_TOOL, AI_TOOL_PERMISSION } from './ai-tools.constants';
import {
  toolActorUserId,
  toolBadId,
  toolErrorMessage,
  toolStr,
  toolUuid,
  type ToolResult,
} from './ai-tool-args';
import { AiToolCallLedger } from './ai-tool-call-ledger';
import { AiToolConfirmationGate } from './ai-tool-confirmation-gate';
import { AppointmentChangeToolHandler } from './ai-tool-appointment-change.handler';
import type { AiToolHandlerDeps } from './ai-tool-handler.base';
import { OwnClinicToolHandler } from './ai-tool-own-clinic.handler';
import { PublicBookingToolHandler } from './ai-tool-public-booking.handler';
import { AI_PUBLIC_TOOL } from './ai-public-booking-tools.constants';
import { PublicBookingContextService } from '../../public-booking/public-booking-context.service';
import { ConversationSessionService } from '../../ai-orchestrator/conversation-session.service';
import { WhatsappBotActorService } from '../../whatsapp/whatsapp-bot-actor.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AI_ADMIN_TOOL, AI_ADMIN_TOOL_PERMISSION, AiAdminToolName } from './ai-admin-tools.constants';
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
  /**
   * The names of the tools this turn actually OFFERED the model — set by
   * `AiExecutionService` from the list it sent to the provider.
   *
   * Which tools a principal is offered is a security decision (a guest gets the
   * public booking set, a WhatsApp patient the own-clinic set and never the
   * cross-clinic discovery tools), but until this was enforced here it was only
   * a decision about what to ADVERTISE: a model can emit a call for any name,
   * and one steered by injected text will. A call for a tool that was not
   * offered is refused and recorded as a denial (see `notOffered`). Absent (direct callers and
   * tests that build their own context) means no restriction, as before.
   */
  allowedTools?: readonly string[];
}

/** Every tool the dispatcher can execute (an unknown name keeps its own answer). */
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.values(AI_TOOL),
  ...Object.values(AI_PUBLIC_TOOL),
  ...Object.values(AI_ADMIN_TOOL),
]);





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
  private readonly ledger: AiToolCallLedger;
  private readonly gate: AiToolConfirmationGate;
  /** Public guest booking tools (`select_*`, `book_public_appointment`, ...). */
  private readonly publicBooking: PublicBookingToolHandler;
  /** `reschedule_appointment`, `cancel_appointment`, `list_my_appointments`. */
  private readonly appointmentChange: AppointmentChangeToolHandler;
  /** WhatsApp own-clinic discovery and its working-set memory. */
  private readonly ownClinic: OwnClinicToolHandler;

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
  ) {
    this.ledger = new AiToolCallLedger(
      this.dataSource,
      this.tenantContext,
      this.logger,
    );
    this.gate = new AiToolConfirmationGate(this.sessions);
    const deps: AiToolHandlerDeps = {
      appointments: this.appointments,
      availability: this.availability,
      discovery: this.discovery,
      customers: this.customers,
      staff: this.staff,
      dataSource: this.dataSource,
      handovers: this.handovers,
      tenants: this.tenants,
      paymentLinks: this.paymentLinks,
      bookingContext: this.bookingContext,
      botActor: this.botActor,
      tenantContext: this.tenantContext,
      sessions: this.sessions,
      branches: this.branches,
      ledger: this.ledger,
      gate: this.gate,
      logger: this.logger,
    };
    this.publicBooking = new PublicBookingToolHandler(deps);
    this.appointmentChange = new AppointmentChangeToolHandler(deps);
    this.ownClinic = new OwnClinicToolHandler(deps);
  }

  /**
   * The ESTABLISHED BOOKING CONTEXT block for a WHATSAPP turn — see
   * `OwnClinicToolHandler.describeOwnClinicContext`. Public because
   * `AiExecutionService` builds the prompt with it.
   */
  describeOwnClinicContext(
    tenantId: string,
    aiConversationId: string,
  ): Promise<string> {
    return this.ownClinic.describeOwnClinicContext(tenantId, aiConversationId);
  }

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

    if (this.notOffered(ctx, call.name)) {
      const reason = `Forbidden: "${call.name}" is not available in this conversation.`;
      this.logger.warn(
        `refused tool "${call.name}": not offered on this turn (conversation=${ctx.aiConversationId})`,
      );
      // Recorded like every other denial, so an injected attempt leaves a trace.
      await this.recordAttempt(ctx, call.name, args, 'DENIED', reason).catch(
        () => undefined,
      );
      return { success: false, error: reason };
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
          return await this.ownClinic.remembered(
            ctx,
            args,
            await this.getBranchInfo(ctx, args),
          );
        case AI_TOOL.GET_DOCTOR_SCHEDULE:
          return await this.ownClinic.remembered(
            ctx,
            args,
            await this.getDoctorSchedule(ctx, args),
          );
        case AI_TOOL.LIST_CLINIC_BRANCHES: {
          const branchList = await this.ownClinic.listClinicBranches(ctx);
          // A clinic with ONE branch has no choice to make: that branch is the
          // working branch from the first call on.
          const only =
            Array.isArray(branchList.branches) &&
            branchList.branches.length === 1
              ? (branchList.branches[0] as { id?: string }).id
              : undefined;
          return await this.ownClinic.remembered(ctx, { branchId: only }, branchList);
        }
        case AI_TOOL.LIST_CLINIC_DOCTORS:
          return await this.ownClinic.remembered(
            ctx,
            args,
            await this.ownClinic.listClinicDoctors(ctx, args),
          );
        case AI_TOOL.LIST_CLINIC_SERVICES:
          return await this.ownClinic.remembered(
            ctx,
            args,
            await this.ownClinic.listClinicServices(ctx, args),
          );
        case AI_TOOL.CHECK_AVAILABILITY:
          return await this.ownClinic.remembered(
            ctx,
            args,
            await this.checkAvailability(ctx, args),
          );
        case AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS:
          return await this.getCustomerInsuranceStatus(ctx, args);
        case AI_TOOL.BOOK_APPOINTMENT:
          return await this.bookAppointment(ctx, args);
        case AI_TOOL.RESCHEDULE_APPOINTMENT:
          return await this.appointmentChange.rescheduleAppointment(ctx, args);
        case AI_TOOL.CANCEL_APPOINTMENT:
          return await this.appointmentChange.cancelAppointment(ctx, args);
        case AI_TOOL.LIST_MY_APPOINTMENTS:
          return await this.appointmentChange.listMyAppointments(ctx);
        case AI_TOOL.REQUEST_HUMAN_HANDOVER:
          return await this.requestHumanHandover(ctx, args);
        // ── Public booking (anonymous visitors) ────────────────────────────
        // Recorded like its siblings: it used to return without writing any
        // row at all, so a booking that dead-ended at the city step left no
        // trace in `ai_tool_calls` and the failure was invisible to the
        // monitoring surfaces.
        case AI_PUBLIC_TOOL.LIST_CITIES:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.listCities(),
          );
        // AI-008/C1 (FR-026): these 7 session-state tools never call
        // run() — recordSessionAttempt records one attempt-only row per
        // call, on the same terms as a denial, regardless of outcome.
        case AI_PUBLIC_TOOL.SELECT_CLINIC:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.selectClinic(ctx, args),
          );
        case AI_PUBLIC_TOOL.SELECT_BRANCH:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.selectBranch(ctx, args),
          );
        case AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.listBranchServices(ctx),
          );
        case AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.listBranchDoctors(ctx),
          );
        case AI_PUBLIC_TOOL.SELECT_SERVICE:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.selectService(ctx, args),
          );
        case AI_PUBLIC_TOOL.SELECT_DOCTOR:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.selectDoctor(ctx, args),
          );
        case AI_PUBLIC_TOOL.SELECT_SLOT:
          return await this.recordSessionAttempt(ctx, call.name, args, () =>
            this.publicBooking.selectSlot(ctx, args),
          );
        case AI_PUBLIC_TOOL.BOOK_PUBLIC_APPOINTMENT:
          return await this.publicBooking.bookPublicAppointment(ctx, args);
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

  /**
   * Is this a call for a real tool that this turn did NOT offer the model?
   *
   * Tools that carry their own permission requirement (the staff booking tools
   * and the admin tools) are left to that check: it is the stricter one, it
   * names the missing permission, and it already records the denial. What this
   * closes is everything WITHOUT such a requirement, where "not offered" was
   * the only control: the cross-clinic discovery tools on WhatsApp, the public
   * booking tools for anyone who is not an anonymous visitor, and the
   * own-clinic tools outside WhatsApp.
   */
  private notOffered(ctx: ToolContext, name: string): boolean {
    if (!ctx.allowedTools || ctx.allowedTools.includes(name)) return false;
    if (name in AI_TOOL_PERMISSION || name in AI_ADMIN_TOOL_PERMISSION) {
      return false;
    }
    return KNOWN_TOOL_NAMES.has(name);
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
      const booking = await this.publicBooking.requirePublicContext(ctx, 'doctor');
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
        booking = await this.publicBooking.requirePublicContext(ctx, 'doctor');
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
      const booking = await this.publicBooking.requirePublicContext(ctx, 'branch');
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
   * Clinic-owned text (a branch, service or doctor name) placed in a SYSTEM
   * message: collapsed to one short line so a name can neither break the block's
   * structure nor carry a paragraph of instructions into it.
   */
  private oneLine(text: string | null | undefined): string {
    return promptLine(text, 60);
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
    const unbound = await this.refuseUnboundWhatsapp(
      ctx,
      AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS,
      args,
    );
    if (unbound) return unbound;
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
    const unbound = await this.refuseUnboundWhatsapp(
      ctx,
      AI_TOOL.BOOK_APPOINTMENT,
      args,
    );
    if (unbound) return unbound;
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
        : await this.publicBooking.maybeCreatePaymentLink(ctx.tenantId, appt);

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
   * A WhatsApp turn acts for exactly one patient: the customer the bridge bound
   * to the session. The bot actor holds tenant-wide `appointments.create` and
   * `customers.read`, so "no bound patient" must never fall back to a
   * customerId the model supplied (a hallucinated or prompt-injected id would
   * book or read against a stranger in the same clinic). Today the bridge always
   * binds one; this keeps that invariant in the dispatcher instead of in the
   * caller. Other channels are untouched — it can only turn a call into a
   * refusal on WhatsApp, never into an allowance.
   */
  private async refuseUnboundWhatsapp(
    ctx: ToolContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult | undefined> {
    if (ctx.channel !== AI_CHANNEL.WHATSAPP || ctx.customerId) return undefined;
    const reason = 'No patient is identified for this conversation.';
    await this.recordAttempt(ctx, tool, args, 'DENIED', reason);
    return {
      success: false,
      error: `${reason} Offer to connect the person with the clinic team (request_human_handover).`,
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
  // The ledger itself lives in `AiToolCallLedger`; these keep the call sites (and
  // the specs that reach them) unchanged.

  private recordAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    status: 'DENIED' | 'REFUSED',
    reason: string,
  ): Promise<void> {
    return this.ledger.recordAttempt(ctx, toolName, args, status, reason);
  }

  private recordSessionAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    return this.ledger.recordSessionAttempt(ctx, toolName, args, fn);
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

  /** The acting STAFF principal, explicit null for guests (see `toolActorUserId`). */
  private actorUserId(ctx: ToolContext): string | null {
    return toolActorUserId(ctx);
  }

  private findByKey(tenantId: string, key: string) {
    return this.ledger.findByKey(tenantId, key);
  }

  private run(
    ctx: ToolContext,
    toolName: string,
    key: string,
    args: Record<string, unknown>,
    executor: Parameters<AiToolCallLedger['run']>[4],
    resourceTenantId?: string,
  ): Promise<ToolResult> {
    return this.ledger.run(ctx, toolName, key, args, executor, resourceTenantId);
  }

  // ──────────── AI-019/F1/PD-1: application-issued confirmation gate ─────── //
  // Implemented by `AiToolConfirmationGate`.

  private verifyConfirmation(
    ctx: ToolContext,
    key: string,
  ): Promise<'confirmed' | 'same_turn' | 'none'> {
    return this.gate.verify(ctx, key);
  }

  private issueConfirmation(ctx: ToolContext, key: string): Promise<string> {
    return this.gate.issue(ctx, key);
  }

  // ──────────────────────────── small helpers ────────────────────────────── //
  // Pure helpers live in `ai-tool-args.ts`.

  private str(v: unknown): string | undefined {
    return toolStr(v);
  }

  private uuid(v: unknown): string | undefined {
    return toolUuid(v);
  }

  private badId(field: string, source: string): ToolResult {
    return toolBadId(field, source);
  }

  private msg(err: unknown): string {
    return toolErrorMessage(err, this.logger);
  }
}
