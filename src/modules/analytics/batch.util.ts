/**
 * Concurrency + partial-failure helpers for batch report generation.
 *
 * Batch generation (one report per branch) must NOT be a sequential
 * `await`-in-a-loop: with thousands of branches that serializes thousands of
 * round-trips. It must also NOT be an unbounded `Promise.all`, which would open
 * one DB connection per branch and exhaust the pool. So we run with a bounded
 * worker pool and collect per-item outcomes via `Promise.allSettled` semantics —
 * one failed branch never aborts the batch.
 */

/** Default fan-out width for per-branch generation (kept below the DB pool max). */
export const DEFAULT_BATCH_CONCURRENCY = 5;

export interface BatchResult<T> {
  /** Successfully produced items, in completion order. */
  generated: T[];
  /** Branches that failed, with the reason (for logging / client visibility). */
  failed: { branchId: string; error: string }[];
}

/**
 * Run `fn` for every `branchId` with bounded concurrency, isolating failures.
 *
 * Resolves once ALL items settle. Successful results land in `generated`; any
 * thrown error is captured per-branch in `failed` (never rethrown), so a single
 * bad branch cannot abort the rest of the batch.
 */
export async function mapBranchesSettled<T>(
  branchIds: string[],
  fn: (branchId: string) => Promise<T>,
  concurrency: number = DEFAULT_BATCH_CONCURRENCY,
): Promise<BatchResult<T>> {
  const generated: T[] = [];
  const failed: { branchId: string; error: string }[] = [];

  const width = Math.max(1, Math.min(concurrency, branchIds.length || 1));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < branchIds.length) {
      const index = cursor++;
      const branchId = branchIds[index];
      try {
        generated.push(await fn(branchId));
      } catch (err) {
        failed.push({
          branchId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return { generated, failed };
}
