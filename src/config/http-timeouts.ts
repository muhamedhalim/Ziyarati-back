import type { Server } from 'node:http';

/**
 * RL-12 — explicit Node HTTP server timeouts instead of the framework defaults
 * (keep-alive 5 s, headers 60 s, request 300 s), measured in the Phase C lab.
 *
 * - keepAliveTimeout must OUTLIVE the ALB's idle timeout (120 s, Terraform
 *   `modules/alb`): if Node closes an idle socket first, the ALB can reuse it
 *   at that instant and the caller gets a 502.
 * - headersTimeout must exceed keepAliveTimeout (Node guidance), and
 *   requestTimeout must be ≥ headersTimeout (Node refuses the reverse).
 * - requestTimeout bounds how long ONE request may take to arrive: 300 s let a
 *   slow-body sender hold a socket for five minutes; 135 s still leaves a
 *   5 MB import upload at ~40 KB/s room to finish.
 *
 * Tasks are reachable only through the ALB, which forwards complete headers,
 * so the longer header timeout is not a slowloris opening.
 */
export interface HttpTimeouts {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_HTTP_TIMEOUTS: HttpTimeouts = {
  keepAliveTimeoutMs: 125_000,
  headersTimeoutMs: 130_000,
  requestTimeoutMs: 135_000,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Reads `HTTP_KEEP_ALIVE_TIMEOUT_MS` / `HTTP_HEADERS_TIMEOUT_MS` / `HTTP_REQUEST_TIMEOUT_MS`, enforcing the ordering above. */
export function resolveHttpTimeouts(
  env: NodeJS.ProcessEnv = process.env,
): HttpTimeouts {
  const keepAliveTimeoutMs = positiveInt(
    env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUTS.keepAliveTimeoutMs,
  );
  const headersTimeoutMs = Math.max(
    positiveInt(
      env.HTTP_HEADERS_TIMEOUT_MS,
      DEFAULT_HTTP_TIMEOUTS.headersTimeoutMs,
    ),
    keepAliveTimeoutMs + 1_000,
  );
  const requestTimeoutMs = Math.max(
    positiveInt(
      env.HTTP_REQUEST_TIMEOUT_MS,
      DEFAULT_HTTP_TIMEOUTS.requestTimeoutMs,
    ),
    headersTimeoutMs,
  );
  return { keepAliveTimeoutMs, headersTimeoutMs, requestTimeoutMs };
}

export function applyHttpTimeouts(
  server: Server,
  timeouts: HttpTimeouts,
): void {
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
}
