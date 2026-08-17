import * as Joi from 'joi';

export const validate = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),

    DATABASE_URL: Joi.string().required(),

    TYPEORM_SYNCHRONIZE: Joi.string().valid('true', 'false').default('false'),

    TYPEORM_LOGGING: Joi.string().valid('true', 'false').default('false'),

    // Default 15 (raised from 10 — Phase 0 correction, measured; see
    // docs/CACHING_QUEUES_AUDIT.md §0.3). Each deployment (API, critical
    // worker, dispatch worker — see WORKER_ROLE below) may override this
    // independently via its own env.
    DB_POOL_MAX: Joi.number().default(15),
    DB_POOL_MIN: Joi.number().default(1),
    DB_POOL_IDLE_TIMEOUT: Joi.number().default(30000),
    // Role-specific pool overrides (gap-closure pass — see
    // docs/CACHING_QUEUES_AUDIT.md §0.8.6). Optional, no default: when unset,
    // typeOrmFactory falls back to DB_POOL_MAX so an existing deployment that
    // only sets DB_POOL_MAX is unaffected. Set these instead once the API and
    // worker are separate deployments needing independently-sized pools.
    API_DB_POOL_MAX: Joi.number(),
    WORKER_DB_POOL_MAX: Joi.number(),

    // ── API process-level scaling (PERF-INFRA-003) ─────────────────────────
    // How many OS processes the API entrypoint forks via Node's built-in
    // `cluster` module (src/cluster-bootstrap.ts). Default 1 = byte-identical
    // to pre-PERF-INFRA-003 behaviour (no fork; the process IS the app), so
    // no existing deployment is affected unless this is set explicitly. Safe
    // to raise for the API specifically: BullMQ `@Processor`s and the
    // repeatable-job registrar (ScheduleRegistrarService) live only in
    // WorkerModule/worker.ts, never here, so forking the API cannot duplicate
    // job consumption or cron/schedule registration. Each forked worker opens
    // its OWN DB pool sized by API_DB_POOL_MAX/DB_POOL_MAX above — raising
    // this multiplies the API's total DB connection footprint by the same
    // factor; size API_DB_POOL_MAX (and check Postgres's own
    // max_connections) accordingly — cluster-bootstrap.ts logs the resulting
    // estimate at boot. Capped at 8 as a sanity bound against a typo
    // exhausting the DB, not a measured ceiling. See
    // docs/PERFORMANCE_INFRASTRUCTURE.md's PERF-INFRA-003 section for the
    // measured evidence this is based on.
    API_CLUSTER_WORKERS: Joi.number().integer().min(1).max(8).default(1),

    // Redis / BullMQ. REQUIRED — the @Global QueueModule constructs
    // `ProducerQueues` (which throws without a REDIS_URL) unconditionally in
    // BOTH process roots (API and worker), so there has never actually been a
    // "queues disabled" boot mode; the schema previously allowed an empty value
    // and claimed otherwise, which just moved the failure from a clear startup
    // validation error to a confusing runtime one. Made required here so a
    // misconfigured deployment fails at boot, not on the first request.
    REDIS_URL: Joi.string().required(),
    // Escape hatch for AppRedisService's production boot-time enforcement of
    // maxmemory-policy=noeviction + a real maxmemory ceiling (gap-closure pass
    // — see docs/CACHING_QUEUES_AUDIT.md §0.8.9). Default false = ENFORCE (the
    // app refuses to boot in production against an unsafe Redis); set true
    // only when an operator has a deliberate, reviewed reason to accept an
    // UNSAFE config outright. For "CONFIG GET is unavailable but the config
    // IS actually safe" (a managed Redis provider with the command disabled),
    // use REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC instead — conflating the two
    // under this one flag is exactly what §0.11 fixed.
    REDIS_ALLOW_UNSAFE_MEMORY_CONFIG: Joi.string()
      .valid('true', 'false')
      .default('false'),
    // Operator attestation for AppRedisService when `CONFIG GET` itself is
    // blocked (gap-closure pass — see docs/CACHING_QUEUES_AUDIT.md §0.11):
    // some managed Redis providers disable CONFIG GET for non-admin users, so
    // the maxmemory-policy/ceiling check cannot run AT ALL. Default false
    // means that case now FAILS BOOT in production rather than silently
    // treating "couldn't check" as "checked and fine". Set true only after
    // verifying maxmemory-policy=noeviction and a real maxmemory ceiling some
    // OTHER way — the provider's own console, or Terraform/CloudFormation/IaC
    // output — so skipping the runtime check is a recorded decision.
    REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC: Joi.string()
      .valid('true', 'false')
      .default('false'),
    QUEUE_DEFAULT_ATTEMPTS: Joi.number().default(5),
    QUEUE_BACKOFF_MS: Joi.number().default(3000),
    WORKER_CONCURRENCY: Joi.number().default(5),
    // Which processors this worker PROCESS registers (see
    // queue/queue.constants.ts `resolveWorkerRole`/`queuesForRole`). Default
    // `all` is unchanged from pre-Phase-0 behaviour — every processor in one
    // process. Set to `critical`/`dispatch` only when running the campaign
    // recipient-dispatch hot path as its own deployment (see
    // docs/CACHING_QUEUES_AUDIT.md §0.3/§0.5).
    WORKER_ROLE: Joi.string()
      .valid('all', 'critical', 'dispatch')
      .default('all'),
    CAMPAIGN_DISPATCH_CONCURRENCY: Joi.number().default(25),

    // ── Analytics read cache (Redis) ──────────────────────────────────────
    // Uses REDIS_URL on a dedicated connection. Set ANALYTICS_CACHE_ENABLED=false
    // to explicitly opt out; on any Redis error at runtime, analytics reads
    // still fail open to the database (no behavior change). TTL is in seconds.
    ANALYTICS_CACHE_ENABLED: Joi.string()
      .valid('true', 'false')
      .default('true'),
    ANALYTICS_CACHE_TTL: Joi.number().default(60),
    // Raw analytics_events older than this are purged by the daily retention
    // sweep. Floored at 1 day so a 0/negative value can't purge the whole table.
    ANALYTICS_EVENT_RETENTION_DAYS: Joi.number().min(1).default(90),

    // AI-008 (FR-029a-e): attempt-only ai_tool_calls rows (denials, refusals,
    // and the 7 session-state public-booking tool records) older than this
    // are purged by the AI-tool-call retention sweep. Executed business-action
    // rows are NEVER subject to this window (FR-029a) — unaffected by this
    // key entirely. Same default as ANALYTICS_EVENT_RETENTION_DAYS so the two
    // do not drift for no reason (R5); floored at 1 day for the same reason.
    AI_TOOL_CALL_RETENTION_DAYS: Joi.number().min(1).default(90),

    // FND-031: how long a PAST_DUE ("expired-in-grace") subscription keeps its
    // full, unchanged capabilities before becoming GRACE_EXPIRED (new billable/
    // usage-increasing actions refused; reads stay available regardless).
    // Floored at 1 day so an unset/zero value can never mean "no grace at
    // all" (FR-B007g — configurable, never hardcoded, and never silently zero).
    SUBSCRIPTION_GRACE_DAYS: Joi.number().min(1).default(14),

    JWT_ACCESS_SECRET: Joi.string().required(),
    JWT_REFRESH_SECRET: Joi.string().required(),

    JWT_ACCESS_TTL: Joi.string().default('15m'),
    JWT_REFRESH_TTL: Joi.string().default('7d'),

    // ── Password-reset token exposure (FND-006 remediation) ────────────────
    // The raw reset token must NEVER appear in the forgotPassword HTTP
    // response — see auth.service.ts. This flag gates a LOCAL-DEVELOPMENT-ONLY
    // fallback that logs the token instead (never the response), for a
    // developer with no mail transport configured. Off by default. The
    // production fail-fast below (mirroring the payments fail-fast pattern)
    // makes enabling it in production a boot-time error, not a runtime risk.
    AUTH_EXPOSE_RESET_TOKEN: Joi.string()
      .valid('true', 'false')
      .default('false'),

    // ── API documentation gating (ZT-001) ──────────────────────────────────
    // Two FULLY INDEPENDENT switches — neither may default from, or be
    // derived from, the other (contracts/api-documentation.md). No static
    // `.default()` here: the resolved default is NODE_ENV-conditional
    // (production ⇒ false, otherwise ⇒ true), applied below after schema
    // validation, matching this file's existing idiom for environment-
    // dependent behaviour (the fail-fast blocks further down) rather than
    // introducing a `.when()`-based second validation style.
    ENABLE_API_DOCS: Joi.string().valid('true', 'false'),
    ENABLE_INTEGRATION_DOCS: Joi.string().valid('true', 'false'),

    // ── Security-relevant configuration validation (ZT-005) ────────────────
    // These five predate the schema-hardening pass that added the production
    // fail-fasts above and were never retrofitted — `allowUnknown: true`
    // (below) let each through unchecked, so a typo produced a silently
    // wrong security posture instead of a failed start. No value is ever
    // echoed by any error this section produces — names only.
    //
    // Cross-origin allow-list (main.ts:78-83) — comma-separated URI list.
    // Required in production below (post-validation, matching this file's
    // existing fail-fast idiom): main.ts currently falls back to
    // `http://localhost:3000` when unset, which is the silently-wrong
    // condition this finding exists to remove. No default here in the
    // schema itself — dev/test keep the file's own fallback unchanged.
    FRONTEND_ORIGIN: Joi.string().custom((value: string, helpers) => {
      const origins = value
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (origins.length === 0) return helpers.error('any.invalid');
      for (const origin of origins) {
        try {
          new URL(origin);
        } catch {
          return helpers.error('any.invalid');
        }
      }
      return value;
    }, 'comma-separated URI list'),

    // Cookie same-site attribute (cookie.service.ts:39-44). No schema
    // default — the service's own `'lax'` fallback is unchanged for every
    // environment that leaves this unset.
    COOKIE_SAMESITE: Joi.string().valid('lax', 'strict', 'none'),

    // Cookie scope (cookie.service.ts:46-48) — optional hostname; unset
    // means host-only cookies, the existing default.
    COOKIE_DOMAIN: Joi.string().hostname(),

    // Password-reset token lifetime, minutes (auth.service.ts:577). A
    // simple static default (unlike the two above) — matches the file's
    // existing plain `.default()` idiom, and is byte-identical to the
    // consuming code's own `, 30` fallback.
    PASSWORD_RESET_TTL_MIN: Joi.number().integer().min(5).max(1440).default(30),

    // Startup-seeding switch (seed/bootstrap-seeder.service.ts:30-32).
    // Validated as boolean-valued, but deliberately NOT defaulted here:
    // the seeder is idempotent and this is a hygiene gap already
    // investigated and rejected as a security finding (frozen baseline §6
    // #18), so this feature only adds the missing validation — it does not
    // change the service's own existing `'true'` default, which the
    // approved plan frames as merely "worth considering" (data-model.md),
    // not a required behaviour change.
    SEED_ON_STARTUP: Joi.string().valid('true', 'false'),

    // ── Database TLS trust anchor (ZT-012) ──────────────────────────────────
    // Validated for PRESENCE AND SHAPE ONLY — content is never inspected,
    // logged or echoed anywhere (Constitution XXIX). Alternatives, not a
    // pair: some platforms mount a CA file, others inject it as an env
    // value. Exactly one is required in production (post-validation check
    // below, alongside the "exactly one" — not both — constraint); optional
    // outside production, where the database connection stays unencrypted
    // SSL-wise (`ssl: false`, unchanged).
    DB_SSL_CA: Joi.string().min(1),
    DB_SSL_CA_CERT: Joi.string().min(1),

    // ── Account-aware login brute-force protection (FND-008 remediation) ───
    // Consecutive-failure threshold and protection-window TTL for
    // LoginProtectionService. Floored at 1 so a 0/negative value is a boot
    // failure rather than a silently disabled control or a zero-TTL key.
    AUTH_LOGIN_MAX_FAILED_ATTEMPTS: Joi.number().integer().min(1).default(5),
    AUTH_LOGIN_LOCKOUT_TTL_SECONDS: Joi.number().integer().min(1).default(900),

    // ── Authentication abuse resistance (009-auth-abuse-resistance) ───────
    // Endpoint-specific bounds for the three public recovery/registration
    // routes (ZT-006) plus the shared bounded degraded-mode fallback (ZT-002).
    // Named constants for scope/namespace live in
    // src/modules/auth/auth-abuse.constants.ts — no magic value in a service.
    AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW: Joi.number().integer().min(1).default(5),
    AUTH_FORGOT_PASSWORD_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(60)
      .max(86400)
      .default(900),
    AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT: Joi.number().integer().min(1).default(10),
    AUTH_RESET_PASSWORD_INVALID_CEILING: Joi.number().integer().min(1).default(100),
    AUTH_RESET_PASSWORD_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(60)
      .max(86400)
      .default(900),
    AUTH_REGISTER_OWNER_MAX_PER_IDENTITY: Joi.number().integer().min(1).default(3),
    // No `.default()` here on purpose — production-required, enforced by the
    // fail-fast below (mirrors the FRONTEND_ORIGIN pattern from 008). Sizing
    // this depends on real signup volume, which no registration-rate
    // telemetry in either repository can supply, so guessing a production
    // default here is exactly the condition that fail-fast removes.
    AUTH_REGISTER_OWNER_ENDPOINT_CEILING: Joi.number().integer().min(1),
    AUTH_REGISTER_OWNER_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(60)
      .max(86400)
      .default(3600),
    // Multiplier applied to every healthy-mode limit while the shared store
    // is degraded — one value rather than a parallel `*_DEGRADED` variable
    // per limiter, since the policy ("stricter than or equal") is uniform.
    AUTH_ABUSE_DEGRADED_FACTOR: Joi.number().greater(0).max(1).default(0.5),
    // Fixes the bounded local fallback's memory ceiling: width of the hashed
    // counter table (BoundedLocalCounter). Memory is independent of key
    // cardinality; this only sizes the (small) false-positive rate.
    AUTH_ABUSE_FALLBACK_WIDTH: Joi.number().integer().min(256).max(65536).default(4096),

    // ── Payments / Moyasar (PLATFORM-level only) ──────────────────────────
    // PAYMENT_PROVIDER is the single, central gateway selection. In dev/test
    // the keys may stay unset (the factory falls back to the Noop provider so
    // the app boots and runs without a live integration); in PRODUCTION a real
    // provider with missing essential keys fails the boot — see the explicit
    // check after schema validation below.
    PAYMENT_PROVIDER: Joi.string().valid('moyasar', 'noop').default('moyasar'),
    MOYASAR_SECRET_KEY: Joi.string().allow('', null),
    MOYASAR_PUBLISHABLE_KEY: Joi.string().allow('', null),
    MOYASAR_WEBHOOK_SECRET: Joi.string().allow('', null),
    MOYASAR_API_BASE: Joi.string().allow('', null),
    // Split payments (Moyasar `splits`) require a commercial Marketplace /
    // Platforms contract + per-clinic recipient ids. OFF until enabled by
    // Moyasar — a technically-supported feature is never assumed active.
    MOYASAR_MARKETPLACE_ENABLED: Joi.string()
      .valid('true', 'false')
      .default('false'),

    // Marketplace platform commission frozen onto each payment at capture.
    // Both default to 0 (platform takes no cut) until a fee policy is set.
    PLATFORM_FEE_PERCENT: Joi.number().min(0).max(100).default(0),
    PLATFORM_FEE_FIXED: Joi.number().min(0).default(0),

    // Refund reaper (R2) sweep thresholds, minutes.
    REFUND_REAPER_STALE_MIN: Joi.number().min(1).default(10),
    REFUND_REAPER_HARDFAIL_MIN: Joi.number().min(1).default(120),
    // Payment reconciliation sweep thresholds, minutes (stale PENDING payments
    // re-verified against the gateway; hard threshold pages an operator).
    PAYMENTS_RECON_STALE_MIN: Joi.number().min(1).default(15),
    PAYMENTS_RECON_HARDFAIL_MIN: Joi.number().min(1).default(240),

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

    // ── Localization (CAP-I18N) ────────────────────────────────────────────
    // Platform-wide default locale (AD-09 step 4: the last fallback in the
    // frontend's URL segment -> cookie -> Accept-Language -> default resolution
    // order) — constrained to the supported-locale set, unlike the looser
    // free-form EMAIL_DEFAULT_LOCALE above. Backend-rendered content (T156)
    // reads this the same way EMAIL_DEFAULT_LOCALE is read; no second locale
    // mechanism is introduced (LR-003).
    DEFAULT_LOCALE: Joi.string().valid('en', 'ar').default('en'),

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
    // 32 bytes, base64 or hex: `openssl rand -base64 32`. Optional here
    // (dev/test boot without it; EncryptionService throws on any
    // encrypt/decrypt of a real secret while it is unset, so an unset key
    // cannot silently downgrade storage back to plaintext) but REQUIRED in
    // production — see the fail-fast check below (HRD-001).
    CREDENTIALS_ENCRYPTION_KEY: Joi.string().allow('', null),

    // ── AI / OpenAI + pgvector RAG ────────────────────────────────────────
    // All optional: with no key the AI falls back to the Noop provider and RAG
    // degrades to keyword search, so the app still boots & runs.
    OPENAI_API_KEY: Joi.string().allow('', null),
    OPENAI_CHAT_MODEL: Joi.string().default('gpt-4o'),
    OPENAI_EMBEDDING_MODEL: Joi.string().default('text-embedding-3-small'),
    // Must match the vector(N) column dimension created by the pgvector bootstrap.
    OPENAI_EMBEDDING_DIM: Joi.number().default(1536),
    OPENAI_REQUEST_TIMEOUT_MS: Joi.number()
      .integer()
      .min(1000)
      .max(120000)
      .default(30000),
    OPENAI_PROVIDER_MAX_RETRIES: Joi.number()
      .integer()
      .min(0)
      .max(3)
      .default(2),
    OPENAI_RETRY_BASE_MS: Joi.number()
      .integer()
      .min(50)
      .max(10000)
      .default(500),
    AI_PRICE_CATALOG_JSON: Joi.string().allow('', null),
    AI_PROMPT_SYSTEM_TOKENS: Joi.number().integer().min(128).default(2000),
    AI_PROMPT_HISTORY_TOKENS: Joi.number().integer().min(128).default(5000),
    AI_PROMPT_RAG_TOKENS: Joi.number().integer().min(0).default(2500),
    AI_PROMPT_MEMORY_TOKENS: Joi.number().integer().min(0).default(800),
    AI_PROMPT_TOOL_OUTPUT_TOKENS: Joi.number().integer().min(64).default(1200),
    AI_PROMPT_TOOL_SCHEMA_TOKENS: Joi.number().integer().min(128).default(6000),
    AI_PROMPT_MAX_INPUT_TOKENS: Joi.number().integer().min(512).default(12000),
    AI_PROMPT_MAX_OUTPUT_TOKENS: Joi.number().integer().min(64).default(800),
    AI_MODEL_CONTEXT_WINDOW_TOKENS: Joi.number()
      .integer()
      .min(1024)
      .default(16384),
    AI_MEMORY_RECALL_ENABLED: Joi.string()
      .valid('true', 'false')
      .default('false'),
    AI_EMBEDDING_CACHE_ENABLED: Joi.string()
      .valid('true', 'false')
      .default('true'),
    AI_EMBEDDING_QUERY_CACHE_TTL_SECONDS: Joi.number()
      .integer()
      .min(60)
      .default(86400),
    AI_EMBEDDING_CONTENT_CACHE_TTL_SECONDS: Joi.number()
      .integer()
      .min(60)
      .default(2592000),
    AI_EMBEDDING_VERSION: Joi.string().default('v1'),
    AI_MODEL_ROUTING_ENABLED: Joi.string()
      .valid('true', 'false')
      .default('false'),
    AI_MODEL_ROUTING_ROLLOUT_PERCENT: Joi.number()
      .integer()
      .min(0)
      .max(100)
      .default(0),
    AI_ECONOMY_MODEL: Joi.string().default('gpt-4.1-mini'),
    AI_POWERFUL_MODEL: Joi.string().allow('', null),
    AI_POWERFUL_FEATURES: Joi.string().allow('').default(''),
    AI_POWERFUL_ROUTES: Joi.string().allow('').default(''),
    AI_TRAINING_FILE_MAX_BYTES: Joi.number()
      .integer()
      .min(1024)
      .default(10 * 1024 * 1024),

    // ── AI execution mode: Standard vs Batch (OpenAI Batch API) ───────────
    // Master switch for the async BATCH execution mode. Default OFF: with it
    // off, every feature runs on the synchronous STANDARD path exactly as
    // before (fully revertable). The frontend/user can NEVER select the mode —
    // it is derived server-side from the feature (AiExecutionPolicyService).
    AI_BATCH_ENABLED: Joi.string().valid('true', 'false').default('false'),
    // Chunk count at/above which file indexing prefers the BATCH route. Small
    // files stay on the synchronous embedding path for immediate indexing.
    AI_BATCH_EMBEDDING_CHUNK_THRESHOLD: Joi.number()
      .integer()
      .min(1)
      .default(200),
    // OpenAI Batch completion window (only '24h' is currently supported).
    AI_BATCH_COMPLETION_WINDOW: Joi.string().default('24h'),
    // Cron cadence for the batch-status poll sweep (worker).
    AI_BATCH_POLL_CRON: Joi.string().default('*/5 * * * *'),
    // Submission lease: how long one worker exclusively owns a job's submission
    // (blocks a concurrent submit/reconcile from creating a duplicate remote
    // batch). Aligned with the reconcile grace so a crashed submit is retried
    // only after the lease expires.
    AI_BATCH_SUBMIT_LEASE_SECONDS: Joi.number().integer().min(10).default(120),
    // Max chunks a single workload may embed SYNCHRONOUSLY when batch is disabled.
    AI_STANDARD_MAX_EMBED_CHUNKS: Joi.number().integer().min(1).default(512),
    // Submission reconciliation: grace before revisiting a stuck submission, and
    // the max reconcile attempts before a job is left FAILED (manual-recovery-safe).
    AI_BATCH_SUBMIT_RECONCILE_GRACE_SECONDS: Joi.number()
      .integer()
      .min(10)
      .default(120),
    AI_BATCH_SUBMIT_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
    // Polling: page size per sweep, lease window (concurrency), backoff bounds,
    // and the max age after which a non-terminal job is expired.
    AI_BATCH_POLL_PAGE_SIZE: Joi.number().integer().min(1).max(500).default(25),
    AI_BATCH_POLL_LEASE_SECONDS: Joi.number().integer().min(5).default(60),
    AI_BATCH_POLL_BACKOFF_BASE_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(30),
    AI_BATCH_POLL_BACKOFF_MAX_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(900),
    AI_BATCH_MAX_AGE_HOURS: Joi.number().integer().min(1).default(26),
    // Grace before the reconciler finalizes a training file left in PROCESSING.
    AI_TRAINING_FINALIZE_GRACE_MINUTES: Joi.number()
      .integer()
      .min(0)
      .default(1),

    // ── AI Data Residency (compliance policy — OFF by default) ────────────
    // Master switch for per-tenant regional OpenAI deployments. Default OFF: no
    // tenant deployment is consulted and the global client is used. When ON,
    // a tenant whose deployment is enabled but unavailable FAILS CLOSED — the
    // request is never silently redirected to the global region. Enabling this
    // does NOT assert that data stays in any particular country.
    AI_DATA_RESIDENCY_ENABLED: Joi.string()
      .valid('true', 'false')
      .default('false'),

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
    UPLOAD_MAX_BYTES: Joi.number()
      .min(1)
      .default(10 * 1024 * 1024),
    // Signed-URL lifetime (seconds) for private object reads (default 5 min).
    SIGNED_URL_EXPIRES_SECONDS: Joi.number().min(30).default(300),

    // ── External integration API (read-only, API-key authenticated) ──────
    // Per-key token-bucket ceiling (ApiKeyAuthGuard, reusing the existing
    // Redis rate limiter). Redis-unavailable fails OPEN (see the guard's
    // docstring) — this is a courtesy limit, not the sole abuse defense.
    INTEGRATION_API_RATE_LIMIT_PER_MINUTE: Joi.number()
      .integer()
      .min(1)
      .default(120),

    // ── Outbound webhooks (Phase 2 — Integration platform) ───────────────
    WEBHOOK_DELIVERY_TIMEOUT_MS: Joi.number()
      .integer()
      .min(1000)
      .default(10_000),
    WEBHOOK_DELIVERY_MAX_ATTEMPTS: Joi.number().integer().min(1).default(6),
    WEBHOOK_DELIVERY_BACKOFF_MS: Joi.number().integer().min(100).default(5000),

    // ── Observability (gap-closure — see docs/CACHING_QUEUES_AUDIT.md M14) ──
    // Static bearer token a Prometheus scraper presents to GET /metrics — a
    // scraper has no tenant/user JWT, so this is deliberately independent of
    // the business auth stack, matching every other infra-scrape convention
    // (e.g. a `bearer_token` scrape config). Required in production; in
    // dev/test an unset token means the endpoint is open (matches this
    // repo's existing "unconfigured secret ⇒ dev-only warning, not a hard
    // failure" convention for e.g. MOYASAR_WEBHOOK_SECRET).
    METRICS_TOKEN: Joi.string().allow('', null),
    // Worker process only — the API exposes GET /metrics on its normal HTTP
    // port via MetricsController; the worker has no HTTP adapter at all (see
    // worker.ts), so it needs its OWN small listener on its own port.
    WORKER_METRICS_PORT: Joi.number().integer().min(1).default(9091),
  });

  const { error, value } = schema.validate(config, {
    allowUnknown: true,
    abortEarly: false,
  });

  if (error) {
    throw new Error(`❌ Env validation error: ${error.message}`);
  }

  // ── API documentation gating defaults (ZT-001) ────────────────────────────
  // Resolved independently — each only defaults when genuinely unset, never
  // from the other's value. Production defaults both to disabled (the fix:
  // the internal document alone was serving 499 paths, unauthenticated, on
  // every boot); non-production defaults both to enabled, preserving the
  // existing developer/partner-onboarding workflow exactly.
  if (value.ENABLE_API_DOCS === undefined) {
    value.ENABLE_API_DOCS = value.NODE_ENV === 'production' ? 'false' : 'true';
  }
  if (value.ENABLE_INTEGRATION_DOCS === undefined) {
    value.ENABLE_INTEGRATION_DOCS =
      value.NODE_ENV === 'production' ? 'false' : 'true';
  }

  // ── Configuration fail-fasts (production only, ZT-005) ────────────────────
  // Mirrors the payments fail-fast pattern below. Downgrading any of these to
  // a warning is explicitly rejected — it recreates precisely the
  // silently-wrong condition this finding exists to remove. Deployment note:
  // this is a boot-behaviour change — an environment currently riding the
  // `main.ts:79` `http://localhost:3000` default will refuse to start the
  // moment this ships (plan.md § Deployment Hazards; gated on reading the
  // deployed value first).
  if (
    value.NODE_ENV === 'production' &&
    !String(value.FRONTEND_ORIGIN ?? '').trim()
  ) {
    throw new Error(
      `❌ Env validation error: FRONTEND_ORIGIN is not set. Production cannot ` +
        `boot without an explicit cross-origin allow-list — silently falling ` +
        `back to a development origin is the condition this check removes. ` +
        `Set FRONTEND_ORIGIN to a comma-separated list of allowed origins.`,
    );
  }

  // `SameSite=None` without `Secure` is a combination modern browsers reject
  // outright, so accepting it silently produces an authentication outage
  // that presents as an unexplained application bug. `secure` (cookie
  // .service.ts) is `true` exactly when `NODE_ENV === 'production'` and
  // `false` otherwise — so the only way `none` can be paired with a
  // non-secure cookie is outside production, which is where this check
  // applies, converting that outage into a startup error instead.
  if (value.COOKIE_SAMESITE === 'none' && value.NODE_ENV !== 'production') {
    throw new Error(
      `❌ Env validation error: COOKIE_SAMESITE is "none" but NODE_ENV is not ` +
        `"production", so cookies would be issued without the Secure attribute. ` +
        `Browsers reject SameSite=None without Secure outright. Use "lax" or ` +
        `"strict" outside production, or run with NODE_ENV=production.`,
    );
  }

  // ── Database TLS trust anchor fail-fast (production only, ZT-012) ─────────
  // Exactly one of the two forms — never both (ambiguous: which one is
  // actually in effect?), never neither (the silent-`rejectUnauthorized:
  // false` condition this finding removes). Certificate CONTENT is never
  // inspected here — presence only.
  if (value.NODE_ENV === 'production') {
    const hasCaPath = !!String(value.DB_SSL_CA ?? '').trim();
    const hasCaCert = !!String(value.DB_SSL_CA_CERT ?? '').trim();
    if (!hasCaPath && !hasCaCert) {
      throw new Error(
        `❌ Env validation error: production requires exactly one of DB_SSL_CA ` +
          `or DB_SSL_CA_CERT to be set. Database TLS must validate the server ` +
          `certificate — refusing to silently accept any certificate.`,
      );
    }
    if (hasCaPath && hasCaCert) {
      throw new Error(
        `❌ Env validation error: both DB_SSL_CA and DB_SSL_CA_CERT are set. ` +
          `They are alternatives, not a pair — set exactly one so which trust ` +
          `anchor is actually in effect is unambiguous.`,
      );
    }
  }

  // ── Payments fail-fast (production only) ─────────────────────────────────
  // A real gateway with missing essential credentials must never boot in
  // production: the factory would fall back to the Noop provider, which
  // SIMULATES successful payments — silently faking revenue. Dev/test keep the
  // keyless Noop flow. The message names only the missing VARIABLES, never
  // values. Opting out is explicit: PAYMENT_PROVIDER=noop.
  if (value.NODE_ENV === 'production' && value.PAYMENT_PROVIDER !== 'noop') {
    const missing: string[] = [];
    if (!String(value.MOYASAR_SECRET_KEY ?? '').trim())
      missing.push('MOYASAR_SECRET_KEY');
    if (!String(value.MOYASAR_WEBHOOK_SECRET ?? '').trim())
      missing.push('MOYASAR_WEBHOOK_SECRET');
    if (missing.length > 0) {
      throw new Error(
        `❌ Env validation error: PAYMENT_PROVIDER is "${value.PAYMENT_PROVIDER}" but ` +
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
          `Payments cannot run in production without gateway credentials. ` +
          `Set the missing variable(s), or set PAYMENT_PROVIDER=noop to explicitly disable live payments.`,
      );
    }
  }

  // ── Credential-encryption fail-fast (production only, HRD-001) ────────────
  // Mirrors the payments fail-fast above (the reference pattern constitution
  // XXIX names). Without this key, provider credentials (WhatsApp/OAuth
  // tokens) cannot be encrypted at rest, and EncryptionService today only
  // throws at first USE (encrypt/decrypt call) — long after the platform is
  // already serving traffic. Refusing to boot is the stronger, earlier
  // contract. The 32-byte decode check mirrors EncryptionService.loadKey()
  // (single source of truth for the format), duplicated here so the earliest
  // possible boot phase — Joi validation, before any provider is constructed
  // — already enforces it. The message names ONLY the variable, never a value.
  if (value.NODE_ENV === 'production') {
    const key = String(value.CREDENTIALS_ENCRYPTION_KEY ?? '').trim();
    if (!key) {
      throw new Error(
        `❌ Env validation error: CREDENTIALS_ENCRYPTION_KEY is not set. ` +
          `Production cannot boot without it — provider credentials would have ` +
          `no way to be encrypted at rest. Set CREDENTIALS_ENCRYPTION_KEY to a ` +
          `32-byte base64 or hex key (openssl rand -base64 32).`,
      );
    }
    const decoded = /^[0-9a-fA-F]{64}$/.test(key)
      ? Buffer.from(key, 'hex')
      : Buffer.from(key, 'base64');
    if (decoded.length !== 32) {
      throw new Error(
        `❌ Env validation error: CREDENTIALS_ENCRYPTION_KEY must decode to ` +
          `exactly 32 bytes (got ${decoded.length}). Generate one with: ` +
          `openssl rand -base64 32`,
      );
    }
  }

  // ── Meta app config fail-fast (production only, HRD-002) ──────────────────
  // Meta/WhatsApp stays legitimately OPTIONAL in production (not every
  // deployment uses it — same reasoning FND-035/AD-08 established for AI, not
  // the unconditional payments/HRD-001 pattern). What must fail fast is a
  // PARTIAL configuration: an operator midway through setup, or a rotated/
  // dropped variable, would otherwise silently leave the webhook signature
  // pair or Embedded Signup half-configured with no boot-time signal. Mirrors
  // `MetaConfig.embeddedSignupConfigured`'s existing "appId + configId +
  // appSecret" definition of configured, extended with `webhookVerifyToken`
  // (the signature pair's other half — MetaConfig.webhookVerifyToken). The
  // legacy WHATSAPP_APP_SECRET/WHATSAPP_VERIFY_TOKEN aliases count too,
  // exactly as MetaConfig itself already honours them as a fallback. The
  // message names ONLY the missing variables, never values.
  {
    const metaAppId = String(value.META_APP_ID ?? '').trim();
    const metaAppSecret = String(
      value.META_APP_SECRET || value.WHATSAPP_APP_SECRET || '',
    ).trim();
    const metaConfigId = String(
      value.META_EMBEDDED_SIGNUP_CONFIG_ID ?? '',
    ).trim();
    const metaVerifyToken = String(
      value.META_WEBHOOK_VERIFY_TOKEN || value.WHATSAPP_VERIFY_TOKEN || '',
    ).trim();
    const anyMetaKeySet = !!(
      metaAppId ||
      metaAppSecret ||
      metaConfigId ||
      metaVerifyToken
    );

    if (value.NODE_ENV === 'production' && anyMetaKeySet) {
      const missing: string[] = [];
      if (!metaAppId) missing.push('META_APP_ID');
      if (!metaAppSecret) missing.push('META_APP_SECRET');
      if (!metaConfigId) missing.push('META_EMBEDDED_SIGNUP_CONFIG_ID');
      if (!metaVerifyToken) missing.push('META_WEBHOOK_VERIFY_TOKEN');
      if (missing.length > 0) {
        throw new Error(
          `❌ Env validation error: the platform Meta App config is partially set but ` +
            `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not. ` +
            `A partial Meta configuration leaves WhatsApp/Embedded Signup silently ` +
            `broken. Set the missing variable(s), or unset every META_*/WHATSAPP_* ` +
            `variable to explicitly leave WhatsApp disabled.`,
        );
      }
    }
  }

  // ── Register-owner endpoint ceiling (production-required, ZT-006) ─────────
  // Mirrors the FRONTEND_ORIGIN fail-fast above (ZT-005 precedent): no value
  // here is safe to guess, because no registration-rate telemetry exists in
  // either repository. Non-production gets a permissive default so dev/test
  // are never blocked; production refuses to boot until an operator sets it
  // explicitly from real expected signup volume — a loud, one-time decision
  // rather than a silently wrong ceiling in either direction.
  if (value.AUTH_REGISTER_OWNER_ENDPOINT_CEILING === undefined) {
    if (value.NODE_ENV === 'production') {
      throw new Error(
        `❌ Env validation error: AUTH_REGISTER_OWNER_ENDPOINT_CEILING is not ` +
          `set. Production cannot boot without an explicit endpoint-wide ` +
          `registration ceiling — this bounds bulk tenant creation by an ` +
          `attacker rotating email/slug/registration-number. Set it from real ` +
          `expected legitimate signup volume; do not guess.`,
      );
    }
    value.AUTH_REGISTER_OWNER_ENDPOINT_CEILING = 1000;
  }

  // ── Reset-token exposure fail-fast (production only) ──────────────────────
  // Mirrors the payments fail-fast above (the reference pattern for refusing
  // to boot on an insecure/simulated production configuration — FND-006). A
  // production process with the local-development token-logging channel
  // enabled must never start. The message names ONLY the variable, never a
  // value — there is no value to name here, since this is a boolean switch.
  if (
    value.NODE_ENV === 'production' &&
    value.AUTH_EXPOSE_RESET_TOKEN === 'true'
  ) {
    throw new Error(
      `❌ Env validation error: AUTH_EXPOSE_RESET_TOKEN is "true" but NODE_ENV is ` +
        `"production". This local-development-only reset-token exposure channel ` +
        `must never be enabled in production. Set AUTH_EXPOSE_RESET_TOKEN=false, ` +
        `or unset it entirely.`,
    );
  }

  return value;
};
