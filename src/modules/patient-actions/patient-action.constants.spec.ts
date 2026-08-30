import {
  PATIENT_ACTION_LINK_CONFIRM_LIMIT,
  PATIENT_ACTION_LINK_CONFIRM_THROTTLE,
  PATIENT_ACTION_LINK_RESOLVE_LIMIT,
  PATIENT_ACTION_LINK_RESOLVE_THROTTLE,
} from './patient-action.constants';

/** The platform-wide default (app.module.ts's `ThrottlerModule.forRootAsync`). */
const GLOBAL_DEFAULT_LIMIT = 300;

describe('patient-action.constants throttles (T025, FR-C016)', () => {
  it('link resolution is stricter than the global default', () => {
    expect(PATIENT_ACTION_LINK_RESOLVE_LIMIT).toBeLessThan(GLOBAL_DEFAULT_LIMIT);
  });

  it('link confirmation is stricter than link resolution (a mutating request)', () => {
    expect(PATIENT_ACTION_LINK_CONFIRM_LIMIT).toBeLessThan(PATIENT_ACTION_LINK_RESOLVE_LIMIT);
    expect(PATIENT_ACTION_LINK_CONFIRM_LIMIT).toBeLessThan(GLOBAL_DEFAULT_LIMIT);
  });

  it('both throttle configs use a 60s window, following GUEST_ATTACHMENT_THROTTLE\'s shape', () => {
    expect(PATIENT_ACTION_LINK_RESOLVE_THROTTLE.default.ttl).toBe(60_000);
    expect(PATIENT_ACTION_LINK_CONFIRM_THROTTLE.default.ttl).toBe(60_000);
  });
});
