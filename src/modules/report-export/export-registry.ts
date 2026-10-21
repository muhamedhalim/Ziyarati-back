import { DailyReport } from '../../entities/Analytics/DailyReport';
import { MonthlyReport } from '../../entities/Analytics/MonthlyReport';

import {
  AnalyticsAggregationService,
  BranchPerformanceRow,
  ChannelPerformanceRow,
  ServicePerformanceRow,
  StaffPerformanceRow,
} from '../analytics/analytics-aggregation.service';
import { DailyReportService } from '../analytics/daily-report.service';
import { MonthlyReportService } from '../analytics/monthly-report.service';
import { StaffPerformanceService } from '../analytics/staff-performance.service';
import { QueryDailyReportsDto } from '../analytics/dto/query-daily-reports.dto';
import { QueryMonthlyReportsDto } from '../analytics/dto/query-monthly-reports.dto';
import { QueryStaffPerformanceDto } from '../analytics/dto/query-staff-performance.dto';
import { QueryAdvancedAnalyticsPageDto } from '../analytics/dto/query-advanced-analytics-page.dto';
import {
  DEFAULT_REPORTING_TIMEZONE,
  dayRangeInZone,
} from '../analytics/analytics.constants';

/**
 * Spec 014 (Clinic Platform Completion) — T180 (US13, FR-X002, FR-X003).
 *
 * The CLOSED list of exportable reports. `report` on `POST /reports/export`
 * is a KEY into this map — never a caller-supplied query or table name
 * (mirrors `SegmentField`'s closed-vocabulary discipline in
 * `crm/segment.constants.ts`). Each entry's `query` is the LITERAL,
 * unbound prototype method of the EXISTING analytics service that already
 * powers the on-screen report — never a reimplementation. `ReportExportService`
 * (T181) invokes it with `Function.prototype.call` against its own injected
 * instance; `export-registry.spec.ts` asserts identity (`toBe`, not
 * structural equality) against the same class import, so a future
 * refactor that swaps in a "close enough" recomputation would fail the
 * build, not just silently drift.
 *
 * `formats` follows FR-X003: spreadsheet (`XLSX`) for every entry;
 * `PDF` is reserved for a report whose value is in being READ, not
 * analysed (the spec's own example: an invoice). None of the reports
 * registered here are read-shaped — all six are tabular breakdowns meant
 * for further analysis — so every entry is `['XLSX']` today. A future
 * "read" report adds `'PDF'` to its own `formats` array; nothing about the
 * registry's shape needs to change to allow it.
 *
 * `argsDto` is the EXISTING DTO class each source service's own HTTP
 * controller already validates its filters with (`QueryDailyReportsDto`,
 * `QueryAdvancedAnalyticsPageDto`, ...) — reused here too, so "what filters
 * this report accepts" is defined in exactly one place.
 */
export type ExportFormat = 'XLSX' | 'PDF';

export interface ExportColumn {
  key: string;
  header: string;
}

export type ReportKey =
  | 'daily-report'
  | 'monthly-report'
  | 'staff-performance'
  | 'service-performance'
  | 'branch-performance'
  | 'channel-performance';

/** A row exactly as the source query returns it — the serializer below flattens it for export. */
export type SourceRow =
  | DailyReport
  | MonthlyReport
  | StaffPerformanceRow
  | ServicePerformanceRow
  | BranchPerformanceRow
  | ChannelPerformanceRow;

export interface ExportRunContext {
  tenantId: string;
  /** Frozen at request time (T181) — never re-derived from a live caller. */
  branchScope: { branchId?: string } | null;
  /** The requester's own filters, validated against `argsDto`, frozen at request time. */
  filters: Record<string, unknown>;
  /**
   * The clinic's reporting currency and timezone, resolved when the export
   * runs — the same values the on-screen tables use, so an export of a
   * revenue table sums the same money over the same calendar days.
   */
  currency?: string;
  timezone?: string;
}

/** `[from 00:00, to 23:59:59.999]` in the run's reporting timezone. */
function exportRange(ctx: ExportRunContext): [Date, Date] {
  const tz = ctx.timezone ?? DEFAULT_REPORTING_TIMEZONE;
  return [
    dayRangeInZone(String(ctx.filters.from), tz).start,
    dayRangeInZone(String(ctx.filters.to), tz).end,
  ];
}

