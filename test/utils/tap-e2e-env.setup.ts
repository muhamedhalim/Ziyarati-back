/**
 * Zero-dependency side-effect module: points the app at Tap SANDBOX with a FAKE
 * key and selects Tap as the payment provider.
 *
 * MUST be imported before anything that transitively imports AppModule — for the
 * same reason as `whatsapp-meta-env-configured.setup.ts`: `ConfigModule.forRoot()`
 * reads `process.env` synchronously when `app.module.ts` is `require()`d and
 * caches it. `jest-e2e.env.js` has already loaded `.env`, which carries the
 * developer's REAL sandbox key, so these are forced OVERWRITES (never `??=`):
 * the real key must never reach a spec, and nothing here ever opens a socket to
 * Tap because `TapApiClient` is replaced at its boundary.
 */
export const TAP_E2E_SECRET_KEY = 'sk_test_E2ePhase2KeyNotARealSecret0000';

process.env.PAYMENT_PROVIDER = 'tap';
process.env.TAP_ENV = 'sandbox';
process.env.TAP_TEST_SECRET_KEY = TAP_E2E_SECRET_KEY;
process.env.TAP_MERCHANT_ID = 'e2e-merchant';
process.env.TAP_WEBHOOK_URL =
  'https://e2e.example.test/api/v1/payments/webhooks/tap';
