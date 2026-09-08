/**
 * Marketplace BE-2 (T060) — name-derived slug generation for the public,
 * globally-unique `staff_profiles.public_slug`. Unicode-aware (`\p{L}`/`\p{N}`)
 * so an Arabic-only name (a real case — doctor names are frequently entered
 * in Arabic) slugifies to a readable Arabic slug rather than an empty string;
 * falls back to `fallback` only when the input carries no letters/digits at all.
 */
export function slugify(input: string, fallback = 'doctor'): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

/**
 * Deterministic numeric disambiguation: `base`, then `base-2`, `base-3`, ...
 * `taken` is checked in order — the caller supplies a live lookup (e.g. a DB
 * query) or a precomputed Set for a batch backfill.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean> | boolean,
  maxAttempts = 1000,
): Promise<string> {
  if (!(await isTaken(base))) return base;
  for (let n = 2; n <= maxAttempts; n++) {
    const candidate = `${base}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(
    `uniqueSlug: exhausted ${maxAttempts} attempts for base "${base}"`,
  );
}
