import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { WaitlistEntry } from '../../entities/Calendar&Appointments/WaitlistEntry';
import { WaitlistOffer } from '../../entities/Calendar&Appointments/WaitlistOffer';
import { Customer } from '../../entities/CRM/Customer';
import { Service } from '../../entities/Services/Service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { Branch } from '../../entities/SaaS-Core/Branch';
import { WaitlistOfferState, WaitlistState } from '../../entities/enums';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWaitlistEntryDto } from './dto/create-waitlist-entry.dto';
import { UpdateWaitlistEntryDto } from './dto/update-waitlist-entry.dto';
import { ListWaitlistEntriesQueryDto } from './dto/list-waitlist-entries-query.dto';

/** Terminal states — an entry here is done; no further transition applies. */
const TERMINAL_STATES: WaitlistState[] = [
  WaitlistState.FULFILLED,
  WaitlistState.EXPIRED,
  WaitlistState.CANCELLED,
];

/**
 * Spec 014 (Clinic Platform Completion) — T156 (US9, data-model.md §1.8,
 * §4). `WaitlistEntry` lifecycle: create, update (preferences only), cancel,
 * and the window-expiry sweep (FR-W004). Never creates or touches an
 * `Appointment` — that only ever happens through `WaitlistOfferService` →
 * the unchanged `AppointmentsService.create`.
 */
@Injectable()
export class WaitlistService {
  constructor(
    @InjectRepository(WaitlistEntry)
    private readonly entries: Repository<WaitlistEntry>,
    @InjectRepository(WaitlistOffer)
    private readonly offers: Repository<WaitlistOffer>,
    @InjectRepository(Customer)
    private readonly customers: Repository<Customer>,
    @InjectRepository(Service)
    private readonly services: Repository<Service>,
    @InjectRepository(StaffProfile)
    private readonly staff: Repository<StaffProfile>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
  ) {}

