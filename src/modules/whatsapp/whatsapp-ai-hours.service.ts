import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Branch } from '../../entities/SaaS-Core/Branch';
import { WorkingHour } from '../../entities/Staff/WorkingHour';
import { HoursRow, isOpenAt } from './whatsapp-ai-hours';

/**
 * Is the clinic open right now? Reads `working_hours` + `Branch.timezone` (the
 * same sources the booking engine uses) so the AI schedule can never disagree
 * with the hours the clinic published.
 *
 * Tenant-scoped on every read. Throws on a read failure — the policy service
 * turns that into `POLICY_READ_FAILED`, i.e. fails closed.
 */
@Injectable()
export class WhatsappAiHoursService {
  constructor(
    @InjectRepository(WorkingHour)
    private readonly hours: Repository<WorkingHour>,
    @InjectRepository(Branch)
    private readonly branches: Repository<Branch>,
  ) {}

  /**
   * `branchId` given → that branch. Otherwise the clinic as a whole: open when
   * ANY of its active branches is open (a conversation not tied to a branch
   * belongs to the clinic, and a clinic with one branch open is open).
   *
   * `null` = no hours configured for the scope, so the schedule is not
   * applicable (see `isOpenAt`).
   */
  async isOpen(
    tenantId: string,
    branchId: string | null,
    at: Date = new Date(),
  ): Promise<boolean | null> {
    const branches = await this.branches.find({
      where: {
        tenant: { id: tenantId },
        is_active: true,
        ...(branchId ? { id: branchId } : {}),
      },
      select: { id: true, timezone: true },
    });
    if (branches.length === 0) return null;

    const rows = await this.hours.find({
      where: {
        tenant: { id: tenantId },
        branch: { id: In(branches.map((b) => b.id)) },
      },
      relations: { branch: true },
      select: {
        id: true,
        day_of_week: true,
        start_time: true,
        end_time: true,
        is_closed: true,
        branch: { id: true },
      },
    });

    let anyConfigured = false;
    for (const b of branches) {
      const own: HoursRow[] = rows.filter((r) => r.branch?.id === b.id);
      const open = isOpenAt(own, b.timezone, at);
      if (open === null) continue;
      anyConfigured = true;
      if (open) return true;
    }
    return anyConfigured ? false : null;
  }
}
