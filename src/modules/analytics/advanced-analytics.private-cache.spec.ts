/**
 * `@PrivateCache` WIRING — is it actually on the handlers it needs to be on?
 *
 * `private-cache.decorator.spec.ts` already proves the interceptor mechanism
 * itself: headers set correctly, before the handler resolves (so a 304 still
 * carries them — Express computes the ETag inside `res.send()`, after
 * `PrivateCacheInterceptor` already ran), private + Vary + must-revalidate,
 * and a no-op when the metadata is absent or non-positive. None of that is
 * re-proven here.
 *
 * What is NOT proven anywhere else: whether `@PrivateCache` is actually
 * attached to the five specific handlers CACHE-001/P3 added it to — a
 * regression here (someone removing the decorator while touching a handler)
 * would silently reintroduce the "every re-open re-runs the query" defect
 * the P0 baseline measured. Reads the real `SetMetadata` value directly off
 * the controller class — no DB, no HTTP, no testcontainers needed.
 */
import 'reflect-metadata';
import { PRIVATE_CACHE_KEY } from '../../common/http/private-cache.decorator';
import { AdvancedAnalyticsController } from './advanced-analytics.controller';

const ANALYTICS_MAX_AGE_SECONDS = 30;

function maxAgeOf(methodName: keyof AdvancedAnalyticsController) {
  return Reflect.getMetadata(
    PRIVATE_CACHE_KEY,
    AdvancedAnalyticsController.prototype[methodName],
  ) as number | undefined;
}

describe('AdvancedAnalyticsController — @PrivateCache wiring (CACHE-001, P3)', () => {
  it.each([
    ['appointmentsTrend', '/analytics/trends/appointments'],
    ['revenueTrend', '/analytics/trends/revenue'],
    ['rates', '/analytics/rates'],
    ['retention', '/analytics/retention'],
    ['performanceServices', '/analytics/performance/services'],
    ['performanceBranches', '/analytics/performance/branches'],
    ['performanceChannels', '/analytics/performance/channels'],
  ] as const)('%s (%s) carries a 30 s @PrivateCache', (methodName, _route) => {
    expect(maxAgeOf(methodName)).toBe(ANALYTICS_MAX_AGE_SECONDS);
  });

  it("does NOT cache performanceStaff — it has no known frontend consumer, so there is no client-tolerance argument for it (see the constant's docblock)", () => {
    expect(maxAgeOf('performanceStaff')).toBeUndefined();
  });

  it('does NOT cache metrics/definitions — static registry data, not a per-request read', () => {
    expect(maxAgeOf('listDefinitions')).toBeUndefined();
  });
});
