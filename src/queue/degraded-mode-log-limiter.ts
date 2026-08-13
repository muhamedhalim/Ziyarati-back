import { Logger } from '@nestjs/common';

/**
 * Rate-limited degraded-mode logging, shared by every consumer that
 * previously logged one warning per failing request during a Redis outage
 * (`FailsafeThrottlerStorage.increment`, `AppRedisService`'s client `error`
 * listener) — research.md §R10 / FR-035 / SC-012. At the current 300/min
 * app-wide ceiling that was thousands of lines per minute per instance,
 * burying the very signal the metric counters exist to produce.
 *
 * Emits exactly one line on the transition INTO degraded mode, at most one
 * aggregated summary per `summaryIntervalMs` while it continues, and exactly
 * one line on the transition back to healthy. Holds no timer — entirely
 * reactive, evaluated only when `recordFailure`/`recordSuccess` is called,
 * so there is nothing to leak or clear at shutdown.
 */
export class DegradedModeLogLimiter {
  private degraded = false;
  private eventsSinceLastLog = 0;
  private lastLogAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly label: string,
    private readonly summaryIntervalMs: number = 60_000,
  ) {}

  /**
   * Call on every failure/degraded decision. Logs immediately on the first
   * failure of a new degraded episode; thereafter logs at most once per
   * `summaryIntervalMs`, aggregating the count of decisions made in between.
   */
  recordFailure(errorMessage: string): void {
    const now = Date.now();
    this.eventsSinceLastLog += 1;
    if (!this.degraded) {
      this.degraded = true;
      this.lastLogAt = now;
      this.eventsSinceLastLog = 0;
      this.logger.warn(
        `${this.label} — entering degraded mode: ${errorMessage}`,
      );
      return;
    }
    if (now - this.lastLogAt >= this.summaryIntervalMs) {
      this.logger.warn(
        `${this.label} — still degraded: ${this.eventsSinceLastLog} decision(s) since last summary (last error: ${errorMessage})`,
      );
      this.lastLogAt = now;
      this.eventsSinceLastLog = 0;
    }
  }

  /** Call on every success. Logs exactly once on the transition back to healthy; a no-op the rest of the time. */
  recordSuccess(): void {
    if (this.degraded) {
      this.degraded = false;
      this.eventsSinceLastLog = 0;
      this.logger.log(`${this.label} — recovered.`);
    }
  }

  get isDegraded(): boolean {
    return this.degraded;
  }
}
