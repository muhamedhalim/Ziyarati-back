import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AppError, ErrorCode } from '../../../common/errors';
import { Appointment } from '../../../entities/Calendar&Appointments/Appointment';
import { Branch } from '../../../entities/SaaS-Core/Branch';
import { StaffProfile } from '../../../entities/Staff/StaffProfile';
import { Service } from '../../../entities/Services/Service';

import {
  buildJourneyDimensionQuery,
  buildJourneyOverallQuery,
  buildReminderRowsQuery,
  type JourneyQueryOptions,
} from './journey-sql';
import type { JourneyDimension } from './journey.constants';
import type {
  JourneyDimensionRow,
  JourneyLabelInfo,
  JourneyOverallRow,
  JourneyReminderRow,
} from './journey.types';

/**
 * Patient Journey — runs the SQL `journey-sql.ts` builds and the label
 * lookups the shaping/insight layers need. Only `Repository<Appointment>`
 * is injected (the `computeRetention` precedent); every other entity's
 * repository is obtained from ITS manager at call time via
 * `manager.getRepository(...)` — valid for any entity registered anywhere
 * in the DataSource, not only ones this module's `forFeature` declares — so
 * `AnalyticsModule`'s `forFeature` list needs no changes for this feature.
 */
@Injectable()
export class JourneyAggregationService {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointments: Repository<Appointment>,
  ) {}

  async fetchOverall(opts: JourneyQueryOptions): Promise<JourneyOverallRow> {
    const { sql, params } = buildJourneyOverallQuery(opts);
    const rows = await this.appointments.manager.query<JourneyOverallRow[]>(
      sql,
      params,
    );
    // An aggregate with no GROUP BY always returns exactly one row, even
    // over an empty input set (every COUNT is 0, every percentile is NULL).
    return rows[0];
  }

  async fetchDimension(
    opts: JourneyQueryOptions,
    dimension: JourneyDimension,
  ): Promise<JourneyDimensionRow[]> {
    const { sql, params } = buildJourneyDimensionQuery(opts, dimension);
    return this.appointments.manager.query<JourneyDimensionRow[]>(sql, params);
  }

  async fetchReminderRows(
    opts: JourneyQueryOptions,
  ): Promise<JourneyReminderRow[]> {
    const { sql, params } = buildReminderRowsQuery(opts);
    return this.appointments.manager.query<JourneyReminderRow[]>(sql, params);
  }

  async fetchBranchLabels(
    tenantId: string,
    ids: string[],
  ): Promise<Record<string, JourneyLabelInfo>> {
    if (ids.length === 0) return {};
    const rows = await this.appointments.manager.getRepository(Branch).find({
      where: { id: In(ids), tenant: { id: tenantId } },
      withDeleted: true,
    });
    const out: Record<string, JourneyLabelInfo> = {};
    for (const b of rows) {
      out[b.id] = {
        name: b.name,
        inactive: !!b.deleted_at,
        configuredMinutes: null,
      };
    }
    return out;
  }

  async fetchStaffLabels(
    tenantId: string,
    ids: string[],
  ): Promise<Record<string, JourneyLabelInfo>> {
    if (ids.length === 0) return {};
    const rows = await this.appointments.manager
      .getRepository(StaffProfile)
      .find({
        where: { id: In(ids), tenant: { id: tenantId } },
        relations: { user: true },
        withDeleted: true,
      });
    const out: Record<string, JourneyLabelInfo> = {};
    for (const s of rows) {
      out[s.id] = {
        name: s.user?.full_name ?? '',
        inactive: !!s.deleted_at,
        configuredMinutes: null,
      };
    }
    return out;
  }

  /**
   * Count of the tenant's active, non-deleted services. Tenant-scoped, and a
   * plain COUNT, so it stays cheap and runs alongside the label lookups.
   */
  async fetchActiveServiceCount(tenantId: string): Promise<number> {
    return this.appointments.manager.getRepository(Service).count({
      where: { tenant: { id: tenantId }, is_active: true },
    });
  }

  /**
   * The staff/service drill-down ids arrive as bare query strings. The SQL is
   * already tenant-scoped (a foreign id just yields an empty result), so this
   * is not a data-leak fix — it stops a foreign or made-up id from being
   * silently "valid" (existence probing, cache-key pollution). Soft-deleted
   * rows ARE accepted: an inactive staff member / service still appears in
   * the breakdown and must remain drillable.
   */
  async assertStaff(tenantId: string, staffId: string): Promise<void> {
    const found = await this.appointments.manager
      .getRepository(StaffProfile)
      .findOne({
        where: { id: staffId, tenant: { id: tenantId } },
        select: { id: true },
        withDeleted: true,
      });
    if (!found) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Staff not found' });
    }
  }

  async assertService(tenantId: string, serviceId: string): Promise<void> {
    const found = await this.appointments.manager.getRepository(Service).findOne({
      where: { id: serviceId, tenant: { id: tenantId } },
      select: { id: true },
      withDeleted: true,
    });
    if (!found) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Service not found' });
    }
  }

  async fetchServiceLabels(
    tenantId: string,
    ids: string[],
  ): Promise<Record<string, JourneyLabelInfo>> {
    if (ids.length === 0) return {};
    const rows = await this.appointments.manager.getRepository(Service).find({
      where: { id: In(ids), tenant: { id: tenantId } },
      withDeleted: true,
    });
    const out: Record<string, JourneyLabelInfo> = {};
    for (const s of rows) {
      out[s.id] = {
        name: s.name,
        inactive: !s.is_active || !!s.deleted_at,
        configuredMinutes: s.duration_minutes,
      };
    }
    return out;
  }
}
