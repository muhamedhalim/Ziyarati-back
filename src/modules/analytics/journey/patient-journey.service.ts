import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantSetting } from '../../../entities/SaaS-Core/TenantSetting';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

import { AdvancedAnalyticsService } from '../advanced-analytics.service';
import { AnalyticsCacheService, CACHE_NS } from '../analytics-cache.service';
import {
  dayRangeUtc,
  inclusiveDayCount,
  priorPeriod,
  type ReportDate,
} from '../analytics.constants';

import { JourneyAggregationService } from './journey-aggregation.service';
import {
  round1,
  shapeBreakdownRow,
  shapeComparison,
  shapeCounts,
  shapeDataQuality,
  shapeDurationSuggestions,
  shapeJourneyCoverages,
  shapeKpis,
  shapeReminders,
  shapeStages,
} from './journey-shaping';
import { generateInsights, type JourneyLabel } from './journey-insights';
import {
  JOURNEY_DIMENSIONS,
  JOURNEY_KNOWN_TIMEZONES,
  JOURNEY_THRESHOLDS,
} from './journey.constants';
import type { JourneyDimension } from './journey.constants';
import type { JourneyQueryOptions } from './journey-sql';
import type {
  JourneyAggregate,
  JourneyBreakdownResponse,
  JourneyBreakdownRow,
  JourneyDimensionRow,
  JourneyLabelInfo,
  JourneySummaryResponse,
} from './journey.types';
import type { QueryPatientJourneyDto } from './dto/query-patient-journey.dto';
import type { QueryPatientJourneyBreakdownDto } from './dto/query-patient-journey-breakdown.dto';

/**
 * Patient Journey — orchestration (plan §10). Both routes share ONE cached
 * aggregate (`computeAggregate`, keyed on the resolved scope + range, NOT
 * on which dimension the caller asked for) so that after the first request
 * warms the cache, every further summary/breakdown call for the same
 * (range, branch, staff, service) — including switching the breakdown
 * dimension — runs ZERO further aggregation SQL. Everything derived from
 * the aggregate (distributions, suppression, insights) is reshaped on
 * EVERY call, cache hit or miss, because that work is pure/cheap and a
 * threshold-constant change must take effect immediately, not wait out the
 * 60s cache TTL.
 */
@Injectable()
export class PatientJourneyService {
  constructor(
    private readonly journeyAgg: JourneyAggregationService,
    private readonly advanced: AdvancedAnalyticsService,
    private readonly cache: AnalyticsCacheService,
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
  ) {}

