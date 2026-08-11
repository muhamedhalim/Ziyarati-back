/**
 * Shared helpers for e2e suites that genuinely stop/pause/restart the
 * DISPOSABLE Redis container to exercise degraded-mode and recovery paths
 * (009-auth-abuse-resistance). Used by auth-abuse-redis-degradation.e2e-spec.ts
 * and any other suite with a degraded-mode scenario.
 *
 * **Infrastructure rule (FR-058)**: MUST be pointed at a disposable
 * container, NEVER the shared development Redis. The container name is read
 * from `ZT_E2E_REDIS_CONTAINER` (default `zt-e2e-redis`).
 *
 * The container MUST be provisioned WITHOUT `--rm` — `docker stop` on a
 * `--rm` container deletes it, and `docker start` on a deleted container
 * fails permanently (see specs/009-auth-abuse-resistance/quickstart.md §0).
 */
import { execFileSync } from 'node:child_process';

export const REDIS_CONTAINER = process.env.ZT_E2E_REDIS_CONTAINER ?? 'zt-e2e-redis';

// Bounded so a docker-daemon hiccup fails loudly instead of blocking the
// whole process indefinitely (execFileSync has no default timeout).
const DOCKER_TIMEOUT_MS = 10_000;

export function dockerStop(container: string = REDIS_CONTAINER): void {
  execFileSync('docker', ['stop', container], { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS });
}
export function dockerStart(container: string = REDIS_CONTAINER): void {
  execFileSync('docker', ['start', container], { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS });
}
export function dockerPause(container: string = REDIS_CONTAINER): void {
  execFileSync('docker', ['pause', container], { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS });
}
export function dockerUnpause(container: string = REDIS_CONTAINER): void {
  execFileSync('docker', ['unpause', container], { stdio: 'ignore', timeout: DOCKER_TIMEOUT_MS });
}

/** Never throws — for use in `finally`/`afterAll` blocks where a cleanup failure must not mask the original test outcome. */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best-effort cleanup */
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `docker exec <container> redis-cli ping` until it succeeds or
 * `timeoutMs` elapses. When several e2e files that each stop/start/pause
 * this SAME disposable container run back-to-back in one `--runInBand`
 * process, a fixed short sleep between files is not always enough for the
 * next file's fresh `AppRedisService` connections (built with
 * `enableOfflineQueue: false` on the rate-limiter profile — see
 * redis.config.ts) to find Redis genuinely ready; an early command against
 * a not-yet-ready client fails fast into the degraded path instead of
 * waiting, which can transiently perturb an unrelated healthy-mode
 * assertion in the NEXT file. Call this at the start of a suite's
 * `beforeAll`, before `createE2eApp()`, whenever the suite may run directly
 * after another file that manipulates this container.
 */
export async function waitForRedisReady(
  container: string = REDIS_CONTAINER,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execFileSync('docker', ['exec', container, 'redis-cli', 'ping'], {
        stdio: 'ignore',
        timeout: DOCKER_TIMEOUT_MS,
      });
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Redis container "${container}" did not become ready within ${timeoutMs}ms`);
}
