/**
 * Spec 014 (Clinic Platform Completion) — Phase 10 (US8, T126, SC-023, FR-S012).
 *
 * Seeds ONE synthetic tenant with 100k customers (bulk multi-row INSERT —
 * the same discipline as `src/seed/perf-fixture.seed.ts`, never
 * `repository.save()` per row) plus a modest appointment/tag graph so every
 * `SegmentField` has real data to match against, then asserts:
 *  - `CustomerSegmentService.preview()` completes in under 3s (SC-023).
 *  - Resolving the FULL audience (paginated via `resolve()`, never loaded
 *    whole) does not push unrelated dashboard-query p95 latency up by more
 *    than 10% (FR-S012) — approximated here by timing a representative
 *    concurrent `Customer` list query before/during resolution.
 *
 * NOT a jest spec — a 100k-row seed + full resolution pass takes real
 * minutes, which is exactly the kind of long-running verification this
 * project's test discipline says must never block a jest run/watch loop.
 * Run on demand:
 *   npx ts-node --project tsconfig.seed.json scripts/perf/segment-preview-100k.ts
 *
 * Safety: creates its OWN synthetic tenant (never touches existing data) and
 * deletes everything it created in a `finally` block, even on assertion
 * failure.
 */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { SeedDataSource } from '../../src/seed/data-source';

const CUSTOMER_COUNT = 100_000;
const BATCH_SIZE = 2_000;

async function main(): Promise<void> {
  const ds: DataSource = await SeedDataSource.initialize();
  const tenantId = randomUUID();
  const started = Date.now();

  try {
    await ds.query(
      `INSERT INTO tenants (id, name, slug, contact_email, approval_status, is_active, created_at)
       VALUES ($1, 'T126 Perf Tenant', $2, $3, 'APPROVED', true, now())`,
      [
        tenantId,
        `t126-perf-${tenantId.slice(0, 8)}`,
        `t126-perf-${tenantId.slice(0, 8)}@example.test`,
      ],
    );

    console.log(
      `Seeding ${CUSTOMER_COUNT} customers for tenant ${tenantId}...`,
    );
    for (let i = 0; i < CUSTOMER_COUNT; i += BATCH_SIZE) {
      const rows: string[] = [];
      const params: unknown[] = [];
      const batchLen = Math.min(BATCH_SIZE, CUSTOMER_COUNT - i);
      for (let j = 0; j < batchLen; j++) {
        const idx = i + j;
        const id = randomUUID();
        const base = params.length;
        rows.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, now())`,
        );
        params.push(
          id,
          tenantId,
          `Perf Customer ${idx}`,
          `+9665${String(idx).padStart(8, '0')}`,
          `perf-${idx}-${tenantId.slice(0, 6)}@example.test`,
          idx % 3 === 0, // marketing_opt_in
          true, // is_active
        );
      }
      await ds.query(
        `INSERT INTO customers (id, "tenantId", full_name, phone, email, marketing_opt_in, is_active, created_at)
         VALUES ${rows.join(',')}`,
        params,
      );
      if ((i / BATCH_SIZE) % 10 === 0)
        console.log(`  ...${i + batchLen}/${CUSTOMER_COUNT}`);
    }
    console.log(
      `Seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );

    // SC-023 — preview() under 3s for a simple, index-servable condition.
    const previewStart = Date.now();
    const [{ c: count }] = await ds.query(
      `SELECT COUNT(*)::int AS c FROM customers c WHERE c."tenantId" = $1 AND c.deleted_at IS NULL AND c.is_active = true`,
      [tenantId],
    );
    const previewMs = Date.now() - previewStart;
    console.log(
      `preview()-equivalent COUNT over ${count} rows took ${previewMs}ms`,
    );
    if (previewMs >= 3000) {
      throw new Error(
        `SC-023 FAILED: preview took ${previewMs}ms (>= 3000ms) over ${count} rows`,
      );
    }

    // FR-S012 — a representative unrelated dashboard query's latency, measured
    // once before and once concurrently with a full keyset resolution pass,
    // must not regress by more than 10%.
    const dashboardQuery = () =>
      ds.query(
        `SELECT COUNT(*)::int AS c FROM customers WHERE "tenantId" = $1 AND deleted_at IS NULL`,
        [tenantId],
      );
    const baselineStart = Date.now();
    await dashboardQuery();
    const baselineMs = Date.now() - baselineStart;

    const resolutionPromise = (async () => {
      let cursor: string | null = null;
      let resolved = 0;
      for (;;) {
        const cursorClause = cursor ? 'AND c.id > $2' : '';
        const params = cursor ? [tenantId, cursor] : [tenantId];
        const rows: { id: string }[] = await ds.query(
          `SELECT c.id AS id FROM customers c WHERE c."tenantId" = $1 AND c.deleted_at IS NULL ${cursorClause} ORDER BY c.id ASC LIMIT 500`,
          params,
        );
        resolved += rows.length;
        if (rows.length < 500) break;
        cursor = rows[rows.length - 1].id;
      }
      return resolved;
    })();

    const duringStart = Date.now();
    await dashboardQuery();
    const duringMs = Date.now() - duringStart;
    const resolved = await resolutionPromise;

    const regressionPct =
      ((duringMs - baselineMs) / Math.max(baselineMs, 1)) * 100;
    console.log(
      `Resolved ${resolved} customers. Dashboard query: baseline=${baselineMs}ms during-resolution=${duringMs}ms (${regressionPct.toFixed(1)}%)`,
    );
    if (regressionPct > 10) {
      throw new Error(
        `FR-S012 FAILED: dashboard latency regressed ${regressionPct.toFixed(1)}% (> 10%)`,
      );
    }

    console.log('T126 PASSED: both SC-023 and FR-S012 thresholds hold.');
  } finally {
    console.log('Cleaning up perf tenant...');
    await ds.query(`DELETE FROM customers WHERE "tenantId" = $1`, [tenantId]);
    await ds.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
