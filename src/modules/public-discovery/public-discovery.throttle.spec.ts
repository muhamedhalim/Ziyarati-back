import {
  PUBLIC_DISCOVERY_CITIES_LIMIT,
  PUBLIC_DISCOVERY_CITIES_THROTTLE,
  PUBLIC_DISCOVERY_CLINICS_LIMIT,
  PUBLIC_DISCOVERY_CLINICS_THROTTLE,
  PUBLIC_DISCOVERY_CLINIC_DETAIL_LIMIT,
  PUBLIC_DISCOVERY_CLINIC_DETAIL_THROTTLE,
} from './public-discovery.throttle';

const GLOBAL_DEFAULT_LIMIT = 300;

describe('public-discovery.throttle (T069, FR-P014)', () => {
  it('every discovery route is stricter than the global default', () => {
    expect(PUBLIC_DISCOVERY_CITIES_LIMIT).toBeLessThan(GLOBAL_DEFAULT_LIMIT);
    expect(PUBLIC_DISCOVERY_CLINICS_LIMIT).toBeLessThan(GLOBAL_DEFAULT_LIMIT);
    expect(PUBLIC_DISCOVERY_CLINIC_DETAIL_LIMIT).toBeLessThan(
      GLOBAL_DEFAULT_LIMIT,
    );
  });

  it('the free-text search route is the tightest (highest enumeration risk)', () => {
    expect(PUBLIC_DISCOVERY_CLINICS_LIMIT).toBeLessThanOrEqual(
      PUBLIC_DISCOVERY_CITIES_LIMIT,
    );
  });

  it("every throttle config uses a 60s window, following PUBLIC_AVAILABILITY_THROTTLE's shape", () => {
    expect(PUBLIC_DISCOVERY_CITIES_THROTTLE.default.ttl).toBe(60_000);
    expect(PUBLIC_DISCOVERY_CLINICS_THROTTLE.default.ttl).toBe(60_000);
    expect(PUBLIC_DISCOVERY_CLINIC_DETAIL_THROTTLE.default.ttl).toBe(60_000);
  });
});
