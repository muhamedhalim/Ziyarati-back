/**
 * OPERATIONAL script — analytics accuracy audit (2026-10-21). Recomputes the
 * STORED daily (`daily_reports`) and monthly (`monthly_reports`) analytics
 * reports for a date range, so rows generated before the audit's fixes pick
 * up the corrected rules:
 *   - revenue = net collected (PAID/PARTIALLY_REFUNDED, amount − refunded),
 *     in the reporting currency, attributed to the payment's appointment
 *     branch when the payment has none;
 *   - report days/months are the clinic's own calendar days (its reporting
 *     timezone), not UTC days.
 *
 * Goes through the real `DailyReportService.generate` /
 * `MonthlyReportService.generate` — the same idempotent
 * `INSERT … ON CONFLICT DO UPDATE` the scheduled jobs use — inside a tenant
 * context, exactly like the worker. It only (re)writes report rows; it never
 * deletes anything and never touches payments, appointments or any other
 * source record. Re-running it is safe.
 *
 * Run (against the environment in .env — check DB_HOST/DB_NAME first):
 *   npm run analytics:rebuild-reports -- \
 *     --from 2026-08-01 --to 2026-10-20 [--tenant <uuid>] [--dry-run]
 *
 * Without --tenant, every active clinic is rebuilt. Range is capped at 400
 * days per run. Days/months still in progress are skipped — the scheduled
 * jobs own them.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { TenantContextService } from '../src/core/tenant-context/tenant-context.service';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import { DailyReportService } from '../src/modules/analytics/daily-report.service';
import { MonthlyReportService } from '../src/modules/analytics/monthly-report.service';
import {
  currentMonthInZone,
  enumerateDays,
  inclusiveDayCount,
  todayInZone,
} from '../src/modules/analytics/analytics.constants';

const MAX_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  const onlyTenant = arg('tenant');
  const dryRun = process.argv.includes('--dry-run');
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw new Error(
      'Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--tenant <uuid>] [--dry-run]',
    );
  }
  if (inclusiveDayCount(from, to) > MAX_DAYS) {
    throw new Error(`Range too wide (max ${MAX_DAYS} days per run)`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const ds = app.get(DataSource);
    const ctx = app.get(TenantContextService);
    const aggregation = app.get(AnalyticsAggregationService);
    const daily = app.get(DailyReportService);
    const monthly = app.get(MonthlyReportService);

    const tenantIds: string[] = onlyTenant
      ? [onlyTenant]
      : (
          await ds.query(
            `SELECT id FROM tenants WHERE is_active = true AND deleted_at IS NULL ORDER BY id`,
          )
        ).map((r: { id: string }) => r.id);

    let days = 0;
    let months = 0;
    let failures = 0;
    for (const tenantId of tenantIds) {
      const tz = await aggregation.resolveReportingTimezone(tenantId);
      const today = todayInZone(tz);
      const thisMonth = currentMonthInZone(tz);
      // Closed days/months only — in-progress ones belong to the schedulers.
      const tenantDays = enumerateDays(from, to).filter((d) => d < today);
      const tenantMonths = [
        ...new Set(tenantDays.map((d) => d.slice(0, 7))),
      ].filter((m) => m < thisMonth);
      console.log(
        `${tenantId} (${tz}): ${tenantDays.length} day(s), ${tenantMonths.length} month(s)${dryRun ? ' [dry run]' : ''}`,
      );
      if (dryRun) continue;

      await ctx.run(async () => {
        ctx.setPrincipal({
          id: 'system',
          tenantId,
          email: null,
          roles: [],
          permissions: [],
        });
        for (const date of tenantDays) {
          try {
            await daily.generate(tenantId, { date });
            days++;
          } catch (err) {
            // A clinic with no active branch has nothing to report — not a failure.
            failures++;
            console.warn(`  daily ${date}: ${(err as Error).message}`);
          }
        }
        for (const month of tenantMonths) {
          try {
            await monthly.generate(tenantId, { month });
            months++;
          } catch (err) {
            failures++;
            console.warn(`  monthly ${month}: ${(err as Error).message}`);
          }
        }
      });
    }
    console.log(
      `\nDone: ${tenantIds.length} clinic(s), ${days} day run(s), ${months} month run(s), ${failures} skipped/failed.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Rebuild failed:', err);
  process.exitCode = 1;
});