export interface ExportRegistryEntry<TRow extends SourceRow = SourceRow> {
  key: ReportKey;
  label: string;
  formats: readonly ExportFormat[];
  columns: readonly ExportColumn[];
  /** The DTO class this report's EXISTING controller already validates its query with. */
  argsDto: new () => Record<string, unknown>;
  /**
   * The literal, unbound prototype method of the existing analytics service
   * this report reuses. Invoked via `.call(instance, ...)` — see
   * `ReportExportService.buildSources`. NEVER wrapped in a function that
   * recomputes anything; this is the exact function the on-screen report
   * already calls.
   */

  query: (...args: any[]) => Promise<TRow[] | { data: TRow[] }>;
  /** Maps the frozen request context onto the query's own positional args — plumbing only, no calculation. */
  toArgs: (ctx: ExportRunContext) => unknown[];
  /** Flattens one source row into the export's column shape — plumbing only, no calculation. */
  serializeRow: (row: TRow) => Record<string, unknown>;
  /**
   * True for a query that ALREADY exposes real page/limit pagination
   * (`DailyReportService.list`/`MonthlyReportService.list`, both `Page<T>`)
   * — `ReportExportService` pages it by literally re-invoking the same
   * function with an incrementing `page` (the pagination the on-screen
   * report already uses, never a bespoke reimplementation).
   *
   * False for the bounded-cardinality aggregation queries (per staff/
   * service/branch/channel — never per underlying event), which have no
   * pagination of their own because their result size is bounded by
   * catalogue cardinality, not by the volume of underlying events; these
   * are fetched once and treated as a single page.
   */
  paginated: boolean;
}

function unwrapRows<T>(result: T[] | { data: T[] }): T[] {
  return Array.isArray(result) ? result : result.data;
}

/** Every registry entry funnels its rows through this before writing — never duplicated per entry. */
export function extractRows<T>(result: T[] | { data: T[] }): T[] {
  return unwrapRows(result);
}

