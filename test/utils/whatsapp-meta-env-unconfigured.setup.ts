/**
 * Zero-dependency side-effect module: clears every META_* var. MUST be the
 * FIRST import in the "unconfigured platform" e2e spec — see
 * whatsapp-meta-env-configured.setup.ts for why ordering matters.
 *
 * Sets each key to an EMPTY STRING rather than `delete`-ing it. `delete`
 * looks like a stronger clear but is actually a no-op against a real `.env`
 * that already has these keys (as this dev environment's does, since the
 * separate Meta App Review work populated it): `ConfigModule.forRoot()`
 * builds its config as `{ ...dotenv.parse('.env'), ...process.env }`
 * (`config.module.js`'s `loadEnvFile`/`forRoot`) — `process.env` only wins
 * that merge for keys it actually OWNS (`in` / spread semantics), so a
 * `delete`d key falls straight through to the file's real value and this
 * suite's own precondition (Meta NOT configured) silently never holds. An
 * empty string is still an owned key, so it always wins the merge and
 * `MetaConfig`'s own `trimmed()` (`value.trim() || undefined`) already
 * treats '' as unconfigured — same convention `environments.md` documents
 * for neutralizing provider credentials (`OPENAI_API_KEY=""` etc.). Mirrors
 * the sibling `whatsapp-meta-env-configured.setup.ts`'s `Object.assign`
 * technique, just with empty values instead of test fixtures.
 */
// META_GRAPH_API_VERSION is deliberately NOT in this list: it plays no part
// in `MetaConfig.embeddedSignupConfigured`/`requireAppId`/`requireAppSecret`
// (it is just the Graph API version string, always defaulted to 'v21.0' when
// absent), and unlike the other keys `env.validation.ts`'s Joi schema pins it
// to `.pattern(/^v\d+\.\d+$/)` with no `.allow('')` — forcing it empty would
// fail env validation instead of simulating "unconfigured".
const META_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_EMBEDDED_SIGNUP_CONFIG_ID',
  'META_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
];

for (const key of META_ENV_KEYS) process.env[key] = '';
