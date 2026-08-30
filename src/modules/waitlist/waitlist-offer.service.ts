import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { WaitlistOffer } from '../../entities/Calendar&Appointments/WaitlistOffer';
import { WaitlistEntry } from '../../entities/Calendar&Appointments/WaitlistEntry';
import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import {
  AppointmentSource,
  PatientActionPurpose,
  WaitlistOfferState,
  WaitlistState,
} from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { AppointmentsService } from '../appointment/appointment.service';
import { CreateAppointmentDto } from '../appointment/dto/create-appointment.dto';
import { PatientActionLinkService } from '../patient-actions/patient-action-link.service';
import { WhatsappBotActorService } from '../whatsapp/whatsapp-bot-actor.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';

import { FreedSlot, WaitlistMatcherService } from './waitlist-matcher.service';

/** Response deadline (FR-W008) — how long a patient has to answer an offer. */
export const OFFER_RESPONSE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Extra grace AFTER `responds_by` before the action LINK itself stops
 * resolving. The link must stay valid past the offer's own deadline so a
 * patient who opens it late still gets a clean "this offer expired" (200 +
 * state), not an indistinguishable-from-fake-token 404 (contracts/
 * public-surfaces.md §C) — and so it survives comfortably past the next
 * `platform.waitlistExpiry` tick (every 5 minutes) that actually flips the
 * offer's state.
 */
