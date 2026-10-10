import {
  PUBLIC_AVAILABILITY_LIMIT,
  PUBLIC_AVAILABILITY_THROTTLE,
  PUBLIC_BOOKING_CONFIRM_LIMIT,
  PUBLIC_BOOKING_CONFIRM_THROTTLE,
} from './public-booking.throttle';

const GLOBAL_DEFAULT_LIMIT = 300;

describe('public-booking.throttle (T025, FR-P014)', () => {
  it('availability reads are stricter than the global default', () => {
    expect(PUBLIC_AVAILABILITY_LIMIT).toBeLessThan(GLOBAL_DEFAULT_LIMIT);
  });

  it('booking confirmation is stricter than availability reads (a mutating request)', () => {
    expect(PUBLIC_BOOKING_CONFIRM_LIMIT).toBeLessThan(PUBLIC_AVAILABILITY_LIMIT);
    expect(PUBLIC_BOOKING_CONFIRM_LIMIT).toBeLessThan(GLOBAL_DEFAULT_LIMIT);
  });

  it('both throttle configs use a 60s window, following PUBLIC_AVAILABILITY_THROTTLE\'s shape', () => {
    expect(PUBLIC_AVAILABILITY_THROTTLE.default.ttl).toBe(60_000);
    expect(PUBLIC_BOOKING_CONFIRM_THROTTLE.default.ttl).toBe(60_000);
  });
});
