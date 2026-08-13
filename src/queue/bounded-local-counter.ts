import { randomBytes } from 'crypto';

export interface BoundedLocalCounterOptions {
  /** Columns per hash row. Fixes memory: `2 × width × depth × 4` bytes, allocated once. */
  width: number;
  /** Independent hash rows summed with `min()`. Default 3 — a false positive needs a simultaneous collision in all three. */
  depth?: number;
  /** Fixed-window length in milliseconds. */
  windowMs: number;
}

/**
 * Fixed-width hashed counter table with lazy generation rotation — the
 * bounded-memory degraded-mode primitive for 009-auth-abuse-resistance
 * (ZT-002). Replaces `@nestjs/throttler`'s `ThrottlerStorageService`
 * (`_storage = new Map()`, one `setTimeout` per hit, no delete path), whose
 * memory model and log volume were the actual defect ZT-002 names.
 *
 * Invariants (FR-028, FR-028a, FR-029, FR-029a, FR-030, FR-038):
 *
 * 1. **Memory is fixed at construction, independent of key cardinality.**
 *    There is no insert path — every key maps into the same two
 *    preallocated `Uint32Array`s via a hash, never appended to a
 *    collection — so an attacker who supplies an unbounded number of
 *    distinct identities cannot grow allocated memory by one byte.
 * 2. **Hash collisions can only OVER-count, never under-count.** Two keys
 *    sharing a bucket inflate each other's count, which can only make the
 *    degraded limiter *stricter*. There is deliberately no decrement/reset
 *    operation on this class — the only way to lower a bucket is to let it
 *    age out via window rotation — because a reset keyed on one caller's
 *    identity would, under a collision, silently under-count an unrelated
 *    colliding identity. A security limiter must never be able to fail
 *    permissive that way.
 * 3. **Counters are process-local.** With N API instances each running an
 *    independent instance of this class, the effective platform-wide
 *    degraded bound for whatever limit is layered on top is
 *    `local_limit × N`, not `local_limit` — see data-model.md §5. This
 *    class has no cross-instance awareness and makes none.
 * 4. **No timers, ever.** Expiry is lazy generation rotation computed from
 *    `floor(now / windowMs)` on each operation — there is no `setTimeout`
 *    or `setInterval` anywhere in this file, so there is nothing to leak or
 *    clear at shutdown.
 */
export class BoundedLocalCounter {
  private readonly width: number;
  private readonly depth: number;
  private readonly windowMs: number;

  /**
   * Process-random, generated exactly ONCE per instance at construction via
   * `crypto.randomBytes` and held only in memory. A true (`#`) private
   * field — never enumerable, never reachable by `JSON.stringify`,
   * `Object.keys`, `for...in`, or a naive `console.log` of the instance —
   * so it cannot be accidentally persisted, logged, or serialized into a
   * metric label. MUST NOT be regenerated per request: a fresh salt per
   * call would make every call's bucket mapping independent, which
   * defeats the whole point of counting repeated hits against one key.
   */
  readonly #salt: Buffer;

  /** One derived 32-bit seed per hash row, computed once from `#salt` at construction — never regenerated, never exposed. */
  readonly #rowSeeds: Uint32Array;

  /** Two preallocated generations. Never reallocated after construction — rotation swaps the `current`/`previous` roles and zeroes in place via `.fill(0)`. */
  private readonly genA: Uint32Array;
  private readonly genB: Uint32Array;
  private currentIsA: boolean;
  private currentWindowIndex: number;

