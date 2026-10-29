import { Injectable } from '@nestjs/common';

import { AppError, ErrorCode } from '../../common/errors';
import { AppointmentSource } from '../../entities/enums';
import { AppointmentsService } from '../appointment/appointment.service';
import {
  APPOINTMENT_AUDIT_ACTION,
  AppointmentAuditService,
} from '../appointment/appointment-audit.service';
import { CreateAppointmentDto } from '../appointment/dto/create-appointment.dto';
import { CustomerService } from '../crm/customer.service';
import { PaymentLinkService } from '../payments/payment-link.service';
import { PublicDiscoveryService } from '../public-discovery/public-discovery.service';
import {
  AvailabilityService,
  PublicAvailabilityWindow,
} from '../scheduling/availability.service';
import { WhatsappBotActorService } from '../whatsapp/whatsapp-bot-actor.service';
import { runAsBotActor } from '../whatsapp/bot-actor-run';
import {
  branchSelectedPatch,
  clinicSelectedPatch,
  doctorSelectedPatch,
  servicesSelectedPatch,
  slotSelectedPatch,
} from './public-booking-selection';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { AiSession } from '../ai-orchestrator/ai-channel.constants';

import {
  PublicBookingContext,
  PublicBookingContextService,
} from './public-booking-context.service';

/** A guest principal shaped exactly like the WS gateway's own (never
 *  elevated — `roles`/`permissions` stay empty). */
export interface GuestPrincipal {
  id: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  guest: true;
}

export interface ConfirmBookingInput {
  fullName: string;
  phone: string;
  email?: string;
  hasInsurance?: boolean;
  notes?: string;
}

export interface ConfirmedBooking {
  appointmentId: string;
  status: string;
  paymentStatus: string;
  startAt: Date;
  endAt: Date;
  totalAmount: number | null;
  currency: string;
  hasInsurance: boolean;
  paymentLink?: {
    token: string;
    amount: number;
    currency: string;
    expiresAt?: string;
    /** The durable public page the patient opens to pay (`/pay/{token}`); absent where the deployment cannot complete a patient payment there. */
    payUrl?: string;
  };
}

/**
 * Spec 014 (Clinic Platform Completion) — T066/T067 (S4, FR-P003–FR-P015).
 * The deterministic (non-AI) counterpart to `AiToolDispatchService`'s
 * `select_*`/`book_public_appointment` tools — same validation rules, same
 * write path (`AppointmentsService.create` under the clinic's bot actor),
 * so both booking paths converge on one outcome for identical selections
 * (FR-P003). Every selection is validated against LIVE data before being
 * recorded (`PublicBookingContextService.patchSelection` is a recorder, not
 * a validator) — reusing `PublicDiscoveryService`'s eligibility predicate
 * verbatim, never a second one.
 */
@Injectable()
export class PublicBookingFlowService {
  constructor(
    private readonly bookingContext: PublicBookingContextService,
    private readonly discovery: PublicDiscoveryService,
    private readonly availabilityService: AvailabilityService,
    private readonly customers: CustomerService,
    private readonly appointments: AppointmentsService,
    private readonly paymentLinks: PaymentLinkService,
    private readonly botActor: WhatsappBotActorService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AppointmentAuditService,
  ) {}

  async getSelection(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
  ): Promise<AiSession> {
    return this.bookingContext.getSelection(
      guestTenantId,
      conversationId,
      principal,
    );
  }

  /**
   * FR-P004 — selecting a clinic that isn't publicly bookable (opted out,
   * unapproved, deactivated, unknown id) fails the SAME uniform way
   * `resolveTenantFromBranch` already fails for a branch — no separate
   * existence oracle for clinic ids.
   */
  async selectClinic(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    clinicId: string,
  ): Promise<void> {
    const detail = await this.discovery.clinicDetail(clinicId).catch(() => {
      throw this.notFound();
    });
    const only = detail.branches.length === 1 ? detail.branches[0] : undefined;

    await this.bookingContext.patchSelection(
      guestTenantId,
      conversationId,
      clinicSelectedPatch(clinicId, only?.id),
    );
  }