  async summary(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryPatientJourneyDto,
    now: Date = new Date(),
  ): Promise<JourneySummaryResponse> {
    const { from, to } = this.advanced.validateRange(dto);
    const scope = await this.advanced.resolveScope(
      tenantId,
      user,
      dto.branchId,
    );
    const aggregate = await this.loadAggregate(
      tenantId,
      from,
      to,
      scope.branchId,
      dto.staffId,
      dto.serviceId,
      now,
    );

    const envelope = this.advanced.envelope(
      from,
      to,
      scope.branchId,
      aggregate.settings.currency,
    );
    const cov = shapeJourneyCoverages(aggregate.overall);
    const kpis = shapeKpis(
      aggregate.overall,
      JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
      cov,
    );
    const counts = shapeCounts(aggregate.overall);
    const stages = shapeStages(aggregate.overall, kpis);
    const dataQuality = shapeDataQuality(aggregate.overall);
    const rangeDays = inclusiveDayCount(from, to);
    const { comparison, comparisonUnavailable } = shapeComparison(
      aggregate.priorOverall,
      aggregate.priorRange,
      rangeDays,
    );
    const reminders = shapeReminders(
      aggregate.overall,
      aggregate.reminderRows,
      {
        remindersEnabled: aggregate.settings.remindersEnabled,
        reminderLeadMinutes: aggregate.settings.reminderLeadMinutes,
      },
    );

    const labels = {
      branch: toLabelMap(aggregate.labels.branch),
      staff: toLabelMap(aggregate.labels.staff),
      service: toLabelMap(aggregate.labels.service),
    };

    const durationSuggestions = shapeDurationSuggestions(
      aggregate.byDimension.service,
      new Map(
        Object.entries(aggregate.labels.service).map(([id, l]) => [
          id,
          {
            name: l.name,
            inactive: l.inactive,
            configuredMinutes: l.configuredMinutes,
          },
        ]),
      ),
    );

    const { insights, truncated } = generateInsights({
      overall: aggregate.overall,
      priorOverall: aggregate.priorOverall,
      kpis,
      queueCoverageRate: cov.queue.rate,
      remindersEnabled: aggregate.settings.remindersEnabled,
      reminders,
      dimensions: {
        branch: aggregate.byDimension.branch,
        staff: aggregate.byDimension.staff,
        service: aggregate.byDimension.service,
        hour: aggregate.byDimension.hour,
      },
      labels,
    });

    return {
      ...envelope,
      empty: aggregate.overall.booked === 0,
      filters: {
        staffId: dto.staffId ?? null,
        serviceId: dto.serviceId ?? null,
      },
      timeBasis: TIME_BASIS,
      counts,
      stages,
      kpis,
      coverage: {
        queue: cov.queue,
        consultationTiming: cov.consultationTiming,
        reminders: reminders.available
          ? {
              numerator: reminders.appointments.reminded,
              denominator: reminders.appointments.eligible,
              rate:
                reminders.appointments.eligible > 0
                  ? round1(
                      reminders.appointments.reminded /
                        reminders.appointments.eligible,
                    )
                  : null,
            }
          : null,
      },
      comparison,
      comparisonUnavailable,
      reminders,
      durationSuggestions,
      dataQuality,
      insights,
      insightsTruncated: truncated,
      thresholds: {
        minSample: JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
        minBreakdownSample: JOURNEY_THRESHOLDS.MIN_SAMPLE_BREAKDOWN_ROW,
        minCoverage: JOURNEY_THRESHOLDS.MIN_COVERAGE,
        maxIntervalMinutes: 720,
      },
    };
  }

  async breakdown(
    tenantId: string,
    user: AuthenticatedUser,
    dto: QueryPatientJourneyBreakdownDto,
    now: Date = new Date(),
  ): Promise<JourneyBreakdownResponse> {
    const { from, to } = this.advanced.validateRange(dto);
    const scope = await this.advanced.resolveScope(
      tenantId,
      user,
      dto.branchId,
    );
    const aggregate = await this.loadAggregate(
      tenantId,
      from,
      to,
      scope.branchId,
      dto.staffId,
      dto.serviceId,
      now,
    );
    const envelope = this.advanced.envelope(
      from,
      to,
      scope.branchId,
      aggregate.settings.currency,
    );

    const dimension = dto.dimension;
    const rows = aggregate.byDimension[dimension];
    const labelSource =
      dimension === 'branch'
        ? aggregate.labels.branch
        : dimension === 'staff'
          ? aggregate.labels.staff
          : dimension === 'service'
            ? aggregate.labels.service
            : {};

    // Insights are recomputed from the same aggregate so a row's `flags`
    // reflect the SAME rule evaluation the summary page would show — never
    // a second, standalone computation.
    const cov = shapeJourneyCoverages(aggregate.overall);
    const kpis = shapeKpis(
      aggregate.overall,
      JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
      cov,
    );
    const reminders = shapeReminders(
      aggregate.overall,
      aggregate.reminderRows,
      {
        remindersEnabled: aggregate.settings.remindersEnabled,
        reminderLeadMinutes: aggregate.settings.reminderLeadMinutes,
      },
    );
    const labels = {
      branch: toLabelMap(aggregate.labels.branch),
      staff: toLabelMap(aggregate.labels.staff),
      service: toLabelMap(aggregate.labels.service),
    };
    const { insights } = generateInsights({
      overall: aggregate.overall,
      priorOverall: aggregate.priorOverall,
      kpis,
      queueCoverageRate: cov.queue.rate,
      remindersEnabled: aggregate.settings.remindersEnabled,
      reminders,
      dimensions: {
        branch: aggregate.byDimension.branch,
        staff: aggregate.byDimension.staff,
        service: aggregate.byDimension.service,
        hour: aggregate.byDimension.hour,
      },
      labels,
    });

    const shapedRows: JourneyBreakdownRow[] = rows.map((row) => {
      const label: JourneyLabelInfo | undefined = labelSource[row.dim_key];
      const shaped = shapeBreakdownRow(
        row,
        label ?? null,
        JOURNEY_THRESHOLDS.MIN_SAMPLE_BREAKDOWN_ROW,
      );
      shaped.flags = insights
        .filter(
          (i) => i.scope.dimension === dimension && i.scope.key === row.dim_key,
        )
        .map((i) => i.code);
      return shaped;
    });

    const filled = fillDimensionRows(dimension, shapedRows);
    const sorted = sortBreakdownRows(filled, dto.sort);

    const excluded =
      dimension === 'service'
        ? {
            multiOrNoServiceAppointments:
              aggregate.overall.multi_service + aggregate.overall.no_service,
          }
        : null;

    const offset = (dto.page - 1) * dto.limit;
    const page = sorted.slice(offset, offset + dto.limit);

    return {
      ...envelope,
      empty: aggregate.overall.booked === 0,
      dimension,
      sort: dto.sort,
      filters: {
        staffId: dto.staffId ?? null,
        serviceId: dto.serviceId ?? null,
      },
      timeBasis: TIME_BASIS,
      reference: {
        waitToStartP50: kpis.waitToStart.suppressed
          ? null
          : kpis.waitToStart.p50,
        readyDelayP50: kpis.readyDelay.suppressed ? null : kpis.readyDelay.p50,
        overrunP50: kpis.overrun.suppressed ? null : kpis.overrun.p50,
        noShowRate: shapeCounts(aggregate.overall).noShowRate,
      },
      excluded,
      data: page,
      total: sorted.length,
      page: dto.page,
      limit: dto.limit,
    };
  }

