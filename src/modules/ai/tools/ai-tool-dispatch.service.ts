import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppError } from '../../../common/errors';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppointmentSource } from '../../../entities/enums';
import { AppointmentsService } from '../../appointment/appointment.service';
import { PublicDiscoveryService } from '../../public-discovery/public-discovery.service';
import { AvailabilityService } from '../../scheduling/availability.service';
import { DashboardMetricService } from '../../analytics/dashboard-metric.service';
import { SubscriptionService } from '../../subscription-billing/subscription.service';
import { UsageService } from '../../subscription-billing/usage.service';
import { CustomerService } from '../../crm/customer.service';
import { StaffService } from '../../staff/staff.service';
import { TenantService } from '../../tenant/tenant.service';
import { PaymentLinkService } from '../../payments/payment-link.service';
import { AiToolCall } from '../providers/ai-provider.interface';
import { AiAnalyticsService } from '../ai-analytics.service';
import { HandoverRequestService } from '../handover-request.service';
import { AI_TOOL } from './ai-tools.constants';
import { AI_PUBLIC_TOOL } from './ai-public-booking-tools.constants';
import { PublicBookingContextService } from '../../public-booking/public-booking-context.service';
import { WhatsappBotActorService } from '../../whatsapp/whatsapp-bot-actor.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  AI_ADMIN_TOOL,
  AI_ADMIN_TOOL_PERMISSION,
  AiAdminToolName,
} from './ai-admin-tools.constants';
import { PERMISSION } from '../../../rbac/rbac.constants';

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
}

