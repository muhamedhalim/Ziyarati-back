/**
 * 009-auth-abuse-resistance — protects multi-request-burst e2e assertions
 * from a real, if rare, race: `FixedWindowLimiterService` keys a window by
 * `Math.floor(Date.now() / (windowSeconds * 1000))`, i.e. calendar-aligned
 * real time, not "time since the first request in this test". A burst that
 * starts a few seconds before a window boundary can have its later requests
 * land in a FRESH window, which correctly resets the count (exactly the
 * behaviour a fixed-window limiter is supposed to have) but breaks a test's
 * "exactly BUDGET admitted out of N" assertion, which implicitly assumes the
 * whole burst lands in one window. Observed directly: a from-scratch run of
 * T059 (a 20-request burst) once produced 10 admits instead of 5 — a Redis
 * key inspection immediately after confirmed the limiter itself was correct
 * (single key, count 20, TTL live) on every OTHER run; only that one run's
 * timing straddled a boundary.
 *
 * Call this before firing a same-subject burst whose assertion assumes
 * single-window containment. It is a no-op almost always (only sleeps when
 * the current window is within `minMarginSeconds` of rolling over), so it
 * does not meaningfully slow the suite down.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function alignToFreshWindow(
  windowSeconds: number,
  minMarginSeconds = 10,
): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const elapsedInWindow = Date.now() % windowMs;
  const remaining = windowMs - elapsedInWindow;
  if (remaining < minMarginSeconds * 1000) {
    await sleep(remaining + 50); // small buffer past the boundary itself
  }
}

/**
 * Unconditionally waits for the NEXT window boundary (worst case, just under
 * `windowSeconds` of real time) — for tests that need a counter GUARANTEED
 * to start at zero regardless of what earlier tests in the same file already
 * did against the same key (e.g. an endpoint-wide, non-identity-keyed
 * ceiling shared across an entire describe block). Use sparingly — reserve
 * it for tests that specifically need to *drain a counter to one remaining
 * slot* to prove atomicity under concurrency (the same rigor as
 * auth-abuse-forgot-password.e2e-spec.ts's T064); a test that only needs
 * "eventually refused" can instead track which of its OWN requests were
 * refused and assert no side effect landed for exactly those, which needs
 * no alignment at all.
 */
export async function alignToFreshWindowGuaranteed(windowSeconds: number): Promise<void> {
  const windowMs = windowSeconds * 1000;
  const elapsedInWindow = Date.now() % windowMs;
  const remaining = windowMs - elapsedInWindow;
  await sleep(remaining + 50);
}
