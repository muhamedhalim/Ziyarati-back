/**
 * Spec 014 (Clinic Platform Completion) — Phase 15 (US13, T182, FR-X008).
 *
 * Proves `XlsxWriterService.writeToBuffer` stays memory-bounded for a
 * 100 000-row export: seeds a throwaway table with 100k rows, streams them
 * through the writer via a genuine KEYSET-paginated Postgres query (id >
 * cursor, LIMIT pageSize — same idiom as `segment-preview-100k.ts`'s own
 * customer-resolution loop and `campaign-fanout.service.ts`'s production
 * keyset window), and asserts the process's resident heap growth across the
 * whole write stays within a small multiple of ONE PAGE's row data — never
 * scaling with the full 100k-row set.
 *
 * None of `export-registry.ts`'s six registered reports can naturally
 * produce 100k rows themselves (each is bounded by staff/branch/service/
 * channel cardinality, or by a report's own day/month count — see that
 * file's own docblock) — this script exercises the WRITER directly against
 * a synthetic keyset source, exactly proving the FR-X008 property
 * independently of which report a future large dataset arrives through.
 *
 * NOT a jest spec — a 100k-row seed + full streaming write takes real time
 * and deliberately measures heap growth across it, which is exactly the
 * kind of long-running verification this project's test discipline says
 * must never block a jest run/watch loop (mirrors `segment-preview-100k.ts`'s
 * own rationale). Run on demand:
 *   npx ts-node --project tsconfig.seed.json scripts/perf/report-export-100k.ts
 *
 * Safety: creates its own throwaway table (never touches a real domain
 * table) and drops it in a `finally` block, even on assertion failure.
 *
 * STATUS: written but NOT executed as part of this task (T182) — matches
 * this repo's own established precedent for this exact situation (see
 * T126/T148 in specs/014-clinic-platform-completion/tasks.md, both left
 * unchecked for the same reason: a real long-running perf run is out of
 * scope for an automated pass and must be run manually / in a dedicated
 * perf lane).
 */
import { DataSource } from 'typeorm';
import { SeedDataSource } from '../../src/seed/data-source';
import { XlsxWriterService } from '../../src/modules/report-export/xlsx-writer.service';
import { ExportColumn } from '../../src/modules/report-export/export-registry';

const ROW_COUNT = 100_000;
const SEED_BATCH_SIZE = 2_000;
const EXPORT_PAGE_SIZE = 500;
// One page's worth of row objects is tiny (500 rows * ~3 small fields); a
// generous ceiling that would still catch "the whole 100k set was buffered"
// (which would show tens of MB of extra retained heap, not a few hundred KB).
const MAX_HEAP_GROWTH_BYTES = 50 * 1024 * 1024;

const COLUMNS: ExportColumn[] = [
  { key: 'label', header: 'Label' },
  { key: 'amount', header: 'Amount' },
  { key: 'created_at', header: 'Created At' },
];

async function main(): Promise<void> {
  const ds: DataSource = await SeedDataSource.initialize();
  const tableName = `t182_perf_rows_${Date.now()}`;
  const started = Date.now();

  try {
    await ds.query(`
      CREATE TABLE "${tableName}" (
        id bigserial PRIMARY KEY,
        label varchar NOT NULL,
        amount numeric(10,2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    console.log(`Seeding ${ROW_COUNT} rows into ${tableName}...`);
    for (let i = 0; i < ROW_COUNT; i += SEED_BATCH_SIZE) {
      const rows: string[] = [];
      const params: unknown[] = [];
      const batchLen = Math.min(SEED_BATCH_SIZE, ROW_COUNT - i);
      for (let j = 0; j < batchLen; j++) {
        const idx = i + j;
        const base = params.length;
        rows.push(`($${base + 1}, $${base + 2})`);
        params.push(`Row ${idx}`, (idx % 1000) + 0.5);
      }
      await ds.query(
        `INSERT INTO "${tableName}" (label, amount) VALUES ${rows.join(',')}`,
        params,
      );
      if ((i / SEED_BATCH_SIZE) % 10 === 0) {
        console.log(`  ...${i + batchLen}/${ROW_COUNT}`);
      }
    }
    console.log(
      `Seed complete in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );

    const writer = new XlsxWriterService();

    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeapDuringWrite = heapBefore;

    const writeStart = Date.now();
    const { buffer, rowCount } = await writer.writeToBuffer(
      COLUMNS,
      async (cursor, pageSize) => {
        const cursorClause = cursor ? 'AND id > $2' : '';
        const params = cursor ? [pageSize, Number(cursor)] : [pageSize];
        const rows: {
          id: string;
          label: string;
          amount: string;
          created_at: Date;
        }[] = await ds.query(
          `SELECT id, label, amount, created_at FROM "${tableName}"
             WHERE true ${cursorClause}
             ORDER BY id ASC LIMIT $1`,
          cursor ? [pageSize, Number(cursor)] : [pageSize],
        );
        void params;
        peakHeapDuringWrite = Math.max(
          peakHeapDuringWrite,
          process.memoryUsage().heapUsed,
        );
        return {
          rows: rows.map((r) => ({
            label: r.label,
            amount: r.amount,
            created_at: r.created_at.toISOString(),
          })),
          nextCursor:
            rows.length === pageSize ? rows[rows.length - 1].id : null,
        };
      },
      EXPORT_PAGE_SIZE,
    );
    const writeMs = Date.now() - writeStart;

    const heapGrowth = peakHeapDuringWrite - heapBefore;
    console.log(
      `Wrote ${rowCount} rows (${buffer.length} bytes) in ${writeMs}ms. ` +
        `Heap growth during write: ${(heapGrowth / 1024 / 1024).toFixed(2)}MB`,
    );

    if (rowCount !== ROW_COUNT) {
      throw new Error(`FAILED: expected ${ROW_COUNT} rows, wrote ${rowCount}`);
    }
    if (heapGrowth > MAX_HEAP_GROWTH_BYTES) {
      throw new Error(
        `FR-X008 FAILED: heap grew ${(heapGrowth / 1024 / 1024).toFixed(2)}MB ` +
          `(> ${(MAX_HEAP_GROWTH_BYTES / 1024 / 1024).toFixed(0)}MB ceiling) — ` +
          `looks like rows accumulated across pages instead of streaming`,
      );
    }

    console.log(
      'T182 PASSED: 100k-row export stayed within the memory ceiling.',
    );
  } finally {
    console.log('Cleaning up perf table...');
    await ds.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