  constructor(options: BoundedLocalCounterOptions) {
    if (options.width < 1) {
      throw new Error('BoundedLocalCounter: width must be a positive integer');
    }
    this.width = Math.floor(options.width);
    this.depth = Math.max(1, Math.floor(options.depth ?? 3));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));

    this.#salt = randomBytes(32);
    this.#rowSeeds = new Uint32Array(this.depth);
    for (let row = 0; row < this.depth; row++) {
      this.#rowSeeds[row] = BoundedLocalCounter.deriveRowSeed(this.#salt, row);
    }

    this.genA = new Uint32Array(this.width * this.depth);
    this.genB = new Uint32Array(this.width * this.depth);
    this.currentIsA = true;
    this.currentWindowIndex = BoundedLocalCounter.windowIndexAt(this.windowMs);
  }

  /** Total bytes allocated by this instance — fixed at construction, never changes. Exposed for the memory-bound test (SC-010) rather than relying on flaky heap snapshots. */
  get allocatedBytes(): number {
    return (
      this.genA.byteLength + this.genB.byteLength + this.#rowSeeds.byteLength
    );
  }

  /**
   * Increments the counter for `key` in the current generation and returns
   * the resulting estimate — `min()` across the `depth` rows, summed over
   * current + previous generation so a key that just arrived is never
   * reset to zero mid-rotation.
   */
  increment(key: string): number {
    this.rotateIfNeeded();
    const current = this.current();
    const previous = this.previous();
    let estimate = Number.POSITIVE_INFINITY;
    for (let row = 0; row < this.depth; row++) {
      const idx = row * this.width + this.bucketFor(key, row);
      if (current[idx] < 0xffffffff) current[idx] += 1; // defensive overflow guard; unreachable at any realistic request volume
      const total = current[idx] + previous[idx];
      if (total < estimate) estimate = total;
    }
    return estimate;
  }

  /** Read-only estimate for `key` — performs no write, mirroring `LoginProtectionService.isLocked`'s read-only contract. */
  peek(key: string): number {
    this.rotateIfNeeded();
    const current = this.current();
    const previous = this.previous();
    let estimate = Number.POSITIVE_INFINITY;
    for (let row = 0; row < this.depth; row++) {
      const idx = row * this.width + this.bucketFor(key, row);
      const total = current[idx] + previous[idx];
      if (total < estimate) estimate = total;
    }
    return estimate;
  }

  /**
   * The bucket indices `key` maps to in each of the `depth` rows —
   * INTRODUCED FOR TEST/OBSERVABILITY USE ONLY (the collision-targetability
   * proof, ZT-002/FR-013b). Reveals nothing about `#salt` itself, only its
   * effect on bucket placement, so exposing it does not weaken the
   * non-targetability guarantee.
   */
  bucketsFor(key: string): readonly number[] {
    const buckets: number[] = [];
    for (let row = 0; row < this.depth; row++) {
      buckets.push(this.bucketFor(key, row));
    }
    return buckets;
  }

  private current(): Uint32Array {
    return this.currentIsA ? this.genA : this.genB;
  }

  private previous(): Uint32Array {
    return this.currentIsA ? this.genB : this.genA;
  }

  private static windowIndexAt(windowMs: number): number {
    return Math.floor(Date.now() / windowMs);
  }

  /**
   * The entire expiry mechanism. Computed on every operation — no timer
   * anywhere. A one-window jump promotes current→previous and zeroes the
   * new current in place (`.fill(0)`, no allocation). A jump of MORE than
   * one window (a long idle gap) means neither existing generation
   * represents "now" or "now - 1", so both are cleared instead of keeping a
   * stale generation alive under the wrong label.
   */
  private rotateIfNeeded(): void {
    const idx = BoundedLocalCounter.windowIndexAt(this.windowMs);
    const delta = idx - this.currentWindowIndex;
    if (delta <= 0) return; // same window (delta === 0) or backward clock skew (delta < 0) — no-op either way
    if (delta === 1) {
      this.currentIsA = !this.currentIsA;
      this.current().fill(0);
    } else {
      this.genA.fill(0);
      this.genB.fill(0);
    }
    this.currentWindowIndex = idx;
  }

  /**
   * FNV-1a over `key`'s UTF-16 code units, seeded per-row from `#salt` so
   * the `depth` rows are independent hash functions and no two instances
   * (different salts) place the same key in the same bucket set — the
   * property the collision-targetability test proves.
   */
  private bucketFor(key: string, row: number): number {
    let h = this.#rowSeeds[row];
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % this.width;
  }

  private static deriveRowSeed(salt: Buffer, row: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < salt.length; i++) {
      h ^= salt[i];
      h = Math.imul(h, 0x01000193);
    }
    h ^= row;
    h = Math.imul(h, 0x01000193);
    return h >>> 0;
  }
}
