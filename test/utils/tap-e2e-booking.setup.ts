/**
 * Side-effect module, imported right AFTER `tap-e2e-env.setup` and BEFORE anything
 * that pulls AppModule: switches on patient booking payments through Tap Platform
 * (`TAP_BOOKING_PAYMENTS_ENABLED`) with a FAKE platform id, a FAKE segment key and
 * a fixed public app URL. Separate from the base setup for the same reason as
 * `tap-e2e-recurring.setup`: `ConfigModule` caches `process.env` the first time
 * `app.module.ts` is required, so it cannot be flipped from inside a spec — and
 * the Phase 2/3 specs must keep running with the flag OFF.
 *
 * The values are forced OVERWRITES: `jest-e2e.env.js` has already loaded `.env`,
 * and a real platform id or key must never reach a spec.
 */
export const TAP_E2E_PLATFORM_ID = 'commerce_platform_E2eNotReal';
export const TAP_E2E_SEGMENT_KEY = 'sk_test_E2eSegmentKeyNotARealSecret000';
export const TAP_E2E_APP_URL = 'https://app.e2e.example.test';

process.env.TAP_BOOKING_PAYMENTS_ENABLED = 'true';
process.env.TAP_PLATFORM_ID = TAP_E2E_PLATFORM_ID;
process.env.TAP_SEGMENT_SECRET_KEY = TAP_E2E_SEGMENT_KEY;
process.env.APP_URL = TAP_E2E_APP_URL;
