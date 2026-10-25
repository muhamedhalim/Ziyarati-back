import { AppointmentSource } from '../../../entities/enums';
import { isIsoInstant } from '../prompt/untrusted-text';
import { type ToolResult } from './ai-tool-args';
import { AI_PUBLIC_TOOL } from './ai-public-booking-tools.constants';
import { runAsBotActor } from '../../whatsapp/bot-actor-run';
import {
  branchSelectedPatch,
  clinicSelectedPatch,
  doctorSelectedPatch,
  servicesSelectedPatch,
} from '../../public-booking/public-booking-selection';
import { AiToolHandlerBase } from './ai-tool-handler.base';
import type { ToolContext } from './ai-tool-dispatch.service';

// Moved verbatim out of `AiToolDispatchService` (Phase 4 / S-01). Behaviour is unchanged.


export class PublicBookingToolHandler extends AiToolHandlerBase {
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
  async listCities(): Promise<ToolResult> {
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
  async selectClinic(
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
      // AI-006: a new clinic invalidates every downstream choice (see
      // `public-booking-selection.ts` for why the reset uses SESSION_UNSET).
      clinicSelectedPatch(clinicId, only?.id),
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
  reselectionGuidance(language?: string): string {
    if (language === 'ar') {
      return 'بما أنك اخترت عيادة جديدة، تم إلغاء اختيارك السابق للخدمة والطبيب والموعد. الرجاء اختيار الخدمة والطبيب والموعد مرة أخرى لهذه العيادة.';
    }
    return 'Since you switched clinics, your previous service, doctor, and time-slot selections were cleared. Please choose the service, doctor, and time slot again for this clinic.';
  }

  async selectBranch(
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
      // F-21: doctors and services are branch-specific — a branch change
      // invalidates them.
      branchSelectedPatch(owner, branchId),
    );
    return { success: true, branchId };
  }

  async listBranchServices(ctx: ToolContext): Promise<ToolResult> {
    const booking = await this.requirePublicContext(ctx, 'branch');
    const services = await this.discovery.listBranchServices(
      booking.tenantId,
      booking.branchId,
    );
    return { success: true, ...this.servicesForModel(services) };
  }

  async listBranchDoctors(ctx: ToolContext): Promise<ToolResult> {
    const booking = await this.requirePublicContext(ctx, 'branch');
    const doctors = await this.discovery.listBranchDoctors(
      booking.tenantId,
      booking.branchId,
    );
    return { success: true, doctors };
  }

  async selectService(
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
      servicesSelectedPatch(serviceIds),
    );
    return {
      success: true,
      services: offered.filter(
        (s) => offeredIds.has(s.id) && serviceIds.includes(s.id),
      ),
    };
  }

  async selectDoctor(
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
      // F-21: the doctor's calendar differs, so a chosen time is stale.
      doctorSelectedPatch(staffId),
    );
    return { success: true, staffId };
  }

  async selectSlot(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // Strict shape, not `new Date()`: that parser accepts free text ("book me
    // at 5"), and this value is stored on the session and shown back to the
    // model in the pinned booking context.
    const startAt = this.str(args.startAt)?.trim();
    if (!isIsoInstant(startAt)) {
      return {
        success: false,
        error:
          'startAt must be the ISO-8601 timestamp exactly as returned by search_public_availability.',
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
  async bookPublicAppointment(
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
        const appt = await runAsBotActor(this.botActor, this.tenantContext, booking.tenantId, async (bot) => {
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

}
