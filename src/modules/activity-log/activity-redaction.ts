/**
 * Spec 014 (Clinic Platform Completion) — T023 (S7). Modeled exactly on
 * `SupportActivityService.changedFields` (private there; a standalone,
 * independently testable pure function here). Raw `old_values`/`new_values`
 * JSONB must NEVER leave this helper — only the top-level KEY NAMES that
 * differ, never a value. A "the subscription's plan_id and ends_at changed"
 * summary is what a clinic needs; the values are where secrets and personal
 * data live.
 */
export function changedFields(
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(before ?? {})) keys.add(key);
  for (const key of Object.keys(after ?? {})) keys.add(key);
  return [...keys].sort();
}
