import { AnalyticsAggregationService } from '../analytics/analytics-aggregation.service';
import { DailyReportService } from '../analytics/daily-report.service';
import { MonthlyReportService } from '../analytics/monthly-report.service';
import { StaffPerformanceService } from '../analytics/staff-performance.service';
import {
  EXPORT_REGISTRY,
  EXPORT_REGISTRY_KEYS,
  getExportRegistryEntry,
  isExportableReportKey,
} from './export-registry';

/**
 * T180 (spec 014, US13). The registry is a CLOSED list: every entry must
 * name a REAL, EXISTING query — proven here by identity (`toBe`), not just
 * "the numbers happen to match" — and an unknown key must be rejected
 * rather than silently accepted.
 */
describe('export-registry (T180)', () => {
  it('every entry reuses the literal existing service method, never a reimplementation', () => {
    expect(EXPORT_REGISTRY['daily-report'].query).toBe(
      DailyReportService.prototype.list,
    );
    expect(EXPORT_REGISTRY['monthly-report'].query).toBe(
      MonthlyReportService.prototype.list,
    );
    expect(EXPORT_REGISTRY['staff-performance'].query).toBe(
      StaffPerformanceService.prototype.list,
    );
    expect(EXPORT_REGISTRY['service-performance'].query).toBe(
      AnalyticsAggregationService.prototype.servicePerformance,
    );
    expect(EXPORT_REGISTRY['branch-performance'].query).toBe(
      AnalyticsAggregationService.prototype.branchPerformance,
    );
    expect(EXPORT_REGISTRY['channel-performance'].query).toBe(
      AnalyticsAggregationService.prototype.channelPerformance,
    );
  });

  it('every entry declares at least one format and a non-empty column set', () => {
    for (const key of EXPORT_REGISTRY_KEYS) {
      const entry = EXPORT_REGISTRY[key];
      expect(entry.formats.length).toBeGreaterThan(0);
      expect(entry.columns.length).toBeGreaterThan(0);
      expect(typeof entry.query).toBe('function');
      expect(typeof entry.toArgs).toBe('function');
      expect(typeof entry.serializeRow).toBe('function');
    }
  });

  it("PDF is offered only where FR-X003 explicitly records it (none of today's analytical reports)", () => {
    for (const key of EXPORT_REGISTRY_KEYS) {
      const entry = EXPORT_REGISTRY[key];
      if (entry.formats.includes('PDF')) {
        // A future "read" report would document its own reasoning here; today
        // every registered report is a tabular breakdown, XLSX-only.
        throw new Error(
          `${key} declares PDF but no read-shaped report is registered yet`,
        );
      }
      expect(entry.formats).toContain('XLSX');
    }
  });

  it('unknown keys are rejected, never silently accepted', () => {
    expect(isExportableReportKey('drop table customers')).toBe(false);
    expect(isExportableReportKey('customers')).toBe(false);
    expect(isExportableReportKey('daily-report')).toBe(true);
  });

  it('getExportRegistryEntry returns the same object identity as the map', () => {
    expect(getExportRegistryEntry('staff-performance')).toBe(
      EXPORT_REGISTRY['staff-performance'],
    );
  });
});
