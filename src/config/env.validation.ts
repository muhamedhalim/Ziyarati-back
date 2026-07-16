import * as Joi from 'joi';

export const validate = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),

    DATABASE_URL: Joi.string().required(),

    TYPEORM_SYNCHRONIZE: Joi.string()
      .valid('true', 'false')
      .default('false'),

    TYPEORM_LOGGING: Joi.string()
      .valid('true', 'false')
      .default('false'),

    DB_POOL_MAX: Joi.number().default(10),
    DB_POOL_MIN: Joi.number().default(1),
    DB_POOL_IDLE_TIMEOUT: Joi.number().default(30000),

    // Redis / BullMQ. REDIS_URL is required at runtime by the queue subsystem
    // (the worker won't process without it); kept optional in the schema so the
    // API can still boot in environments where queues are disabled.
    REDIS_URL: Joi.string().allow('', null),
    QUEUE_DEFAULT_ATTEMPTS: Joi.number().default(5),
    QUEUE_BACKOFF_MS: Joi.number().default(3000),
    WORKER_CONCURRENCY: Joi.number().default(5),

    // ── Analytics read cache (Redis) ──────────────────────────────────────
    // Optional: reuses REDIS_URL on a dedicated connection. When REDIS_URL is
    // unset or ANALYTICS_CACHE_ENABLED=false, analytics reads fail open to the
    // database (no behavior change). TTL is in seconds.
    ANALYTICS_CACHE_ENABLED: Joi.string().valid('true', 'false').default('true'),
    ANALYTICS_CACHE_TTL: Joi.number().default(60),
    // Raw analytics_events older than this are purged by the daily retention
    // sweep. Floored at 1 day so a 0/negative value can't purge the whole table.
    ANALYTICS_EVENT_RETENTION_DAYS: Joi.number().min(1).default(90),

    JWT_ACCESS_SECRET: Joi.string().required(),
    JWT_REFRESH_SECRET: Joi.string().required(),

    JWT_ACCESS_TTL: Joi.string().default('15m'),
    JWT_REFRESH_TTL: Joi.string().default('7d'),

    // ── Payments / Moyasar (PLATFORM-level only) ──────────────────────────
    // Optional: when unset, the payment gateway factory falls back to the
    // Noop provider so the app boots and runs without a live integration.
    MOYASAR_SECRET_KEY: Joi.string().allow('', null),
    MOYASAR_PUBLISHABLE_KEY: Joi.string().allow('', null),
    MOYASAR_WEBHOOK_SECRET: Joi.string().allow('', null),
    MOYASAR_API_BASE: Joi.string().allow('', null),

    // Marketplace platform commission frozen onto each payment at capture.
    // Both default to 0 (platform takes no cut) until a fee policy is set.
    PLATFORM_FEE_PERCENT: Joi.number().min(0).max(100).default(0),
    PLATFORM_FEE_FIXED: Joi.number().min(0).default(0),

    // ── Email (Resend by default; provider behind an abstraction) ─────────
    // `enabled` defaults to ON in production, OFF in dev (no-op provider) unless
    // EMAIL_ENABLED is set explicitly. EMAIL_SYNC=true delivers inline instead of
    // via the worker (for API-only deployments).
    EMAIL_PROVIDER: Joi.string().valid('resend', 'noop').default('resend'),
    EMAIL_ENABLED: Joi.string().valid('true', 'false'),
    EMAIL_SYNC: Joi.string().valid('true', 'false').default('false'),
    RESEND_API_KEY: Joi.string().allow('', null),
    EMAIL_FROM: Joi.string().allow('', null),
    EMAIL_FROM_NAME: Joi.string().allow('', null),
    EMAIL_REPLY_TO: Joi.string().allow('', null),
    EMAIL_DEFAULT_LOCALE: Joi.string().default('en'),
    // Base URL used to build links inside emails (falls back to FRONTEND_ORIGIN).
    APP_URL: Joi.string().allow('', null),

    // ── Meta App (PLATFORM APP config only — Independent Tech Provider) ───
    // These configure ZiyaraTech's single Meta App — they are NOT a sending
    // identity. Every clinic's own WABA / phone number / access token lives on
    // the WhatsappAccount entity (encrypted), never in env: this platform is an
    // Independent Tech Provider, not the owner of a shared number. Adding a
    // tenant credential here would re-create the shared-number model.
    //
    // Optional in the schema so the app boots without a live integration, but:
    //   • the webhook verifier fails CLOSED when the app secret / verify token
    //     are unset (no dev bypass);
    //   • Embedded Signup returns 422 until APP_ID + CONFIG_ID + SECRET are set.
    // Read exclusively through MetaConfig — never `config.get()` directly.
    META_APP_ID: Joi.string().allow('', null),
    META_APP_SECRET: Joi.string().allow('', null),
    META_EMBEDDED_SIGNUP_CONFIG_ID: Joi.string().allow('', null),
    META_GRAPH_API_VERSION: Joi.string()
      .pattern(/^v\d+\.\d+$/)
      .default('v21.0'),
    META_WEBHOOK_VERIFY_TOKEN: Joi.string().allow('', null),
    META_HTTP_TIMEOUT_MS: Joi.number().min(1000).default(10000),

    // Legacy aliases for the two webhook secrets, still honoured by MetaConfig
    // so this change doesn't break a live webhook on deploy. Remove once every
    // environment has migrated to the META_* names.
    WHATSAPP_APP_SECRET: Joi.string().allow('', null),
    WHATSAPP_VERIFY_TOKEN: Joi.string().allow('', null),

    // ── Credential encryption (encrypt-at-rest for provider secrets) ──────
    // 32 bytes, base64 or hex: `openssl rand -base64 32`. Optional so the app
    // boots without it, but EncryptionService throws on any encrypt/decrypt of
    // a real secret while it is unset — an unset key cannot silently downgrade
    // storage back to plaintext.
    CREDENTIALS_ENCRYPTION_KEY: Joi.string().allow('', null),

    // ── AI / OpenAI + pgvector RAG ────────────────────────────────────────
    // All optional: with no key the AI falls back to the Noop provider and RAG
    // degrades to keyword search, so the app still boots & runs.
    OPENAI_API_KEY: Joi.string().allow('', null),
    OPENAI_CHAT_MODEL: Joi.string().default('gpt-4o'),
    OPENAI_EMBEDDING_MODEL: Joi.string().default('text-embedding-3-small'),
    // Must match the vector(N) column dimension created by the pgvector bootstrap.
    OPENAI_EMBEDDING_DIM: Joi.number().default(1536),
    RAG_TOP_K: Joi.number().default(5),
    // HNSW query-time recall/latency knob (higher = better recall, slower).
    HNSW_EF_SEARCH: Joi.number().default(60),
    // Toggle to create/use the pgvector sidecar. If false (or extension missing),
    // RAG uses keyword fallback.
    AI_PGVECTOR_ENABLED: Joi.string().valid('true', 'false').default('true'),

    // ── Cloudflare R2 object storage (S3-compatible, PRIVATE bucket) ──────
    // Tenant verification documents (and any other private files) live here.
    // Optional in the schema so the app boots without storage configured, BUT
    // the /uploads routes fail CLOSED with 503 until all four are present.
    // R2_PUBLIC_URL is unused for private buckets and kept only for parity.
    R2_ACCOUNT_ID: Joi.string().allow('', null),
    R2_ACCESS_KEY_ID: Joi.string().allow('', null),
    R2_SECRET_ACCESS_KEY: Joi.string().allow('', null),
    R2_BUCKET: Joi.string().allow('', null),
    // R2 is region-agnostic; the SDK requires a region string — 'auto' is correct.
    R2_REGION: Joi.string().default('auto'),
    // Unused for private buckets (we serve signed URLs). Kept for parity.
    R2_PUBLIC_BASE_URL: Joi.string().allow('', null),
    // Per-file upload cap in bytes (default 10 MB). Enforced by the multer
    // interceptor and re-checked in the controller.
    UPLOAD_MAX_BYTES: Joi.number().min(1).default(10 * 1024 * 1024),
    // Signed-URL lifetime (seconds) for private object reads (default 5 min).
    SIGNED_URL_EXPIRES_SECONDS: Joi.number().min(30).default(300),
  });

  const { error, value } = schema.validate(config, {
    allowUnknown: true,
    abortEarly: false,
  });

  if (error) {
    throw new Error(
      `❌ Env validation error: ${error.message}`,
    );
  }

  return value;
};