const LINK_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Spec 014 (Clinic Platform Completion) — T158 (US9, FR-W008-FR-W012). The
 * one place waitlist offers are created, accepted, declined, expired and
 * withdrawn. Reserves NOTHING itself (FR-W009) — acceptance calls the
 * UNCHANGED `AppointmentsService.create`, so normal conflict prevention
 * (`AvailabilityService.assertBookable`, the `appointments_no_overlap`
 * exclusion constraint) applies exactly as it does to any other booking.
 *
 * CONCURRENCY (FR-W011 — "when two acceptances race, exactly one
 * appointment MUST be created; the loser MUST be told and MUST remain on
 * the waitlist"): `accept()` gates on a single conditional
 * `UPDATE waitlist_offers SET state='ACCEPTED' WHERE id=:id AND
 * state='PENDING'` BEFORE ever calling `AppointmentsService.create` — the
 * exact same "conditional UPDATE, never read-then-write" pattern already
 * used by `PatientActionLinkService.consume` and the rotation-admission
 * check documented in the auth concurrency audit. Two concurrent `accept()`
 * calls for the SAME offer race that one UPDATE; Postgres row-level locking
 * guarantees exactly one affects a row. The loser (0 rows affected) never
 * calls `create()` at all — it returns 409 with the offer's current state
 * immediately, touching nothing else, so the entry is left exactly as the
 * winner is concurrently managing it. If the WINNER's own `create()` call
 * then loses a DIFFERENT race (the slot taken through some other path —
 * a direct booking, or a sibling offer's acceptance closing first), the
 * offer is rolled back to `WITHDRAWN` and the entry back to `WAITING`
 * (FR-W009's "the offer is withdrawn and the patient told").
 */
@Injectable()
export class WaitlistOfferService {
  private readonly logger = new Logger('WaitlistOfferService');

  constructor(
    @InjectRepository(WaitlistOffer)
    private readonly offers: Repository<WaitlistOffer>,
    @InjectRepository(WaitlistEntry)
    private readonly entries: Repository<WaitlistEntry>,
    @InjectRepository(Appointment)
    private readonly appointmentRepo: Repository<Appointment>,
    private readonly matcher: WaitlistMatcherService,
    private readonly appointments: AppointmentsService,
    private readonly links: PatientActionLinkService,
    private readonly botActor: WhatsappBotActorService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // ─────────────────────── T157/T159/T160 — matching ──────────────────── //

  /**
   * T159/T160 entry point: re-resolves everything from ids/scalars (the job
   * payload carries only those), matches, and issues offers. Never throws
   * for "nothing to offer" or "slot no longer bookable" — those are the
   * expected common outcome, not a failure the job should retry.
   */
  async evaluateFreedSlot(
    tenantId: string,
    appointmentId: string,
    freedOverride?: {
      startAt: Date;
      endAt: Date;
      branchId: string;
      staffId: string;
    },
  ): Promise<{ offered: number }> {
    const appointment = await this.appointmentRepo.findOne({
      where: { id: appointmentId, tenant: { id: tenantId } },
      relations: { branch: true, staff: true, services: { service: true } },
    });
    if (!appointment) {
      this.logger.warn(
        `waitlist evaluation: appointment ${appointmentId} not found for tenant ${tenantId} — skipping`,
      );
      return { offered: 0 };
    }

    const serviceIds = (appointment.services ?? [])
      .map((s) => s.service?.id)
      .filter((id): id is string => !!id);
    if (serviceIds.length === 0) return { offered: 0 };

    const slot: FreedSlot = {
      branchId: freedOverride?.branchId ?? appointment.branch.id,
      staffId: freedOverride?.staffId ?? appointment.staff.id,
      startAt: freedOverride?.startAt ?? appointment.start_at,
      endAt: freedOverride?.endAt ?? appointment.end_at,
      serviceIds,
    };

    const eligible = await this.matcher.findEligibleEntries(tenantId, slot);
    if (eligible.length === 0) return { offered: 0 };

    let offered = 0;
    for (const entry of eligible) {
      const created = await this.createOffer(
        tenantId,
        entry,
        slot,
        appointment,
      );
      if (created) offered += 1;
    }
    return { offered };
  }

  /**
   * Moves ONE entry `WAITING → OFFERED` (conditional — guards against a
   * concurrent evaluation for a DIFFERENT freed slot already having claimed
   * this same entry) and, only on success, creates its `WaitlistOffer` and
   * issues the `WAITLIST_OFFER` action link. Returns `false` (no-op) if the
   * entry was no longer `WAITING`.
   */
  private async createOffer(
    tenantId: string,
    entry: WaitlistEntry,
    slot: FreedSlot,
    originatingAppointment: Appointment,
  ): Promise<boolean> {
    const claim = await this.entries
      .createQueryBuilder()
      .update(WaitlistEntry)
      .set({ state: WaitlistState.OFFERED })
      .where('id = :id AND state = :waiting', {
        id: entry.id,
        waiting: WaitlistState.WAITING,
      })
      .execute();
    if (!claim.affected) return false;

    const respondsBy = new Date(Date.now() + OFFER_RESPONSE_WINDOW_MS);
    const offer = await this.offers.save(
      this.offers.create({
        tenant: { id: tenantId } as never,
        entry: { id: entry.id } as never,
        branch: { id: slot.branchId } as never,
        staff: { id: slot.staffId } as never,
        start_at: slot.startAt,
        end_at: slot.endAt,
        state: WaitlistOfferState.PENDING,
        responds_by: respondsBy,
      }),
    );

    // Reuses the WAITLIST_OFFER link purpose (contracts/public-surfaces.md
    // §C). `patient_action_links.appointment` is NOT NULL and has no
    // prospective appointment to point to yet (that only exists on
    // acceptance) — it references the ORIGINATING appointment whose
    // cancellation/reschedule freed this slot instead. None of the new
    // waitlist-offer routes read `link.appointment`; they resolve customer
    // and slot details via `link.waitlist_offer`, so this is safe.
    await this.links.issue(
      tenantId,
      originatingAppointment,
      PatientActionPurpose.WAITLIST_OFFER,
      offer.id,
      new Date(respondsBy.getTime() + LINK_GRACE_MS),
    );

    // FR-W015 (offer delivery via the platform's existing notification
    // mechanisms) is OUT OF SCOPE for T154-T162 — no task in this phase
    // names building that dispatch, and none of T163/T164 (frontend) is
    // mine either. Flagged here rather than silently built partially.
    this.logger.log(
      `waitlist offer ${offer.id} created for entry ${entry.id} (tenant=${tenantId}); ` +
        'delivery to the patient is not wired by this phase — see T158 docblock',
    );

    return true;
  }

  // ───────────────────── T162 — public GET projection ────────────────── //

  /**
   * Read-only projection for the patient-facing GET (contracts/
   * public-surfaces.md §C) — no side effect, returned even when `state` is
   * terminal (EXPIRED/WITHDRAWN/DECLINED/ACCEPTED) so the patient sees what
   * happened. `null` only if the offer row itself is somehow gone (the
   * caller already resolved a valid link pointing at it, so this is
   * defensive, not an expected path).
   */
  async findForPatient(
    tenantId: string,
    offerId: string,
  ): Promise<WaitlistOffer | null> {
    return this.offers.findOne({
      where: { id: offerId, tenant: { id: tenantId } },
      relations: {
        entry: { service: true },
        branch: true,
        staff: { user: true },
      },
    });
  }

  // ─────────────────────────── T158 — accept ─────────────────────────── //

  async accept(
    tenantId: string,
    offerId: string,
  ): Promise<{ appointment: Appointment }> {
    const claim = await this.offers
      .createQueryBuilder()
      .update(WaitlistOffer)
      .set({ state: WaitlistOfferState.ACCEPTED })
      .where('id = :id AND state = :pending AND "responds_by" > :now', {
        id: offerId,
        pending: WaitlistOfferState.PENDING,
        now: new Date(),
      })
      .execute();

    if (!claim.affected) {
      throw await this.notActionableError(offerId);
    }

    const offer = await this.offers.findOne({
      where: { id: offerId },
      relations: {
        entry: { customer: true, service: true },
        branch: true,
        staff: true,
      },
    });
    // Cannot be null: this request just won the conditional UPDATE above.
    const entry = offer!.entry;

    try {
      const bot = await this.botActor.ensureBotActor(tenantId);
      const appointment = await this.tenantContext.run(async () => {
        this.tenantContext.setPrincipal(bot);
        const dto: CreateAppointmentDto = {
          branchId: offer!.branch.id,
          customerId: entry.customer.id,
          staffId: offer!.staff.id,
          startAt: offer!.start_at.toISOString(),
          endAt: offer!.end_at.toISOString(),
          serviceIds: [entry.service.id],
          source: AppointmentSource.PUBLIC_AI,
        };
        return this.appointments.create(tenantId, bot.id, dto);
      });

      await this.offers.update(offer!.id, {
        appointment: { id: appointment.id } as never,
      });
      await this.entries.update(entry.id, { state: WaitlistState.FULFILLED });
      await this.withdrawSiblingOffers(tenantId, offer!);

      return { appointment };
    } catch (err) {
      // FR-W009 — the slot was taken through some OTHER path between this
      // offer being made and this acceptance completing (a direct booking,
      // or a sibling offer's acceptance winning first). Roll the offer back
      // to WITHDRAWN and the entry back to WAITING (FR-W011: "the loser ...
      // MUST remain on the waitlist") rather than leaving either stuck.
      await this.offers.update(offer!.id, {
        state: WaitlistOfferState.WITHDRAWN,
      });
      await this.entries.update(entry.id, { state: WaitlistState.WAITING });

      if (err instanceof AppError && err.statusCode === HttpStatus.CONFLICT) {
        throw new AppError(ErrorCode.CONFLICT, {
          message:
            'This time was just booked by someone else. You remain on the waitlist and may receive another offer.',
          publicContext: { state: WaitlistOfferState.WITHDRAWN },
        });
      }
      throw err;
    }
  }

  // ─────────────────────────── T158 — decline ────────────────────────── //

  async decline(
    tenantId: string,
    offerId: string,
  ): Promise<{ state: WaitlistOfferState }> {
    const claim = await this.offers
      .createQueryBuilder()
      .update(WaitlistOffer)
      .set({ state: WaitlistOfferState.DECLINED })
      .where('id = :id AND state = :pending', {
        id: offerId,
        pending: WaitlistOfferState.PENDING,
      })
      .execute();

    if (!claim.affected) {
      throw await this.notActionableError(offerId);
    }

    const offer = await this.offers.findOne({
      where: { id: offerId },
      relations: { entry: true },
    });
    // Contracts/public-surfaces.md §C — declining returns the entry to WAITING.
    await this.entries
      .createQueryBuilder()
      .update(WaitlistEntry)
      .set({ state: WaitlistState.WAITING })
      .where('id = :id AND state = :offered', {
        id: offer!.entry.id,
        offered: WaitlistState.OFFERED,
      })
      .execute();

    return { state: WaitlistOfferState.DECLINED };
  }

  // ─────────────────────── T160 — expiry sweep ───────────────────────── //

  /**
   * `platform.waitlistExpiry` half for offers: bulk conditional UPDATE,
   * `PENDING` past `responds_by` → `EXPIRED`, then reverts each such
   * offer's entry `OFFERED → WAITING` (FR-W004: the entry survives, the
   * offer does not). Idempotent — re-running finds nothing left to expire.
   */
  async expireDueOffers(): Promise<number> {
    // Bounded by the `(tenant, state, responds_by)` index — never a full
    // table scan, and never grows with tenants that have nothing due.
    const due = await this.offers.find({
      where: {
        state: WaitlistOfferState.PENDING,
        responds_by: LessThan(new Date()),
      },
      relations: { entry: true },
    });
    let count = 0;
    for (const offer of due) {
      const claim = await this.offers
        .createQueryBuilder()
        .update(WaitlistOffer)
        .set({ state: WaitlistOfferState.EXPIRED })
        .where('id = :id AND state = :pending', {
          id: offer.id,
          pending: WaitlistOfferState.PENDING,
        })
        .execute();
      if (!claim.affected) continue; // already resolved by an accept/decline racing this sweep
      await this.entries
        .createQueryBuilder()
        .update(WaitlistEntry)
        .set({ state: WaitlistState.WAITING })
        .where('id = :id AND state = :offeredState', {
          id: offer.entry.id,
          offeredState: WaitlistState.OFFERED,
        })
        .execute();
      count += 1;
    }
    return count;
  }

  // ──────────────────────────────── Helpers ──────────────────────────── //

  /**
   * FR-W012 — accepting an offer withdraws every OTHER live offer for the
   * identical (branch, staff, start, end), each belonging to a different
   * entry (bounded top-N matching, T157, can hand the same slot to several
   * entries at once). Their entries return to WAITING so they remain
   * eligible for a future freed slot.
   */
  private async withdrawSiblingOffers(
    tenantId: string,
    accepted: WaitlistOffer,
  ): Promise<void> {
    const siblings = await this.offers.find({
      where: {
        tenant: { id: tenantId },
        state: WaitlistOfferState.PENDING,
        start_at: accepted.start_at,
        end_at: accepted.end_at,
        branch: { id: accepted.branch.id },
        staff: { id: accepted.staff.id },
      },
      relations: { entry: true },
    });
    for (const sibling of siblings) {
      if (sibling.id === accepted.id) continue;
      const claim = await this.offers
        .createQueryBuilder()
        .update(WaitlistOffer)
        .set({ state: WaitlistOfferState.WITHDRAWN })
        .where('id = :id AND state = :pending', {
          id: sibling.id,
          pending: WaitlistOfferState.PENDING,
        })
        .execute();
      if (!claim.affected) continue;
      await this.entries
        .createQueryBuilder()
        .update(WaitlistEntry)
        .set({ state: WaitlistState.WAITING })
        .where('id = :id AND state = :offeredState', {
          id: sibling.entry.id,
          offeredState: WaitlistState.OFFERED,
        })
        .execute();
    }
  }

  /**
   * Loads the offer's CURRENT state (it exists — the caller already
   * resolved a valid, unconsumed action link pointing at it) and returns a
   * 409 carrying it, per contracts/public-surfaces.md §C: a valid token
   * whose offer is no longer actionable is 409 + state, never a 404 and
   * never a 410.
   */
  private async notActionableError(offerId: string): Promise<AppError> {
    const current = await this.offers.findOne({ where: { id: offerId } });
    return new AppError(ErrorCode.CONFLICT, {
      message: 'This offer is no longer actionable.',
      publicContext: { state: current?.state ?? WaitlistOfferState.EXPIRED },
    });
  }
}