  // ───────────────────────────── Aggregate loading ─────────────────────── //

  private cacheKey(
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
    staffId: string | undefined,
    serviceId: string | undefined,
  ): string {
    return `journey:${from}:${to}:${branchId ?? 'ALL'}:${staffId ?? 'ALL'}:${serviceId ?? 'ALL'}`;
  }

  private async loadAggregate(
    tenantId: string,
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
    staffId: string | undefined,
    serviceId: string | undefined,
    now: Date,
  ): Promise<JourneyAggregate> {
    const key = this.cacheKey(from, to, branchId, staffId, serviceId);
    return this.cache.wrap(tenantId, CACHE_NS.DASHBOARD, key, () =>
      this.computeAggregate(
        tenantId,
        from,
        to,
        branchId,
        staffId,
        serviceId,
        now,
      ),
    );
  }

  private async computeAggregate(
    tenantId: string,
    from: ReportDate,
    to: ReportDate,
    branchId: string | undefined,
    staffId: string | undefined,
    serviceId: string | undefined,
    now: Date,
  ): Promise<JourneyAggregate> {
    const settingsRow = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    const currency = settingsRow?.currency ?? 'USD';
    const remindersEnabled = settingsRow?.reminders_enabled ?? false;
    const reminderLeadMinutes = settingsRow?.reminder_lead_minutes ?? [];

    const rangeDays = inclusiveDayCount(from, to);
    const wantPrior = rangeDays <= JOURNEY_THRESHOLDS.MAX_COMPARISON_RANGE_DAYS;

    const opts: JourneyQueryOptions = {
      tenantId,
      start: dayRangeUtc(from).start,
      end: dayRangeUtc(to).end,
      branchId,
      staffId,
      serviceId,
      now,
      zones: JOURNEY_KNOWN_TIMEZONES,
    };

    let priorOpts: JourneyQueryOptions | undefined;
    let priorRange: { from: string; to: string } | null = null;
    if (wantPrior) {
      const pp = priorPeriod(from, to);
      priorRange = { from: pp.priorFrom, to: pp.priorTo };
      priorOpts = {
        ...opts,
        start: dayRangeUtc(pp.priorFrom).start,
        end: dayRangeUtc(pp.priorTo).end,
      };
    }

    const [overall, priorOverall, ...dimensionAndReminderResults] =
      await Promise.all([
        this.journeyAgg.fetchOverall(opts),
        wantPrior
          ? this.journeyAgg.fetchOverall(priorOpts as JourneyQueryOptions)
          : Promise.resolve(null),
        ...JOURNEY_DIMENSIONS.map((d) =>
          this.journeyAgg.fetchDimension(opts, d),
        ),
        this.journeyAgg.fetchReminderRows(opts),
      ]);

    const dimensionRows = dimensionAndReminderResults.slice(
      0,
      JOURNEY_DIMENSIONS.length,
    ) as JourneyDimensionRow[][];
    const reminderRows = dimensionAndReminderResults[
      JOURNEY_DIMENSIONS.length
    ] as JourneyAggregate['reminderRows'];

    const byDimension = Object.fromEntries(
      JOURNEY_DIMENSIONS.map((d, i) => [d, dimensionRows[i]]),
    ) as Record<JourneyDimension, JourneyDimensionRow[]>;

    const branchIds = uniqueIds(byDimension.branch);
    const staffIds = uniqueIds(byDimension.staff);
    const serviceIds = uniqueIds(byDimension.service);

    const [branchLabels, staffLabels, serviceLabels] = await Promise.all([
      this.journeyAgg.fetchBranchLabels(tenantId, branchIds),
      this.journeyAgg.fetchStaffLabels(tenantId, staffIds),
      this.journeyAgg.fetchServiceLabels(tenantId, serviceIds),
    ]);

    return {
      overall,
      priorOverall,
      priorRange,
      byDimension,
      reminderRows,
      labels: {
        branch: branchLabels,
        staff: staffLabels,
        service: serviceLabels,
      },
      settings: { currency, remindersEnabled, reminderLeadMinutes },
      now: now.toISOString(),
    };
  }
}

