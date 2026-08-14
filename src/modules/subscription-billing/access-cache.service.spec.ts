import { ConfigService } from '@nestjs/config';

import { AccessCacheService } from './access-cache.service';

const build = (overrides: Record<string, string> = {}) =>
  new AccessCacheService({
    get: jest.fn((key: string) => overrides[key]),
  } as unknown as ConfigService);

/**
 * The cache's single rule: it may never extend a grant.
 *
 * Everything here is per-process behaviour. Cross-replica invalidation runs
 * over Redis pub/sub and is wired in `onApplicationBootstrap`, which these
 * tests deliberately never call — no unit test should open a socket, and the
 * TTL bounds staleness even when that wiring is unavailable, which is exactly
 * the degraded mode being asserted.
 */
describe('AccessCacheService', () => {
  afterEach(() => jest.useRealTimers());

  it('returns a stored value within the TTL', () => {
    const cache = build();
    cache.set('t1', { base: 'ctx' });
    expect(cache.get('t1')).toEqual({ base: 'ctx' });
  });

  it('misses for an unknown tenant', () => {
    expect(build().get('nobody')).toBeUndefined();
  });

  it('expires after the TTL rather than serving a stale decision', () => {
    jest.useFakeTimers();
    const cache = build({ ACCESS_DECISION_CACHE_TTL_MS: '5000' });
    cache.set('t1', { base: 'ctx' });

    jest.advanceTimersByTime(4_999);
    expect(cache.get('t1')).toBeDefined();

    jest.advanceTimersByTime(2);
    expect(cache.get('t1')).toBeUndefined();
  });

  it('invalidate() drops that tenant and only that tenant', () => {
    const cache = build();
    cache.set('t1', 'a');
    cache.set('t2', 'b');

    cache.invalidate('t1');

    expect(cache.get('t1')).toBeUndefined();
    expect(cache.get('t2')).toBe('b');
  });

  it('invalidateAll() drops everything — the billing-mode case', () => {
    const cache = build();
    cache.set('t1', 'a');
    cache.set('t2', 'b');

    cache.invalidateAll();

    expect(cache.get('t1')).toBeUndefined();
    expect(cache.get('t2')).toBeUndefined();
  });

  /**
   * A supported operational switch: an entitlement incident can be diagnosed
   * with every gate resolving fresh, without a code change or a deploy.
   */
  it('is a permanent miss when the TTL is set to zero', () => {
    const cache = build({ ACCESS_DECISION_CACHE_TTL_MS: '0' });
    cache.set('t1', 'a');
    expect(cache.get('t1')).toBeUndefined();
  });

  it('treats a non-numeric TTL as disabled rather than as a grant that never expires', () => {
    const cache = build({ ACCESS_DECISION_CACHE_TTL_MS: 'not-a-number' });
    cache.set('t1', 'a');
    expect(cache.get('t1')).toBeUndefined();
  });

  /**
   * The platform-usage listing resolves access once per tenant across the whole
   * customer base; without a bound this map would grow to that size and stay
   * there. Evicting the oldest costs one extra resolution, never a wrong answer.
   */
  it('bounds its own size', () => {
    const cache = build();
    for (let i = 0; i < 10_050; i++) cache.set(`t${i}`, i);

    expect(cache.get('t0')).toBeUndefined(); // evicted
    expect(cache.get('t10049')).toBe(10_049); // newest retained
  });

  it('shuts down cleanly when no Redis clients were ever created', async () => {
    await expect(build().onModuleDestroy()).resolves.toBeUndefined();
  });
});