/** The structured result handed back to the model as the `tool` message. */
type ToolResult = Record<string, unknown>;

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
 *  - Every call (success or failure) is recorded in `ai_tool_calls` for audit.
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
        case AI_TOOL.CHECK_AVAILABILITY:
          return await this.checkAvailability(ctx, args);
        case AI_TOOL.GET_CUSTOMER_INSURANCE_STATUS:
          return await this.getCustomerInsuranceStatus(ctx, args);
        case AI_TOOL.BOOK_APPOINTMENT:
          return await this.bookAppointment(ctx, args);
        case AI_TOOL.RESCHEDULE_APPOINTMENT:
          return await this.rescheduleAppointment(ctx, args);
        case AI_TOOL.CANCEL_APPOINTMENT:
          return await this.cancelAppointment(ctx, args);
        case AI_TOOL.REQUEST_HUMAN_HANDOVER:
          return await this.requestHumanHandover(ctx, args);
        // ── Public booking (anonymous visitors) ────────────────────────────
        case AI_PUBLIC_TOOL.LIST_CITIES:
          return await this.listCities();
        case AI_PUBLIC_TOOL.SELECT_CLINIC:
          return await this.selectClinic(ctx, args);
        case AI_PUBLIC_TOOL.SELECT_BRANCH:
          return await this.selectBranch(ctx, args);
        case AI_PUBLIC_TOOL.LIST_BRANCH_SERVICES:
          return await this.listBranchServices(ctx);
        case AI_PUBLIC_TOOL.LIST_BRANCH_DOCTORS:
          return await this.listBranchDoctors(ctx);
        case AI_PUBLIC_TOOL.SELECT_SERVICE:
          return await this.selectService(ctx, args);
        case AI_PUBLIC_TOOL.SELECT_DOCTOR:
          return await this.selectDoctor(ctx, args);
        case AI_PUBLIC_TOOL.SELECT_SLOT:
          return await this.selectSlot(ctx, args);
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
   * delegates to an EXISTING tenant-scoped service — no new queries. Denied
   * calls are still recorded in `ai_tool_calls` (idempotency key includes the
   * denial reason so a retried denial does not race a legitimate later grant).
   */
  private async executeAdminTool(
    ctx: ToolContext,
    name: AiAdminToolName,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const required = AI_ADMIN_TOOL_PERMISSION[name];
    if (!(ctx.permissions ?? []).includes(required)) {
      return {
        success: false,
        error: `Forbidden: this question requires the "${required}" permission.`,
      };
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

  /** Cross-tenant public clinic search — read-only, safe for anonymous chats. */
  private async searchClinics(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = this.str(args.query);
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    return this.run(
      ctx,
      AI_TOOL.SEARCH_CLINICS,
      `search_clinics:${randomUUID()}`,
      args,
      async () => {
        const clinics = await this.discovery.searchClinics(query, limit);
        return {
          toolResult: { success: true, count: clinics.length, clinics },
          resultJson: { count: clinics.length },
        };
      },
    );
  }

  /** Branches, doctors and services (with prices) for a chosen clinic. */
  private async getClinicDetails(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const clinicId = this.str(args.clinicId);
    if (!clinicId) return { success: false, error: 'clinicId is required.' };
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

  /** Free slots for a publicly-discovered clinic's branch + doctor on a day. */
  private async searchPublicAvailability(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const branchId = this.str(args.branchId);
    const staffId = this.str(args.staffId);
    const date = this.str(args.date);
    if (!branchId || !staffId || !date) {
      return {
        success: false,
        error: 'branchId, staffId and date are required.',
      };
    }
    return this.run(
      ctx,
      AI_TOOL.SEARCH_PUBLIC_AVAILABILITY,
      `pub_avail:${randomUUID()}`,
      args,
      async () => {
        const result = await this.discovery.publicAvailability(
          branchId,
          staffId,
          date,
          typeof args.slotMinutes === 'number' ? args.slotMinutes : undefined,
        );
        return { toolResult: { success: true, ...result }, resultJson: result };
      },
    );
  }

  // ─────────────────────────────── Tools ─────────────────────────────────── //

  /** Read-only — no idempotency dedup, but still audited. */
  private async checkAvailability(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const branchId = this.str(args.branchId);
    const staffId = this.str(args.staffId);
    const date = this.str(args.date);
    if (!branchId || !staffId || !date) {
      return {
        success: false,
        error: 'branchId, staffId and date are required.',
      };
    }
    return this.run(
      ctx,
      AI_TOOL.CHECK_AVAILABILITY,
      `check:${randomUUID()}`,
      args,
      async () => {
        const result = await this.availability.windows(ctx.tenantId, {
          branchId,
          staffId,
          date,
          slotMinutes:
            typeof args.slotMinutes === 'number' ? args.slotMinutes : undefined,
        } as never);
        return { toolResult: { success: true, ...result }, resultJson: result };
      },
    );
  }

  /**
   * Read-only lookup of the patient's on-file insurance answer, so the model
   * can confirm a returning patient's answer instead of asking cold every
   * time. Not permission-gated (same posture as `checkAvailability`): the
   * customer is either the one already bound to this conversation, or an
   * explicit id that gets the same tenant-scoped existence check booking does.
   */
  private async getCustomerInsuranceStatus(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // F-8 (second site): same inversion, and it matters more here — this tool
    // is NOT permission-gated, and `resolveInsurance` WRITES through
    // `setInsuranceStatus`. With the model's id winning, a prompt injection
    // could read and then overwrite a stranger's health-insurance flag.
    const customerId = ctx.customerId ?? this.str(args.customerId);
    if (!customerId) {
      return {
        success: false,
        error: 'No customer is bound to this conversation yet.',
      };
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
    if (!ctx.actorUserId) {
      return {
        success: false,
        error: 'Booking is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_CREATE)) {
      return {
        success: false,
        error: `Forbidden: booking requires the "${PERMISSION.APPOINTMENTS_CREATE}" permission.`,
      };
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

  private async listCities(): Promise<ToolResult> {
    const cities = await this.discovery.listCities();
    return { success: true, cities };
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
    const clinicId = this.str(args.clinicId);
    if (!clinicId) return { success: false, error: 'clinicId is required.' };

    // Throws if the clinic is not publicly bookable — same check the booking
    // itself will make, so an ineligible clinic is rejected at selection time
    // rather than silently at the end.
    const detail = await this.discovery.clinicDetail(clinicId);
    const branches = detail.branches;

    const only = branches.length === 1 ? branches[0] : undefined;
    await this.bookingContext.patchSelection(
      ctx.tenantId,
      ctx.aiConversationId,
      {
        selectedClinicId: clinicId,
        selectedBranchId: only?.id,
        // A new clinic invalidates every downstream choice.
        selectedDoctorId: undefined,
        selectedServiceIds: undefined,
        selectedStartAt: undefined,
      },
    );

    return {
      success: true,
      clinic: detail.clinic,
      branches,
      branchAutoSelected: !!only,
      selectedBranch: only ?? null,
    };
  }

  private async selectBranch(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const branchId = this.str(args.branchId);
    if (!branchId) return { success: false, error: 'branchId is required.' };

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
    return { success: true, services };
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
    const serviceIds = Array.isArray(args.serviceIds)
      ? args.serviceIds.filter((s): s is string => typeof s === 'string')
      : [];
    if (serviceIds.length === 0)
      return { success: false, error: 'serviceIds is required.' };

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
    const staffId = this.str(args.staffId);
    if (!staffId) return { success: false, error: 'staffId is required.' };

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
            ...(paymentLink ? { paymentLink } : {}),
          },
        };
      },
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
    if (!ctx.actorUserId) {
      return {
        success: false,
        error: 'Reschedule is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_RESCHEDULE)) {
      return {
        success: false,
        error: `Forbidden: rescheduling requires the "${PERMISSION.APPOINTMENTS_RESCHEDULE}" permission.`,
      };
    }
    const appointmentId = this.str(args.appointmentId);
    const newStartAt = this.str(args.newStartAt);
    if (!appointmentId || !newStartAt) {
      return {
        success: false,
        error: 'appointmentId and newStartAt are required.',
      };
    }
    const key = `reschedule:${appointmentId}:${newStartAt}`;

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
    if (!ctx.actorUserId) {
      return {
        success: false,
        error:
          'Cancellation is not available in this context (no acting user).',
      };
    }
    if (!(ctx.permissions ?? []).includes(PERMISSION.APPOINTMENTS_CANCEL)) {
      return {
        success: false,
        error: `Forbidden: cancellation requires the "${PERMISSION.APPOINTMENTS_CANCEL}" permission.`,
      };
    }
    const appointmentId = this.str(args.appointmentId);
    if (!appointmentId) {
      return { success: false, error: 'appointmentId is required.' };
    }
    const key = `cancel:${appointmentId}`;

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
        const handover = await this.handovers.create(ctx.tenantId, {
          aiConversationId: ctx.aiConversationId,
          reason,
        });
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
   * Claim the idempotency key, run `executor`, and record the outcome. Replays a
   * prior SUCCEEDED call and reports in-flight or terminal/unknown outcomes
   * without replaying a potentially completed side effect.
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
    const claimed = await this.dataSource.query(
      `INSERT INTO ai_tool_calls (tenant_id, ai_conversation_id, conversation_id, tool_name, arguments, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        ctx.tenantId,
        ctx.aiConversationId,
        ctx.conversationId ?? null,
        toolName,
        JSON.stringify(args),
        key,
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

  // ──────────────────────────── small helpers ────────────────────────────── //

  private str(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() ? v : undefined;
  }

  private msg(err: unknown): string {
    if (err instanceof AppError) return err.message;
    return err instanceof Error ? err.message : 'Tool execution failed.';
  }
}