const TIME_BASIS = {
  period: 'SCHEDULED_START_UTC_DAY',
  localBuckets: 'SCHEDULED_START_LOCAL_TIME',
  localTimezoneSource: 'BOOKED_ELSE_BRANCH_ELSE_UTC',
} as const;

function uniqueIds(rows: JourneyDimensionRow[]): string[] {
  return [...new Set(rows.map((r) => r.dim_key))];
}

function toLabelMap(
  labels: Record<string, JourneyLabelInfo>,
): Map<string, JourneyLabel> {
  return new Map(
    Object.entries(labels).map(([id, l]) => [
      id,
      { name: l.name, inactive: l.inactive },
    ]),
  );
}

/** Weekday (1-7) and hour (0-23) rows are zero-filled so every bucket exists; branch/staff/service only list rows with activity. */
function fillDimensionRows(
  dimension: JourneyDimension,
  rows: JourneyBreakdownRow[],
): JourneyBreakdownRow[] {
  if (dimension !== 'weekday' && dimension !== 'hour') return rows;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const keys = dimension === 'weekday' ? WEEKDAY_KEYS : HOUR_KEYS;
  return keys.map((k) => byKey.get(k) ?? emptyRow(k));
}

const WEEKDAY_KEYS = ['1', '2', '3', '4', '5', '6', '7'];
const HOUR_KEYS = Array.from({ length: 24 }, (_, h) => String(h));

function emptyRow(key: string): JourneyBreakdownRow {
  const empty = {
    n: 0,
    invalid: 0,
    p50: null,
    p90: null,
    suppressed: 'INSUFFICIENT_SAMPLE' as const,
  };
  return {
    key,
    label: null,
    appointments: 0,
    completed: 0,
    noShow: 0,
    noShowRate: null,
    queueCoverage: { numerator: 0, denominator: 0, rate: null },
    waitToStart: empty,
    readyDelay: empty,
    startDelay: empty,
    consultation: { ...empty, p75: null },
    overrun: empty,
    remindedShare: null,
    flags: [],
  };
}

function sortBreakdownRows(
  rows: JourneyBreakdownRow[],
  sort: string,
): JourneyBreakdownRow[] {
  const sorted = [...rows];
  const val = (r: JourneyBreakdownRow): number | null => {
    switch (sort) {
      case 'waitToStartP50':
        return r.waitToStart.p50;
      case 'readyDelayP50':
        return r.readyDelay.p50;
      case 'overrunP50':
        return r.overrun.p50;
      case 'noShowRate':
        return r.noShowRate;
      default:
        return r.appointments;
    }
  };
  sorted.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va;
  });
  return sorted;
}