export const EXPORT_REGISTRY: Readonly<Record<ReportKey, ExportRegistryEntry>> =
  {
    'daily-report': {
      key: 'daily-report',
      label: 'Daily Report',
      formats: ['XLSX'],
      columns: [
        { key: 'date', header: 'Date' },
        { key: 'branch', header: 'Branch' },
        { key: 'total_appointments', header: 'Total Appointments' },
        { key: 'completed_appointments', header: 'Completed' },
        { key: 'cancelled_appointments', header: 'Cancelled' },
        { key: 'no_show_appointments', header: 'No-shows' },
        { key: 'total_revenue', header: 'Revenue' },
        { key: 'new_customers', header: 'New Customers' },
        { key: 'ai_messages_count', header: 'AI Messages' },
      ],
      argsDto: QueryDailyReportsDto,
      paginated: true,
      query: DailyReportService.prototype.list,
      toArgs: (ctx) => [
        ctx.tenantId,
        {
          branchId: ctx.branchScope?.branchId ?? ctx.filters.branchId,
          from: ctx.filters.from,
          to: ctx.filters.to,
          page: ctx.filters.page ?? 1,
          limit: ctx.filters.limit ?? 100,
        },
      ],
      serializeRow: (row) => {
        const r = row as DailyReport;
        return {
          date: r.date,
          branch: r.branch?.name ?? '',
          total_appointments: r.total_appointments,
          completed_appointments: r.completed_appointments,
          cancelled_appointments: r.cancelled_appointments,
          no_show_appointments: r.no_show_appointments,
          total_revenue: r.total_revenue,
          new_customers: r.new_customers,
          ai_messages_count: r.ai_messages_count,
        };
      },
    } as unknown as ExportRegistryEntry,

    'monthly-report': {
      key: 'monthly-report',
      label: 'Monthly Report',
      formats: ['XLSX'],
      columns: [
        { key: 'period_month', header: 'Month' },
        { key: 'branch', header: 'Branch' },
        { key: 'total_appointments', header: 'Total Appointments' },
        { key: 'total_revenue', header: 'Revenue' },
        { key: 'avg_rating', header: 'Avg Rating' },
      ],
      argsDto: QueryMonthlyReportsDto,
      paginated: true,
      query: MonthlyReportService.prototype.list,
      toArgs: (ctx) => [
        ctx.tenantId,
        {
          branchId: ctx.branchScope?.branchId ?? ctx.filters.branchId,
          month: ctx.filters.month,
          page: ctx.filters.page ?? 1,
          limit: ctx.filters.limit ?? 100,
        },
      ],
      serializeRow: (row) => {
        const r = row as MonthlyReport;
        return {
          period_month: r.period_month,
          branch: r.branch?.name ?? '',
          total_appointments: r.total_appointments,
          total_revenue: r.total_revenue,
          avg_rating: r.avg_rating ?? '',
        };
      },
    } as unknown as ExportRegistryEntry,

    'staff-performance': {
      key: 'staff-performance',
      label: 'Staff Performance',
      formats: ['XLSX'],
      columns: [
        { key: 'name', header: 'Staff' },
        { key: 'total_appointments', header: 'Total Appointments' },
        { key: 'completed_appointments', header: 'Completed' },
        { key: 'cancelled_appointments', header: 'Cancelled' },
        { key: 'no_show_appointments', header: 'No-shows' },
        { key: 'revenue', header: 'Revenue' },
        { key: 'avg_rating', header: 'Avg Rating' },
      ],
      argsDto: QueryStaffPerformanceDto,
      paginated: false,
      query: StaffPerformanceService.prototype.list,
      toArgs: (ctx) => [
        ctx.tenantId,
        {
          branchId: ctx.branchScope?.branchId ?? ctx.filters.branchId,
          from: ctx.filters.from,
          to: ctx.filters.to,
        },
      ],
      serializeRow: (row) => {
        const r = row as StaffPerformanceRow;
        return {
          name: r.name,
          total_appointments: r.total_appointments,
          completed_appointments: r.completed_appointments,
          cancelled_appointments: r.cancelled_appointments,
          no_show_appointments: r.no_show_appointments,
          revenue: r.revenue,
          avg_rating: r.avg_rating ?? '',
        };
      },
    } as unknown as ExportRegistryEntry,

    'service-performance': {
      key: 'service-performance',
      label: 'Service Performance',
      formats: ['XLSX'],
      columns: [
        { key: 'name', header: 'Service' },
        { key: 'appointments', header: 'Appointments' },
        { key: 'revenue', header: 'Revenue' },
      ],
      argsDto: QueryAdvancedAnalyticsPageDto,
      paginated: false,
      query: AnalyticsAggregationService.prototype.servicePerformance,
      toArgs: (ctx) => [
        ctx.tenantId,
        ctx.branchScope?.branchId ?? ctx.filters.branchId,
        ...exportRange(ctx),
      ],
      serializeRow: (row) => {
        const r = row as ServicePerformanceRow;
        return {
          name: r.name,
          appointments: r.appointments,
          revenue: r.revenue,
        };
      },
    } as unknown as ExportRegistryEntry,

    'branch-performance': {
      key: 'branch-performance',
      label: 'Branch Performance',
      formats: ['XLSX'],
      columns: [
        { key: 'name', header: 'Branch' },
        { key: 'appointments', header: 'Appointments' },
        { key: 'revenue', header: 'Revenue' },
      ],
      argsDto: QueryAdvancedAnalyticsPageDto,
      paginated: false,
      query: AnalyticsAggregationService.prototype.branchPerformance,
      toArgs: (ctx) => {
        const branchId = ctx.branchScope?.branchId ?? ctx.filters.branchId;
        return [
          ctx.tenantId,
          branchId ? [branchId as string] : undefined,
          ctx.currency,
          ...exportRange(ctx),
        ];
      },
      serializeRow: (row) => {
        const r = row as BranchPerformanceRow;
        return {
          name: r.name,
          appointments: r.appointments,
          revenue: r.revenue,
        };
      },
    } as unknown as ExportRegistryEntry,

    'channel-performance': {
      key: 'channel-performance',
      label: 'Channel Performance',
      formats: ['XLSX'],
      columns: [
        { key: 'source', header: 'Source' },
        { key: 'appointments', header: 'Appointments' },
        { key: 'completed', header: 'Completed' },
        { key: 'revenue', header: 'Revenue' },
      ],
      argsDto: QueryAdvancedAnalyticsPageDto,
      paginated: false,
      query: AnalyticsAggregationService.prototype.channelPerformance,
      toArgs: (ctx) => [
        ctx.tenantId,
        ctx.branchScope?.branchId ?? ctx.filters.branchId,
        ctx.currency,
        ...exportRange(ctx),
      ],
      serializeRow: (row) => {
        const r = row as ChannelPerformanceRow;
        return {
          source: r.source,
          appointments: r.appointments,
          completed: r.completed,
          revenue: r.revenue,
        };
      },
    } as unknown as ExportRegistryEntry,
  };

export const EXPORT_REGISTRY_KEYS: readonly ReportKey[] = Object.keys(
  EXPORT_REGISTRY,
) as ReportKey[];

/** `report` on the request body is validated against this before anything else runs. */
export function isExportableReportKey(key: string): key is ReportKey {
  return Object.prototype.hasOwnProperty.call(EXPORT_REGISTRY, key);
}

export function getExportRegistryEntry(key: ReportKey): ExportRegistryEntry {
  return EXPORT_REGISTRY[key];
}
