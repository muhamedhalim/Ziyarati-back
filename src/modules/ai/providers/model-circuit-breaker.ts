import { Logger } from '@nestjs/common';

/**
 * F-22 — per-model failure tracking so a model stuck failing (rate limits,
 * capacity, an outage scoped to just that model) does not fail every turn for
 * its whole cooldown window: traffic is temporarily redirected to the
 * platform's fallback model instead.
 *
 * Deliberately NOT a general-purpose breaker: it tracks exactly the two
 * registered models, in-process, and its only decision is "should THIS model
 * be substituted with the fallback right now". A provider-wide outage (both
 * models erroring) is unaffected — the fallback would fail identically, and
 * `OpenAiRequestPolicy`'s same-model retry-with-backoff still applies first.
 */
export class ModelCircuitBreaker {
  private readonly state = new Map<string, { failures: number; openUntil?: number }>();

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly logger: Logger,
  ) {}

  /**
   * True while `model` is tripped and a call for it should be redirected.
   * Once the cooldown elapses this returns to `false` (half-open: the next
   * call is a real trial against `model`, not an automatic pass).
   */
  isOpen(model: string): boolean {
    const entry = this.state.get(model);
    if (!entry?.openUntil) return false;
    if (Date.now() >= entry.openUntil) {
      entry.openUntil = undefined;
      entry.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(model: string): void {
    this.state.delete(model);
  }

  recordFailure(model: string): void {
    const entry = this.state.get(model) ?? { failures: 0 };
    entry.failures += 1;
    if (entry.failures >= this.threshold && !entry.openUntil) {
      entry.openUntil = Date.now() + this.cooldownMs;
      this.logger.warn(
        `Circuit OPEN for model "${model}" after ${entry.failures} consecutive failures — ` +
          `redirecting to the fallback model for ${this.cooldownMs}ms.`,
      );
    }
    this.state.set(model, entry);
  }
}
