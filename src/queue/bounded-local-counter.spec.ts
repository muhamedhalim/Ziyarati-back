import { BoundedLocalCounter } from './bounded-local-counter';

describe('BoundedLocalCounter (ZT-002 — bounded degraded-mode primitive)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ───────────────────────────── memory bound (SC-010) ───────────────────────────

  describe('memory bound', () => {
    it('allocates a fixed byte size at construction, matching 2 × width × depth × 4 plus the depth-sized row-seed array', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      // Two generations (2 × width × depth × 4) plus the small per-row seed
      // array (depth × 4) — the only other allocation this class makes.
      expect(counter.allocatedBytes).toBe(2 * 4096 * 3 * 4 + 3 * 4);
    });

    it('allocated size does not change after 1,000,000 distinct keys, and heap growth stays small', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      const before = counter.allocatedBytes;

      if (global.gc) global.gc();
      const heapBefore = process.memoryUsage().heapUsed;

      for (let i = 0; i < 1_000_000; i++) {
        counter.increment(`attacker-identity-${i}@example.test`);
      }

      expect(counter.allocatedBytes).toBe(before);

      if (global.gc) global.gc();
      const heapAfter = process.memoryUsage().heapUsed;
      // Very generous bound (50 MB) — this is a soft sanity check on top of
      // the deterministic allocatedBytes assertion above (the actual
      // guarantee: fixed table size, asserted exactly, twice, before and
      // after). Heap deltas are inherently noisy without --expose-gc (no
      // guaranteed GC pass between measurements), so this only needs to
      // catch genuinely unbounded growth (the Map-per-key + timer-per-hit
      // fallback this replaces would be an order of magnitude worse at this
      // cardinality), not pin an exact figure.
      expect(heapAfter - heapBefore).toBeLessThan(50 * 1024 * 1024);
    });

    it('further distinct keys beyond 1,000,000 still do not grow allocated storage', () => {
      const counter = new BoundedLocalCounter({
        width: 256,
        depth: 3,
        windowMs: 60_000,
      });
      for (let i = 0; i < 1_000; i++) counter.increment(`k-${i}`);
      const mid = counter.allocatedBytes;
      for (let i = 1_000; i < 1_100_000; i++) counter.increment(`k-${i}`);
      expect(counter.allocatedBytes).toBe(mid);
    });
  });

  // ───────────────────────────── zero timers (FR-029) ───────────────────────────

  describe('zero timers', () => {
    it('creates no setTimeout/setInterval across construction, increments, peeks, and rotation', () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      jest.useFakeTimers();
      jest.setSystemTime(0);
      const counter = new BoundedLocalCounter({
        width: 64,
        depth: 3,
        windowMs: 1_000,
      });

      for (let i = 0; i < 50; i++) counter.increment(`k-${i}`);
      counter.peek('k-1');

      // Force several window rotations.
      jest.setSystemTime(1_500);
      counter.increment('k-after-rotation-1');
      jest.setSystemTime(2_600);
      counter.increment('k-after-rotation-2');
      jest.setSystemTime(50_000); // a large multi-window jump
      counter.increment('k-after-big-jump');

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });
  });

  // ─────────────────────────── counting correctness ───────────────────────────

  describe('counting correctness (non-colliding conditions)', () => {
    it('repeated requests for one identity are counted', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      counter.increment('same@example.test');
      counter.increment('same@example.test');
      const count = counter.increment('same@example.test');
      expect(count).toBe(3);
    });

    it('independent identities remain independent', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      counter.increment('a@example.test');
      counter.increment('a@example.test');
      counter.increment('b@example.test');
      expect(counter.peek('a@example.test')).toBe(2);
      expect(counter.peek('b@example.test')).toBe(1);
    });

    it('peek() never writes — repeated peeks do not change the count', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      counter.increment('x@example.test');
      counter.peek('x@example.test');
      counter.peek('x@example.test');
      expect(counter.peek('x@example.test')).toBe(1);
    });

    it('an unseen key reads as zero', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      expect(counter.peek('never-seen@example.test')).toBe(0);
    });
  });

  // ─────────────────────── collision safety / non-targetability (ZT-002, FR-013b) ───────────────────────

  describe('collision safety and salt non-targetability', () => {
    it('two instances with different process salts map the same submitted key to different buckets', () => {
      const a = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      const b = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });

      const bucketsA = a.bucketsFor('victim@example.test');
      const bucketsB = b.bucketsFor('victim@example.test');

      // Astronomically unlikely to coincide across all depth rows by chance
      // if salts are genuinely independent and random per instance.
      expect(bucketsA).not.toEqual(bucketsB);
    });

    it('collisions can only over-count: two colliding keys never report a count lower than their true individual count', () => {
      // A tiny table (width=1) forces every key into the same bucket per
      // row, i.e. a guaranteed collision — the worst case.
      const counter = new BoundedLocalCounter({
        width: 1,
        depth: 3,
        windowMs: 60_000,
      });
      counter.increment('a@example.test');
      counter.increment('a@example.test');
      const countA = counter.peek('a@example.test');
      counter.increment('b@example.test'); // collides with a@example.test in every row
      const countAAfterCollision = counter.peek('a@example.test');
      const countB = counter.peek('b@example.test');

      // a's count can only ever be >= its true count (2) — never lower.
      expect(countA).toBeGreaterThanOrEqual(2);
      expect(countAAfterCollision).toBeGreaterThanOrEqual(countA);
      // b inherits a's prior hits under total collision — over-counted, not under.
      expect(countB).toBeGreaterThanOrEqual(1);
    });

    it('the salt never appears in JSON.stringify of the instance', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      counter.increment('probe@example.test');
      const serialized = JSON.stringify(counter);
      // A `#`-private field is not an own enumerable property, so it cannot
      // appear in JSON.stringify output at all.
      expect(serialized).not.toMatch(/salt/i);
    });

    it('the salt never appears via Object.keys/getOwnPropertyNames enumeration', () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      const keys = [
        ...Object.keys(counter),
        ...Object.getOwnPropertyNames(counter),
      ];
      expect(keys.some((k) => /salt/i.test(k))).toBe(false);
    });
  });

  // ───────────────────────── high-cardinality attacker input ─────────────────────────

  describe('high-cardinality attacker input (SC-010, FR-028)', () => {
    it('random high-cardinality keys never change allocated storage size', () => {
      const counter = new BoundedLocalCounter({
        width: 1024,
        depth: 3,
        windowMs: 60_000,
      });
      const before = counter.allocatedBytes;
      for (let i = 0; i < 200_000; i++) {
        counter.increment(`${Math.random()}-${i}-${Date.now()}`);
      }
      expect(counter.allocatedBytes).toBe(before);
    });
  });

  // ─────────────────────────────── window rotation ───────────────────────────────

  describe('window rotation (lazy expiry, FR-029/FR-033)', () => {
    it('a one-window rotation reduces a prior count via the two-generation slide, and a two-window jump clears it entirely', () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 1_000,
      });

      counter.increment('rotating@example.test');
      counter.increment('rotating@example.test');
      expect(counter.peek('rotating@example.test')).toBe(2);

      // One window later: old generation becomes "previous" — still counted
      // (the two-generation slide), so a key that arrived just before
      // rotation is not reset to zero mid-window.
      jest.setSystemTime(1_100);
      expect(counter.peek('rotating@example.test')).toBe(2);

      // A second window later (now in generation N+2): the key's original
      // generation has fully aged out of both current and previous.
      jest.setSystemTime(2_200);
      expect(counter.peek('rotating@example.test')).toBe(0);
    });

    it('a long idle gap spanning many windows clears state rather than exposing a stale generation', () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 1_000,
      });

      counter.increment('idle@example.test');
      jest.setSystemTime(500_000); // 500 windows later
      expect(counter.peek('idle@example.test')).toBe(0);

      // The table is fully usable again afterwards — not permanently wedged.
      counter.increment('idle@example.test');
      expect(counter.peek('idle@example.test')).toBe(1);
    });

    it('rotation does not allocate a new typed array — allocatedBytes is unchanged across many rotations', () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const counter = new BoundedLocalCounter({
        width: 512,
        depth: 3,
        windowMs: 1_000,
      });
      const before = counter.allocatedBytes;
      for (let w = 1; w <= 20; w++) {
        jest.setSystemTime(w * 1_000 + 1);
        counter.increment(`w-${w}`);
      }
      expect(counter.allocatedBytes).toBe(before);
    });
  });

  // ─────────────────────────────────── concurrency ───────────────────────────────────

  describe('concurrency (FR-031, SC-013)', () => {
    it('50 concurrent increments against one key advance the count by exactly 50', async () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      await Promise.all(
        Array.from({ length: 50 }, () =>
          Promise.resolve().then(() =>
            counter.increment('concurrent@example.test'),
          ),
        ),
      );
      expect(counter.peek('concurrent@example.test')).toBe(50);
    });

    it('the final increment in a concurrent burst reports a value consistent with exactly-once counting (no lost/double increments)', async () => {
      const counter = new BoundedLocalCounter({
        width: 4096,
        depth: 3,
        windowMs: 60_000,
      });
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          Promise.resolve().then(() => counter.increment('race@example.test')),
        ),
      );
      // Since increment() is fully synchronous, the 50 results must be
      // exactly the integers 1..50 in some order — no repeats, no gaps.
      expect([...results].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
    });
  });
});
