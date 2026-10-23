/**
 * Specs that need real infrastructure (Postgres, Redis) used to `return` early when it was missing.
 * Jest reports that as a PASS, so a CI job without the service went green having tested nothing
 * (CR-13): `synchronize-guard.int-spec.ts` and `analytics-no-branch.redis.spec.ts` both did.
 *
 * `infraUnavailable()` keeps the laptop experience (a loud warning, the suite still loads) but makes
 * the absence a hard FAILURE wherever the infrastructure is guaranteed to exist: `CI=true` (GitHub
 * Actions sets it) or `REQUIRE_TESTCONTAINERS=true|1` (the existing opt-in used by
 * `redis-resilience.int-spec.ts`).
 */
const TRUE = new Set(['true', '1']);

export const INFRA_REQUIRED =
  TRUE.has(String(process.env.CI ?? '').toLowerCase()) ||
  TRUE.has(String(process.env.REQUIRE_TESTCONTAINERS ?? '').toLowerCase());

/** Call from `beforeAll` when a required service did not answer. */
export function infraUnavailable(what: string, detail?: string): void {
  const message =
    `${what} is not available${detail ? ` (${detail})` : ''}, so this suite would test nothing. ` +
    'Start it, or run on a machine where it is provided.';
  if (INFRA_REQUIRED) {
    throw new Error(
      `${message} CI / REQUIRE_TESTCONTAINERS is set, so a missing service is a failure, not a skip.`,
    );
  }
  console.warn(`SKIPPED (not a pass): ${message}`);
}
