import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { AppointmentsService } from '../../appointment/appointment.service';
import { PublicDiscoveryService } from '../../public-discovery/public-discovery.service';
import { AvailabilityService } from '../../scheduling/availability.service';
import { CustomerService } from '../../crm/customer.service';
import { StaffService } from '../../staff/staff.service';
import { TenantService } from '../../tenant/tenant.service';
import { BranchService } from '../../tenant/branch.service';
import { PaymentLinkService } from '../../payments/payment-link.service';
import { HandoverRequestService } from '../handover-request.service';
import { AiToolCallLedger } from './ai-tool-call-ledger';
import { AiToolConfirmationGate } from './ai-tool-confirmation-gate';
import { PublicBookingContextService } from '../../public-booking/public-booking-context.service';
import { ConversationSessionService } from '../../ai-orchestrator/conversation-session.service';
import { WhatsappBotActorService } from '../../whatsapp/whatsapp-bot-actor.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import {
  toolBadId,
  toolErrorMessage,
  toolIsGuest,
  toolLocalHhmm,
  toolOneLine,
  toolStr,
  toolUuid,
  type ToolResult,
} from './ai-tool-args';
import type { ToolContext } from './ai-tool-dispatch.service';


export interface AiToolHandlerDeps {
  appointments: AppointmentsService;
  availability: AvailabilityService;
  discovery: PublicDiscoveryService;
  customers: CustomerService;
  staff: StaffService;
  dataSource: DataSource;
  handovers: HandoverRequestService;
  tenants: TenantService;
  paymentLinks: PaymentLinkService;
  bookingContext: PublicBookingContextService;
  botActor: WhatsappBotActorService;
  tenantContext: TenantContextService;
  sessions: ConversationSessionService;
  branches: BranchService;
  ledger: AiToolCallLedger;
  gate: AiToolConfirmationGate;
  logger: Logger;
}

/**
 * What the extracted tool handlers share with the dispatcher: the same domain
 * services and the ledger / confirmation gate, plus the helpers every handler
 * uses (argument parsing, the idempotent `run`, attempt recording) and the few
 * methods more than one handler needs. Handlers are plain classes built by
 * `AiToolDispatchService`, so its constructor and every place that builds it
 * are unchanged.
 */
export abstract class AiToolHandlerBase {
  protected readonly appointments: AppointmentsService;
  protected readonly discovery: PublicDiscoveryService;
  protected readonly customers: CustomerService;
  protected readonly dataSource: DataSource;
  protected readonly tenants: TenantService;
  protected readonly paymentLinks: PaymentLinkService;
  protected readonly bookingContext: PublicBookingContextService;
  protected readonly botActor: WhatsappBotActorService;
  protected readonly tenantContext: TenantContextService;
  protected readonly sessions: ConversationSessionService;
  protected readonly branches: BranchService;
  protected readonly logger: Logger;
  private readonly ledger: AiToolCallLedger;
  private readonly gate: AiToolConfirmationGate;

  constructor(deps: AiToolHandlerDeps) {
    this.appointments = deps.appointments;
    this.discovery = deps.discovery;
    this.customers = deps.customers;
    this.dataSource = deps.dataSource;
    this.tenants = deps.tenants;
    this.paymentLinks = deps.paymentLinks;
    this.bookingContext = deps.bookingContext;
    this.botActor = deps.botActor;
    this.tenantContext = deps.tenantContext;
    this.sessions = deps.sessions;
    this.branches = deps.branches;
    this.logger = deps.logger;
    this.ledger = deps.ledger;
    this.gate = deps.gate;
  }

  protected isGuest(ctx: ToolContext): boolean {
    return toolIsGuest(ctx);
  }

  protected str(v: unknown): string | undefined {
    return toolStr(v);
  }

  protected uuid(v: unknown): string | undefined {
    return toolUuid(v);
  }

  protected badId(field: string, source: string): ToolResult {
    return toolBadId(field, source);
  }

  protected msg(err: unknown): string {
    return toolErrorMessage(err, this.logger);
  }

  protected oneLine(text: string | null | undefined): string {
    return toolOneLine(text);
  }

  protected localHhmm(iso: string, zone: string): string {
    return toolLocalHhmm(iso, zone);
  }

  protected recordAttempt(
    ctx: ToolContext,
    toolName: string,
    args: Record<string, unknown>,
    status: 'DENIED' | 'REFUSED',
    reason: string,
  ): Promise<void> {
    return this.ledger.recordAttempt(ctx, toolName, args, status, reason);
  }

  protected findByKey(tenantId: string, key: string) {
    return this.ledger.findByKey(tenantId, key);
  }

  protected run(
    ctx: ToolContext,
    toolName: string,
    key: string,
    args: Record<string, unknown>,
    executor: Parameters<AiToolCallLedger['run']>[4],
    resourceTenantId?: string,
  ): Promise<ToolResult> {
    return this.ledger.run(ctx, toolName, key, args, executor, resourceTenantId);
  }

  protected verifyConfirmation(
    ctx: ToolContext,
    key: string,
  ): Promise<'confirmed' | 'same_turn' | 'none'> {
    return this.gate.verify(ctx, key);
  }

  protected issueConfirmation(ctx: ToolContext, key: string): Promise<string> {
    return this.gate.issue(ctx, key);
  }

  // ── Shared by more than one handler (moved verbatim) ──────────────────────── //

  /** Resolves the booking context, turning a missing step into model-readable guidance. */
  async requirePublicContext(
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

  /**
   * `price: null` means the clinic has not PUBLISHED a price — it does not mean
   * the service is free, which is exactly how the model reported it to a patient
   * ("it's dental, and it's free"), and on WhatsApp it once filled the gap with a
   * number it had never been given (F-26). Naming the state explicitly costs one
   * field and removes the only reading that could produce either. Shared by the
   * public and the WhatsApp service lists so they can never disagree.
   */
  servicesForModel<T extends { price: number | null }>(
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

  /**
   * Auto-generates a shareable payment link for an uninsured booking, but
   * ONLY when the tenant's own business rule (`payment_required`) calls for
   * online payment — the backend decision the FR requires. Reuses
   * `PaymentLinkService.create()` verbatim (same marketplace-chargeability
   * gate, same server-priced amount the manual staff flow gets). Never
   * throws: a payments-side failure (clinic not yet payment-approved, no
   * payable total, etc.) must not block a booking that already succeeded.
   */
  async maybeCreatePaymentLink(
    tenantId: string,
    appt: Appointment,
  ): Promise<
    | {
        token: string;
        amount: number;
        currency: string;
        expiresAt?: string;
        payUrl?: string;
      }
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
        // The patient-facing page. Built by the payments module, never here.
        payUrl: this.paymentLinks.payUrlFor(link.link_token),
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

}
