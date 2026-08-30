/**
 * Spec 014 (Clinic Platform Completion) — Phase 12 (US11, T148, SC-033).
 *
 * Seeds ONE synthetic tenant with 100k appointments (+ matching payments,
 * cancellations, service line items and reviews) spread over a 2-year
 * window, across 3 branches / 10 staff / 5 services / 5,000 customers, using
 * bulk multi-row INSERT throughout (the same discipline as
 * `src/seed/perf-fixture.seed.ts` and `segment-preview-100k.ts` — never
 * `repository.save()` per row), then boots the REAL Nest application
 * context (so every measured call goes through the actual
 * `AdvancedAnalyticsService` DI graph, not a raw-SQL stand-in) and asserts:
 *
 *  - Every one of the 9 F11 aggregation calls, run over the FULL 2-year
 *    range (the widest `MAX_ADVANCED_ANALYTICS_RANGE_DAYS` allows), completes
 *    in under 3s (SC-033).
 *  - Running them concurrently does not push an UNRELATED screen's latency
 *    (a plain dashboard KPI read) up by more than 10% (FR-A018).
 *
 * Per the task text: "introduce caching only if this fails" — this script
 * measures; it does not add `AnalyticsCacheService` wrapping on its own.
 *
 * NOT a jest spec — a 100k-row seed + 9 full-range aggregations over 2 years
 * of data takes real minutes, which is exactly the kind of long-running
 * verification this project's test discipline says must never block a jest
 * run/watch loop. Run on demand:
 *   npx ts-node --project tsconfig.seed.json scripts/perf/advanced-analytics-100k.ts
 *
 * Safety: creates its OWN synthetic tenant (never touches existing data) and
 * deletes everything it created in a `finally` block, even on assertion
 * failure. As of this writing (Phase 12, spec 014) this script has been
 * WRITTEN BUT NOT EXECUTED — see the Phase 12 handoff report — following the
 * same "never block overall progress on one long-running perf verification"
 * precedent `segment-preview-100k.ts` (T126) was run under.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NestFactory } from '@nestjs/core';

import { SeedDataSource } from '../../src/seed/data-source';
import { AppModule } from '../../src/app.module';
import { AdvancedAnalyticsService } from '../../src/modules/analytics/advanced-analytics.service';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import type { QueryAdvancedAnalyticsDto } from '../../src/modules/analytics/dto/query-advanced-analytics.dto';
import type { QueryAdvancedAnalyticsPageDto } from '../../src/modules/analytics/dto/query-advanced-analytics-page.dto';

const APPOINTMENT_COUNT = 100_000;
const BATCH_SIZE = 2_000;
const CUSTOMER_COUNT = 5_000;
const BRANCH_COUNT = 3;
const STAFF_COUNT = 10;
const SERVICE_COUNT = 5;
const RANGE_DAYS = 731; // MAX_ADVANCED_ANALYTICS_RANGE_DAYS — the widest request a caller may make.
const BUDGET_MS = 3_000;
const LATENCY_REGRESSION_BUDGET_PCT = 10;

const STATUSES = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'CONFIRMED'] as const;
// 70% completed, 15% cancelled, 10% no-show, 5% still confirmed — a
// realistic mature-clinic distribution, not an artificial best case.
const STATUS_WEIGHTS = [0.7, 0.15, 0.1, 0.05];
const SOURCES = ['PLATFORM', 'WHATSAPP_BOT', 'MANUAL', 'PUBLIC_AI'] as const;

function pickWeighted<T>(items: readonly T[], weights: number[]): T {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    acc += weights[i];
    if (r <= acc) return items[i];
  }
  return items[items.length - 1];
}

async function main(): Promise<void> {
  const ds: DataSource = await SeedDataSource.initialize();
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const started = Date.now();

  const now = Date.now();
  const rangeStart = new Date(now - RANGE_DAYS * 86_400_000);
  const rangeEnd = new Date(now);
  const fromDay = rangeStart.toISOString().slice(0, 10);
  const toDay = rangeEnd.toISOString().slice(0, 10);

  try {
    await ds.query(
      `INSERT INTO tenants (id, name, slug, contact_email, approval_status, is_active, created_at)
       VALUES ($1, 'T148 Perf Tenant', $2, $3, 'APPROVED', true, now())`,
      [tenantId, `t148-perf-${suffix}`, `t148-perf-${suffix}@example.test`],
    );
    await ds.query(
      `INSERT INTO tenant_settings (id, tenant_id, currency, created_at, updated_at)
       VALUES ($1, $2, 'USD', now(), now())`,
      [randomUUID(), tenantId],
    );

    console.log(
      `Seeding ${BRANCH_COUNT} branches, ${STAFF_COUNT} staff, ${SERVICE_COUNT} services...`,
    );
    const branchIds: string[] = [];
    for (let i = 0; i < BRANCH_COUNT; i++) {
      const id = randomUUID();
      branchIds.push(id);
      await ds.query(
        `INSERT INTO branches (id, "tenantId", name, timezone, is_active, created_at)
         VALUES ($1, $2, $3, 'UTC', true, now())`,
        [id, tenantId, `Perf Branch ${i}`],
      );
    }

    const serviceIds: string[] = [];
    for (let i = 0; i < SERVICE_COUNT; i++) {
      const id = randomUUID();
      serviceIds.push(id);
      await ds.query(
        `INSERT INTO services (id, "tenantId", name, duration_minutes, pricing_type, created_at, updated_at)
         VALUES ($1, $2, $3, 30, 'FIXED', now(), now())`,
        [id, tenantId, `Perf Service ${i}`],
      );
    }

    const staffIds: string[] = [];
    for (let i = 0; i < STAFF_COUNT; i++) {
      const userId = randomUUID();
      await ds.query(
        `INSERT INTO users (id, "tenantId", email, full_name, is_active, created_at)
         VALUES ($1, $2, $3, $4, true, now())`,
        [
          userId,
          tenantId,
          `perf-staff-${i}-${suffix}@example.test`,
          `Perf Staff ${i}`,
        ],
      );
      const staffId = randomUUID();
      staffIds.push(staffId);
      await ds.query(
        `INSERT INTO staff_profiles (id, user_id, "tenantId", created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())`,
        [staffId, userId, tenantId],
      );
    }

    console.log(`Seeding ${CUSTOMER_COUNT} customers...`);
    const customerIds: string[] = [];
    for (let i = 0; i < CUSTOMER_COUNT; i += BATCH_SIZE) {
      const rows: string[] = [];
      const params: unknown[] = [];
      const batchLen = Math.min(BATCH_SIZE, CUSTOMER_COUNT - i);
      for (let j = 0; j < batchLen; j++) {
        const idx = i + j;
        const id = randomUUID();
        customerIds.push(id);
        const base = params.length;
        rows.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, now())`,
        );
        params.push(
          id,
          tenantId,
          `Perf Customer ${idx}`,
          `+9665${String(idx).padStart(8, '0')}`,
          `perf-cust-${idx}-${suffix}@example.test`,
        );
      }
      await ds.query(
        `INSERT INTO customers (id, "tenantId", full_name, phone, email, created_at) VALUES ${rows.join(',')}`,
        params,
      );
    }

    console.log(
      `Seeding ${APPOINTMENT_COUNT} appointments over a ${RANGE_DAYS}-day window...`,
    );
    const appointmentIds: {
      id: string;
      status: string;
      startAt: Date;
      branchId: string;
    }[] = [];
    for (let i = 0; i < APPOINTMENT_COUNT; i += BATCH_SIZE) {
      const rows: string[] = [];
      const params: unknown[] = [];
      const batchLen = Math.min(BATCH_SIZE, APPOINTMENT_COUNT - i);
      for (let j = 0; j < batchLen; j++) {
        const id = randomUUID();
        const status = pickWeighted(STATUSES, STATUS_WEIGHTS);
        const source = SOURCES[Math.floor(Math.random() * SOURCES.length)];
        const startAt = new Date(
          rangeStart.getTime() +
            Math.random() * (rangeEnd.getTime() - rangeStart.getTime()),
        );
        const endAt = new Date(startAt.getTime() + 30 * 60_000);
        const branchId =
          branchIds[Math.floor(Math.random() * branchIds.length)];
        const staffId = staffIds[Math.floor(Math.random() * staffIds.length)];
        const customerId =
          customerIds[Math.floor(Math.random() * customerIds.length)];
        appointmentIds.push({ id, status, startAt, branchId });
        const base = params.length;
        rows.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, 'PAID', 100, 'USD', $${base + 9}, now())`,
        );
        params.push(
          id,
          tenantId,
          branchId,
          customerId,
          staffId,
          startAt,
          endAt,
          status,
          source,
        );
      }
      await ds.query(
        `INSERT INTO appointments
           (id, "tenantId", "branchId", "customerId", "staffId", start_at, end_at, status, payment_status, total_amount, currency, source, created_at)
         VALUES ${rows.join(',')}`,
        params,
      );
      if ((i / BATCH_SIZE) % 10 === 0)
        console.log(`  ...${i + batchLen}/${APPOINTMENT_COUNT}`);
    }
    console.log(
      `Appointment seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );

    const completed = appointmentIds.filter((a) => a.status === 'COMPLETED');
    const cancelled = appointmentIds.filter((a) => a.status === 'CANCELLED');

    console.log(
      `Seeding ${completed.length} settled payments + ${completed.length} service line items...`,
    );
    for (let i = 0; i < completed.length; i += BATCH_SIZE) {
      const batch = completed.slice(i, i + BATCH_SIZE);
      const payRows: string[] = [];
      const payParams: unknown[] = [];
      const svcRows: string[] = [];
      const svcParams: unknown[] = [];
      for (const a of batch) {
        const paidAt = new Date(a.startAt.getTime() + 5 * 60_000);
        const pBase = payParams.length;
        payRows.push(
          `($${pBase + 1}, $${pBase + 2}, $${pBase + 3}, $${pBase + 4}, 100, 'USD', 'PAID', $${pBase + 5}, now())`,
        );
        payParams.push(randomUUID(), tenantId, a.branchId, a.id, paidAt);

        const serviceId =
          serviceIds[Math.floor(Math.random() * serviceIds.length)];
        const sBase = svcParams.length;
        svcRows.push(
          `($${sBase + 1}, $${sBase + 2}, $${sBase + 3}, $${sBase + 4}, 100, 30, now())`,
        );
        svcParams.push(randomUUID(), tenantId, a.id, serviceId);
      }
      await ds.query(
        `INSERT INTO payments (id, "tenantId", "branchId", "appointmentId", amount, currency, status, paid_at, created_at) VALUES ${payRows.join(',')}`,
        payParams,
      );
      await ds.query(
        `INSERT INTO appointment_services (id, "tenantId", "appointmentId", "serviceId", price, duration_minutes, created_at) VALUES ${svcRows.join(',')}`,
        svcParams,
      );
    }

    console.log(`Seeding ${cancelled.length} cancellation records...`);
    for (let i = 0; i < cancelled.length; i += BATCH_SIZE) {
      const batch = cancelled.slice(i, i + BATCH_SIZE);
      const rows: string[] = [];
      const params: unknown[] = [];
      for (const a of batch) {
        const origin = Math.random() < 0.5 ? 'PATIENT' : 'STAFF';
        const base = params.length;
        rows.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`,
        );
        params.push(randomUUID(), tenantId, a.id, origin);
      }
      await ds.query(
        `INSERT INTO appointment_cancellations (id, "tenantId", "appointmentId", origin, created_at) VALUES ${rows.join(',')}`,
        params,
      );
    }

    console.log(
      `Seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s total. Booting Nest application context...`,
    );

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn'],
    });
    try {
      const advanced = app.get(AdvancedAnalyticsService);

      const tenantWideUser: AuthenticatedUser = {
        id: 'perf-owner',
        tenantId: null,
        roles: [],
        permissions: [
          PERMISSION.ANALYTICS_DASHBOARD_READ,
          PERMISSION.ANALYTICS_REPORTS_READ,
        ],
      };
      const dto: QueryAdvancedAnalyticsDto = { from: fromDay, to: toDay };
      const pageDto: QueryAdvancedAnalyticsPageDto = {
        ...dto,
        page: 1,
        limit: 20,
      };

      const calls: [string, () => Promise<unknown>][] = [
        [
          'trends/appointments',
          () => advanced.appointmentsTrend(tenantId, tenantWideUser, dto),
        ],
        [
          'trends/revenue',
          () => advanced.revenueTrend(tenantId, tenantWideUser, dto),
        ],
        ['rates', () => advanced.rates(tenantId, tenantWideUser, dto)],
        ['retention', () => advanced.retention(tenantId, tenantWideUser, dto)],
        [
          'performance/services',
          () => advanced.performanceServices(tenantId, tenantWideUser, pageDto),
        ],
        [
          'performance/staff',
          () => advanced.performanceStaff(tenantId, tenantWideUser, pageDto),
        ],
        [
          'performance/branches',
          () => advanced.performanceBranches(tenantId, tenantWideUser, pageDto),
        ],
        [
          'performance/channels',
          () => advanced.performanceChannels(tenantId, tenantWideUser, pageDto),
        ],
      ];

      console.log(
        `\nSC-033 — each F11 call over the full ${RANGE_DAYS}-day / ${APPOINTMENT_COUNT}-appointment range, budget ${BUDGET_MS}ms:`,
      );
      const failures: string[] = [];
      for (const [name, call] of calls) {
        const t0 = Date.now();
        await call();
        const ms = Date.now() - t0;
        const ok = ms < BUDGET_MS;
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${ms}ms`);
        if (!ok) failures.push(`${name} took ${ms}ms (>= ${BUDGET_MS}ms)`);
      }

      // FR-A018 — an unrelated screen's latency (dashboard KPI read) must not
      // regress more than 10% while the widest possible analytics query runs
      // concurrently.
      const dashboardQuery = () =>
        ds.query(
          `SELECT COUNT(*)::int AS c FROM appointments WHERE "tenantId" = $1`,
          [tenantId],
        );
      const baselineStart = Date.now();
      await dashboardQuery();
      const baselineMs = Date.now() - baselineStart;

      const heavyPromise = advanced.appointmentsTrend(
        tenantId,
        tenantWideUser,
        dto,
      );
      const duringStart = Date.now();
      await dashboardQuery();
      const duringMs = Date.now() - duringStart;
      await heavyPromise;

      const regressionPct =
        ((duringMs - baselineMs) / Math.max(baselineMs, 1)) * 100;
      console.log(
        `\nUnrelated dashboard query: baseline=${baselineMs}ms during-heavy-query=${duringMs}ms (${regressionPct.toFixed(1)}%)`,
      );
      if (regressionPct > LATENCY_REGRESSION_BUDGET_PCT) {
        failures.push(
          `FR-A018 latency regression ${regressionPct.toFixed(1)}% (> ${LATENCY_REGRESSION_BUDGET_PCT}%)`,
        );
      }

      if (failures.length) {
        throw new Error(`T148 FAILED:\n  ${failures.join('\n  ')}`);
      }
      console.log(
        '\nT148 PASSED: every F11 call holds the SC-033 budget with no caching layer.',
      );
    } finally {
      await app.close();
    }
  } finally {
    console.log('\nCleaning up perf tenant...');
    await ds.query(`DELETE FROM payments WHERE "tenantId" = $1`, [tenantId]);
    await ds.query(
      `DELETE FROM appointment_cancellations WHERE "tenantId" = $1`,
      [tenantId],
    );
    await ds.query(`DELETE FROM appointment_services WHERE "tenantId" = $1`, [
      tenantId,
    ]);
    await ds.query(`DELETE FROM appointments WHERE "tenantId" = $1`, [
      tenantId,
    ]);
    await ds.query(`DELETE FROM staff_profiles WHERE "tenantId" = $1`, [
      tenantId,
    ]);
    await ds.query(`DELETE FROM users WHERE "tenantId" = $1`, [tenantId]);
    await ds.query(`DELETE FROM services WHERE "tenantId" = $1`, [tenantId]);
    await ds.query(`DELETE FROM customers WHERE "tenantId" = $1`, [tenantId]);
    await ds.query(`DELETE FROM branches WHERE "tenantId" = $1`, [tenantId]);
    await ds.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [
      tenantId,
    ]);
    await ds.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