  async selectBranch(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    branchId: string,
  ): Promise<void> {
    const owner = await this.bookingContext.resolveTenantFromBranch(branchId);
    const session = await this.bookingContext.getSelection(
      guestTenantId,
      conversationId,
      principal,
    );
    if (session.selectedClinicId && session.selectedClinicId !== owner) {
      throw this.notFound();
    }

    await this.bookingContext.patchSelection(
      guestTenantId,
      conversationId,
      branchSelectedPatch(owner, branchId),
    );
  }

  async listServices(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
  ) {
    const ctx = await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'branch',
    );
    return this.discovery.listBranchServices(ctx.tenantId, ctx.branchId);
  }

  async selectService(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    serviceIds: string[],
  ): Promise<void> {
    if (serviceIds.length === 0)
      throw this.unprocessable('At least one service is required.');

    const ctx = await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'branch',
    );
    const offered = await this.discovery.listBranchServices(
      ctx.tenantId,
      ctx.branchId,
    );
    const offeredIds = new Set(offered.map((s) => s.id));
    if (serviceIds.some((id) => !offeredIds.has(id))) {
      throw this.unprocessable(
        'One or more of those services are not offered at the selected branch.',
      );
    }

    await this.bookingContext.patchSelection(
      guestTenantId,
      conversationId,
      servicesSelectedPatch(serviceIds),
    );
  }

  /**
   * FR-P003 — deliberately `listBranchDoctors` (branch-only), the EXACT
   * predicate the AI conversational flow's own `list_branch_doctors`/
   * `select_doctor` use (`ai-tool-dispatch.service.ts`). An earlier version
   * of this method filtered further by `staff_services` linkage, which
   * neither the AI flow nor `AppointmentsService.create` itself enforces —
   * that made this flow refuse a doctor selection the other path, and the
   * real write path, would both accept. Reusing the identical predicate is
   * what FR-P003 ("neither path can book something the other would refuse")
   * requires.
   */
  async listDoctors(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
  ) {
    const ctx = await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'service',
    );
    return this.discovery.listBranchDoctors(ctx.tenantId, ctx.branchId);
  }

  async selectDoctor(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    staffId: string,
  ): Promise<void> {
    const ctx = await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'service',
    );
    const doctors = await this.discovery.listBranchDoctors(
      ctx.tenantId,
      ctx.branchId,
    );
    if (!doctors.some((d) => d.id === staffId)) {
      throw this.unprocessable(
        'That doctor does not work at the selected branch.',
      );
    }

    await this.bookingContext.patchSelection(
      guestTenantId,
      conversationId,
      doctorSelectedPatch(staffId),
    );
  }

  async availability(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    fromDate: string,
    toDate: string,
  ): Promise<{ timezone: string; slots: PublicAvailabilityWindow[] }> {
    const ctx = await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'doctor',
    );

    // Selected-services total duration decides the slot size — the same
    // window a confirmed booking of these services would actually occupy.
    const offered = await this.discovery.listBranchServices(
      ctx.tenantId,
      ctx.branchId,
    );
    const byId = new Map<string, number>(
      offered.map((s) => [s.id, s.durationMinutes as number]),
    );
    const slotMinutes = ctx.serviceIds.reduce(
      (sum, id) => sum + (byId.get(id) ?? 0),
      0,
    );

    const { timezone, windows } = await this.availabilityService.publicWindows(
      ctx.tenantId,
      {
        branchId: ctx.branchId,
        staffId: ctx.staffId!,
        fromDate,
        toDate,
        slotMinutes: slotMinutes > 0 ? slotMinutes : undefined,
        // Never offer a time that has already started — confirm would refuse it.
        notBefore: new Date(),
      },
    );
    return { timezone, slots: windows };
  }

  async selectSlot(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    startAt: string,
  ): Promise<void> {
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) {
      throw this.unprocessable('startAt must be a valid ISO-8601 timestamp.');
    }
    // Refuse a past time HERE, not five steps later at confirm (which re-checks
    // it anyway): the patient would otherwise fill in their details first.
    if (start.getTime() <= Date.now()) {
      throw this.unprocessable(
        'That time has already passed. Please choose a later time.',
      );
    }
    // Requires a doctor first: a time means nothing without whose calendar it is.
    await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'doctor',
    );

    await this.bookingContext.patchSelection(
      guestTenantId,
      conversationId,
      slotSelectedPatch(startAt),
    );
  }

  /**
   * FR-P015/T067 — creates the appointment for an anonymous visitor. Takes
   * NO resource ids from the caller — clinic, branch, service, doctor and
   * time all come from the server-validated session. Reuses
   * `AppointmentsService.create` verbatim, which re-runs every check
   * transactionally, so a selection that went stale during the flow fails
   * at commit rather than booking wrongly. Runs under the clinic's
   * least-privilege bot actor, in that clinic's OWN tenant context — the
   * guest principal never touches the write path.
   */
  async confirm(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    input: ConfirmBookingInput,
  ): Promise<ConfirmedBooking> {
    const ctx = await this.requireContext(
      guestTenantId,
      conversationId,
      principal,
      'book',
    );
    const hasInsurance = input.hasInsurance === true;

    const appt = await runAsBotActor(
      this.botActor,
      this.tenantContext,
      ctx.tenantId,
      async (bot) => {
        const customer = await this.customers.findOrCreateForBooking(
          ctx.tenantId,
          {
            fullName: input.fullName,
            phone: input.phone,
            email: input.email,
          },
        );

        // Bind the customer server-side so nothing later can retarget the
        // booking at someone else's record.
        await this.bookingContext.patchSelection(
          guestTenantId,
          conversationId,
          {
            bookingCustomerId: customer.id,
          },
        );

        const dto: CreateAppointmentDto = {
          branchId: ctx.branchId,
          customerId: customer.id,
          staffId: ctx.staffId!,
          startAt: ctx.startAt!,
          serviceIds: ctx.serviceIds,
          notes: input.notes,
          source: AppointmentSource.PUBLIC_AI,
          hasInsurance,
        };
        return this.appointments.create(ctx.tenantId, bot.id, dto);
      },
    );

    // T071 (FR-P015) — `AppointmentCreatedEvent` already fires from `create()`
    // above; this is the domain-specific attribution record, following
    // `AppointmentAuditService`'s existing pattern (`patient-cancellation.service.ts`,
    // `patient-reschedule.service.ts` call it the same way). Best-effort: a
    // logging failure never blocks a booking that already succeeded.
    await this.audit.record(
      APPOINTMENT_AUDIT_ACTION.BOOKED_PUBLICLY,
      ctx.tenantId,
      appt.id,
      {
        source: AppointmentSource.PUBLIC_AI,
        hasInsurance,
      },
      // Branch context; the visitor is anonymous, so there is no actor.
      { branchId: appt.branch?.id ?? null },
    );

    const paymentLink = hasInsurance
      ? undefined
      : await this.paymentLinks.createIfDue(ctx.tenantId, appt);

    return {
      appointmentId: appt.id,
      status: appt.status,
      paymentStatus: appt.payment_status,
      startAt: appt.start_at,
      endAt: appt.end_at,
      totalAmount: appt.total_amount ?? null,
      currency: appt.currency,
      hasInsurance,
      ...(paymentLink ? { paymentLink } : {}),
    };
  }

  private async requireContext(
    guestTenantId: string,
    conversationId: string,
    principal: GuestPrincipal,
    need: 'clinic' | 'branch' | 'service' | 'doctor' | 'slot' | 'book',
  ): Promise<PublicBookingContext> {
    return this.bookingContext.requireContext(
      guestTenantId,
      conversationId,
      principal,
      need,
    );
  }

  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, {
      message: 'This clinic is not available for online booking.',
    });
  }

  private unprocessable(message: string): AppError {
    return new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message });
  }
}
