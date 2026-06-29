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

    // ── WhatsApp Cloud API / Meta (PLATFORM-level shared number) ──────────
    // Optional in the schema so the app boots without a live integration, BUT:
    //   • the webhook verifier fails CLOSED at request time if
    //     WHATSAPP_APP_SECRET / WHATSAPP_VERIFY_TOKEN are unset (no dev bypass);
    //   • the message router only falls back to the env PLATFORM number when
    //     WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN are present.
    // A clinic's own (CUSTOM) number lives on the WhatsappAccount entity instead.
    WHATSAPP_APP_SECRET: Joi.string().allow('', null),
    WHATSAPP_VERIFY_TOKEN: Joi.string().allow('', null),
    WHATSAPP_ACCESS_TOKEN: Joi.string().allow('', null),
    WHATSAPP_PHONE_NUMBER_ID: Joi.string().allow('', null),
    WHATSAPP_WABA_ID: Joi.string().allow('', null),

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