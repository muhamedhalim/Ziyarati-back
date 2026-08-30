import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { WaitlistEntry } from '../../entities/Calendar&Appointments/WaitlistEntry';
import { WaitlistState } from '../../entities/enums';
import { AvailabilityService } from '../scheduling/availability.service';

/**
 * Freed slot's identity — the (tenant-scoped) fields matching cares about.
 * `serviceIds` covers every service on the freed appointment; a candidate
 * matches if its own single `service` is any one of them.
 */
export interface FreedSlot {
  branchId: string;
  staffId: string;
  serviceIds: string[];
  startAt: Date;
  endAt: Date;
}

/**
 * Bounded candidate pool pulled from the database per evaluation — the hard
 * ceiling that makes FR-W016 ("bounded work per freed time") a fact about
 * the query, not a hope about typical data volume. Ordered by
 * `(priority DESC, created_at ASC)` at the DB level, so truncating to this
 * pool never drops a higher-priority/earlier-joined candidate in favour of a
 * later one still inside the pool.
 */
const MATCH_CANDIDATE_POOL = 50;

/**
 * How many entries get a SIMULTANEOUS offer for the same freed slot
 * (first-to-accept wins; `WaitlistOfferService` withdraws the rest on
 * acceptance — FR-W012). Bounded independently of the candidate pool so a
 * clinic with hundreds of waiting entries for one service still only ever
 * notifies a handful of patients per freed slot.
 */
export const MATCH_OFFER_TOP_N = 3;

/**
 * Spec 014 (Clinic Platform Completion) — T157 (US9, FR-W005-FR-W007,
 * FR-W016). Finds eligible `WaitlistEntry` rows for one freed slot, in
 * policy order, and confirms the slot is genuinely bookable AT THE MOMENT OF
 * OFFER (FR-W006) — never relies on the freed-event alone, since time has
 * passed (the job travelled through the queue) between the event firing and
 * this running.
 */
@Injectable()
export class WaitlistMatcherService {
  private readonly logger = new Logger('WaitlistMatcher');

  constructor(
    @InjectRepository(WaitlistEntry)
    private readonly entries: Repository<WaitlistEntry>,
    private readonly availability: AvailabilityService,
  ) {}

  /**
   * Returns up to `MATCH_OFFER_TOP_N` entries to offer the freed slot to, or
   * an empty array when the slot is no longer genuinely bookable (FR-W006 —
   * someone already took it between the freeing event and this running) or
   * nothing matches. Never throws for "nothing to offer" — that is the
   * expected common case, not a failure.
   */
  async findEligibleEntries(
    tenantId: string,
    slot: FreedSlot,
  ): Promise<WaitlistEntry[]> {
    if (slot.serviceIds.length === 0) return [];

    const pool = await this.entries.find({
      where: {
        tenant: { id: tenantId },
        service: { id: In(slot.serviceIds) },
        state: WaitlistState.WAITING,
      },
      relations: { preferred_staff: true, preferred_branch: true },
      order: { priority: 'DESC', created_at: 'ASC' },
      take: MATCH_CANDIDATE_POOL,
    });

    const matched: WaitlistEntry[] = [];
    for (const candidate of pool) {
      if (
        candidate.preferred_branch &&
        candidate.preferred_branch.id !== slot.branchId
      ) {
        continue;
      }
      if (
        candidate.preferred_staff &&
        candidate.preferred_staff.id !== slot.staffId
      ) {
        continue;
      }
      if (candidate.window_start && slot.startAt < candidate.window_start) {
        continue;
      }
      if (candidate.window_end && slot.startAt > candidate.window_end) {
        continue;
      }
      matched.push(candidate);
      if (matched.length >= MATCH_OFFER_TOP_N) break;
    }

    if (matched.length === 0) return [];

    // FR-W006 — every matched candidate wants the IDENTICAL (branch, staff,
    // start, end), so one check covers them all.
    const bookable = await this.availability
      .assertBookable(
        tenantId,
        slot.branchId,
        slot.staffId,
        slot.startAt,
        slot.endAt,
      )
      .then(() => true)
      .catch(() => false);
    if (!bookable) {
      this.logger.log(
        `freed slot branch=${slot.branchId} staff=${slot.staffId} start=${slot.startAt.toISOString()} ` +
          'is no longer bookable at offer time — offering nothing',
      );
      return [];
    }

    return matched;
  }
}