  async create(
    tenantId: string,
    dto: CreateWaitlistEntryDto,
  ): Promise<WaitlistEntry> {
    await this.assertExists(
      this.customers,
      tenantId,
      dto.customerId,
      'Customer',
    );
    await this.assertExists(this.services, tenantId, dto.serviceId, 'Service');
    if (dto.preferredStaffId) {
      await this.assertExists(
        this.staff,
        tenantId,
        dto.preferredStaffId,
        'Staff member',
      );
    }
    if (dto.preferredBranchId) {
      await this.assertExists(
        this.branches,
        tenantId,
        dto.preferredBranchId,
        'Branch',
      );
    }
    if (
      dto.windowStart &&
      dto.windowEnd &&
      new Date(dto.windowEnd) <= new Date(dto.windowStart)
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'windowEnd must be after windowStart',
      });
    }

    // FR-W013's duplicate refusal is the DATABASE constraint
    // `UQ_waitlist_entries_active_dup` — a QueryFailedError here is mapped
    // to a clean 409 by `mapTypeOrmError`/`AllExceptionsFilter` (see the
    // `UQ_waitlist_entries_active_dup` entry in typeorm-error.mapper.ts), not
    // caught and re-thrown here — no application pre-check exists to race.
    const entry = this.entries.create({
      tenant: { id: tenantId } as never,
      customer: { id: dto.customerId } as never,
      service: { id: dto.serviceId } as never,
      preferred_staff: dto.preferredStaffId
        ? ({ id: dto.preferredStaffId } as never)
        : null,
      preferred_branch: dto.preferredBranchId
        ? ({ id: dto.preferredBranchId } as never)
        : null,
      window_start: dto.windowStart ? new Date(dto.windowStart) : null,
      window_end: dto.windowEnd ? new Date(dto.windowEnd) : null,
      priority: dto.priority ?? 0,
      state: WaitlistState.WAITING,
      // FR-W004 — auto-expires once the requested window has passed. An
      // entry with no window never expires on its own (it waits until
      // cancelled or fulfilled).
      expires_at: dto.windowEnd ? new Date(dto.windowEnd) : null,
    });
    return this.entries.save(entry);
  }

  async list(
    tenantId: string,
    query: ListWaitlistEntriesQueryDto,
  ): Promise<{
    data: WaitlistEntry[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [data, total] = await this.entries.findAndCount({
      where: {
        tenant: { id: tenantId },
        ...(query.state ? { state: query.state } : {}),
        ...(query.customerId ? { customer: { id: query.customerId } } : {}),
        ...(query.serviceId ? { service: { id: query.serviceId } } : {}),
      },
      relations: {
        customer: true,
        service: true,
        preferred_staff: { user: true },
        preferred_branch: true,
      },
      order: { priority: 'DESC', created_at: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  async findOne(tenantId: string, id: string): Promise<WaitlistEntry> {
    const entry = await this.entries.findOne({
      where: { id, tenant: { id: tenantId } },
      relations: {
        customer: true,
        service: true,
        preferred_staff: { user: true },
        preferred_branch: true,
      },
    });
    if (!entry) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Waitlist entry not found',
      });
    }
    return entry;
  }

  /** Offers made against one entry (contracts F9 `GET /waitlist/:id/offers`). */
  async listOffers(
    tenantId: string,
    entryId: string,
  ): Promise<WaitlistOffer[]> {
    await this.findOne(tenantId, entryId); // 404 for a cross-tenant/unknown entry
    return this.offers.find({
      where: { tenant: { id: tenantId }, entry: { id: entryId } },
      relations: { branch: true, staff: { user: true }, appointment: true },
      order: { created_at: 'DESC' },
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateWaitlistEntryDto,
  ): Promise<WaitlistEntry> {
    const entry = await this.findOne(tenantId, id);
    if (TERMINAL_STATES.includes(entry.state)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `This entry is already ${entry.state.toLowerCase()} and can no longer be edited`,
      });
    }
    if (dto.preferredStaffId !== undefined) {
      if (dto.preferredStaffId) {
        await this.assertExists(
          this.staff,
          tenantId,
          dto.preferredStaffId,
          'Staff member',
        );
      }
      entry.preferred_staff = dto.preferredStaffId
        ? ({ id: dto.preferredStaffId } as never)
        : null;
    }
    if (dto.preferredBranchId !== undefined) {
      if (dto.preferredBranchId) {
        await this.assertExists(
          this.branches,
          tenantId,
          dto.preferredBranchId,
          'Branch',
        );
      }
      entry.preferred_branch = dto.preferredBranchId
        ? ({ id: dto.preferredBranchId } as never)
        : null;
    }
    if (dto.windowStart !== undefined) {
      entry.window_start = dto.windowStart ? new Date(dto.windowStart) : null;
    }
    if (dto.windowEnd !== undefined) {
      entry.window_end = dto.windowEnd ? new Date(dto.windowEnd) : null;
      entry.expires_at = entry.window_end;
    }
    if (
      entry.window_start &&
      entry.window_end &&
      entry.window_end <= entry.window_start
    ) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'windowEnd must be after windowStart',
      });
    }
    if (dto.priority !== undefined) entry.priority = dto.priority;
    return this.entries.save(entry);
  }

  /**
   * FR-W014 — cancel at any time. Also withdraws any still-live (`PENDING`)
   * offer for this entry: an offer holds nothing on its own (FR-W009), but a
   * cancelled entry's offer has nobody left to answer it.
   */
  async cancel(tenantId: string, id: string): Promise<WaitlistEntry> {
    const entry = await this.findOne(tenantId, id);
    if (TERMINAL_STATES.includes(entry.state)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `This entry is already ${entry.state.toLowerCase()}`,
      });
    }
    await this.offers
      .createQueryBuilder()
      .update(WaitlistOffer)
      .set({ state: WaitlistOfferState.WITHDRAWN })
      .where('"entryId" = :id AND state = :pending', {
        id,
        pending: WaitlistOfferState.PENDING,
      })
      .execute();
    entry.state = WaitlistState.CANCELLED;
    return this.entries.save(entry);
  }

  /**
   * FR-W004 sweep half (the other half — offer expiry — lives in
   * `WaitlistOfferService.expireDueOffers`): entries that were never offered
   * anything before their requested window passed. Scoped to `WAITING` only
   * — an `OFFERED` entry is governed by its own offer's `responds_by`, not
   * by this sweep, and returns to `WAITING` (re-entering this sweep's scope
   * on the NEXT tick) via the offer-expiry path if its window has also
   * since passed. A bulk conditional UPDATE, not a read-then-write loop.
   */
  async expireDueEntries(): Promise<number> {
    const result = await this.entries
      .createQueryBuilder()
      .update(WaitlistEntry)
      .set({ state: WaitlistState.EXPIRED })
      .where(
        'state = :waiting AND expires_at IS NOT NULL AND expires_at < :now',
        {
          waiting: WaitlistState.WAITING,
          now: new Date(),
        },
      )
      .execute();
    return result.affected ?? 0;
  }

  private async assertExists(
    repo: Repository<{ id: string }>,
    tenantId: string,
    id: string,
    label: string,
  ): Promise<void> {
    const exists = await repo.exists({
      where: { id, tenant: { id: tenantId } } as never,
    });
    if (!exists) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: `${label} not found for this clinic`,
      });
    }
  }
}
