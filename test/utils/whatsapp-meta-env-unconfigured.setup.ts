/**
 * Zero-dependency side-effect module: clears every META_* var. MUST be the
 * FIRST import in the "unconfigured platform" e2e spec — see
 * whatsapp-meta-env-configured.setup.ts for why ordering matters.
 */
const META_ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_EMBEDDED_SIGNUP_CONFIG_ID',
  'META_GRAPH_API_VERSION',
  'META_WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
];

for (const key of META_ENV_KEYS) delete process.env[key];
