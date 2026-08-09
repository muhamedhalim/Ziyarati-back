/**
 * T046 — MP-backend-01: p50/p95/p99 per endpoint template + method from the
 * api_logs ledger, and the audit query's own cost (api_logs is indexed
 * (tenant, created_at) only — this platform-wide GROUP BY is an unindexed
 * scan; its cost is measured and reported, not hidden).
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/perf/endpoint-percentiles.ts
 */
import { DataSource } from 'typeorm';
import { performance } from 'node:perf_hooks';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set (isolated LOCAL stack, per scripts/perf/start-local-stack.md)');

  const ds = new DataSource({ type: 'postgres', url: databaseUrl });
  await ds.initialize();

  const start = performance.now();
  const rows: Array<{
    endpoint: string;
    method: string;
    n: string;
    p50: string;
    p95: string;
    p99: string;
    error_count: string;
  }> = await ds.query(`
    SELECT
      endpoint,
      method,
      count(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY response_time_ms) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY response_time_ms) AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY response_time_ms) AS p99,
      count(*) FILTER (WHERE status_code >= 400) AS error_count
    FROM api_logs
    GROUP BY endpoint, method
    ORDER BY n DESC
  `);
  const execution_ms = performance.now() - start;

  const totalRows: [{ count: string }] = await ds.query(`SELECT count(*) FROM api_logs`);
  const timeSpan: [{ min: Date; max: Date }] = await ds.query(`SELECT min(created_at), max(created_at) FROM api_logs`);

  console.log(`Audit query execution time: ${execution_ms.toFixed(2)}ms (unindexed GROUP BY scan over ${totalRows[0].count} rows)`);
  console.log(`api_logs time span: ${timeSpan[0].min} .. ${timeSpan[0].max}`);
  console.log(`Distinct endpoint+method combinations: ${rows.length}\n`);

  console.table(
    rows.map((r) => ({
      endpoint: r.endpoint,
      method: r.method,
      n: r.n,
      p50_ms: Number(r.p50).toFixed(1),
      p95_ms: Number(r.p95).toFixed(1),
      p99_ms: Number(r.p99).toFixed(1),
      errors: r.error_count,
    })),
  );

  const fs = require('node:fs');
  const path = require('node:path');
  fs.writeFileSync(
    path.join(__dirname, 'endpoint-percentiles-results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        auditQueryExecutionMs: execution_ms,
        totalRowsInLedger: Number(totalRows[0].count),
        timeSpan: { min: timeSpan[0].min, max: timeSpan[0].max },
        rows: rows.map((r) => ({
          endpoint: r.endpoint,
          method: r.method,
          n: Number(r.n),
          p50_ms: Number(r.p50),
          p95_ms: Number(r.p95),
          p99_ms: Number(r.p99),
          errorCount: Number(r.error_count),
        })),
      },
      null,
      2,
    ),
  );
  console.log('\nWritten to scripts/perf/endpoint-percentiles-results.json');

  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
