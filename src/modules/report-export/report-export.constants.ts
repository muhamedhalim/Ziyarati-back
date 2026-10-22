/**
 * Spec 014 (Clinic Platform Completion) — T181/T183 (US13, FR-X006/FR-X007/
 * FR-X010/FR-X014). No numeric value is mandated by data-model.md or the
 * contracts — each is a tunable default, overridable per-deployment.
 */

/** FR-X006/FR-X007 — at or below this row count, the file is returned directly (200); above it, `202 { jobId }`. */
export function exportSyncRowThreshold(): number {
  const raw = Number(process.env.EXPORT_SYNC_ROW_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

/** FR-X010 — a READY export's storage object and downloadability expire after this many days. */
export function exportRetentionDays(): number {
  const raw = Number(process.env.EXPORT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

/** FR-X014 — bounds concurrent RUNNING exports per tenant, so export work cannot starve other clinic operations. */
export function exportConcurrencyCapPerTenant(): number {
  const raw = Number(process.env.EXPORT_CONCURRENCY_CAP_PER_TENANT);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

/**
 * RL-10 — bounds UNFINISHED (PENDING + RUNNING) background exports per tenant
 * at request time. The concurrency cap above only throttles execution; without
 * this, one session could queue thousands of jobs (rows + Redis jobs) and push
 * every later export of that tenant behind them.
 */
export function exportPendingCapPerTenant(): number {
  const raw = Number(process.env.EXPORT_PENDING_CAP_PER_TENANT);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}
