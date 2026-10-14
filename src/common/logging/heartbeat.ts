import { monitorEventLoopDelay } from 'node:perf_hooks';

import { LOG_EVENT } from './log-events';
import type { StructuredLogger } from './structured-logger';

/**
 * One `app.heartbeat` line per process per interval (default 60 s).
 *
 * It is what lets an alert distinguish "quiet" from "dead": routine health
 * probes and job successes are `debug` and dropped in production, so a healthy
 * but idle service could otherwise go minutes without a single line. The
 * CloudWatch "logs silent" alarms (infra/terraform/modules/monitoring/logs.tf)
 * fire when this stops arriving — which also catches a broken log pipeline.
 * ~1,440 small lines/day/process. `LOG_HEARTBEAT_INTERVAL_MS=0` disables it.
 */
export function startHeartbeat(
  logger: StructuredLogger,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const raw = Number(env.LOG_HEARTBEAT_INTERVAL_MS ?? 60_000);
  const intervalMs = Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
  if (intervalMs === 0) return () => undefined;

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  const timer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      logger.event('info', LOG_EVENT.APP_HEARTBEAT, 'heartbeat', {
        uptime_s: Math.round(process.uptime()),
        rss_mb: Math.round(mem.rss / 1_048_576),
        heap_used_mb: Math.round(mem.heapUsed / 1_048_576),
        event_loop_delay_p99_ms: Math.round(loopDelay.percentile(99) / 1e6),
      });
      loopDelay.reset();
    } catch {
      // never let the heartbeat itself crash the process
    }
  }, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    loopDelay.disable();
  };
}
