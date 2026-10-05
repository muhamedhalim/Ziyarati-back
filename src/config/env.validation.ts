import * as Joi from 'joi';

import {
  AI_MODEL_IDS_ALL,
  DEFAULT_AI_MODEL_ID,
  defaultModelForTier,
} from '../modules/ai/routing/ai-model-registry';
import { formatFromAddress } from '../modules/email/email.config';

export const validate = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),

    // HTTP listen port for the API process root (`main.ts`: `app.listen(port,
    // '0.0.0.0')`). The default here is byte-identical to main.ts's own
    // `process.env.PORT ?? 3000` fallback, so adding it changes no behaviour —
    // what it adds is a BOOT-TIME error on a non-numeric / out-of-range value,
    // instead of the opaque `ERR_SOCKET_BAD_PORT` a bad platform variable used
    // to produce after the whole DI graph had already been constructed.
    PORT: Joi.number().port().default(3000),

    DATABASE_URL: Joi.string().required(),

    TYPEORM_SYNCHRONIZE: Joi.string().valid('true', 'false').default('false'),

    // P0.3 RULE 3 / RULE 11.7, scoped P0.6 (SCHEMA-011). Waives the guard
    // that refuses to boot with synchronize on against a database the
    // migration chain provisioned (a non-empty `migrations` table). Only
    // reachable when TYPEORM_SYNCHRONIZE is already true, which production
    // refuses outright — so this can never widen production behaviour.
    //
    // P0.6: a bare `true` used to waive the guard for WHATEVER database
    // `DATABASE_URL` happened to name — a `.env` copied to, or a
    // `DATABASE_URL` repointed at, a staging/QA/restored-backup database
    // would silently inherit the waiver too. The value must now be the
    // TARGET DATABASE'S OWN NAME (see `assertSynchronizeIsSafeForTarget` in
    // `typeorm.config.ts`, which also requires a loopback host) — `'true'`
    // is rejected below, at validation time, before any DB connection is
    // even attempted.
    TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB: Joi.string()
      .allow('')
      .default('false'),

    // AI-011: raw SQL logging (parameter values included) writes tenant data
    // and secrets to console output. The production fail-fast below (mirroring
    // the AUTH_EXPOSE_RESET_TOKEN pattern) makes enabling this in production a
    // boot-time error, not a runtime risk. Unchanged outside production.
    TYPEORM_LOGGING: Joi.string().valid('true', 'false').default('false'),

    // Opt-IN escape hatch for the NODE_ENV=test override in typeorm.config.ts.
    // Without it, an inherited `TYPEORM_LOGGING=true` from a tracked `.env`
    // silently turns every test/load run into a measurement of the logger.
    TYPEORM_LOGGING_IN_TEST: Joi.string().valid('true', 'false'),

    // P0.3 SCHEMA-004 / RULE 5. When a REQUIRED DB-enforced integrity guard
    // could not be installed at boot, readiness always reports
    // status="degraded" with a count (never an object name — the route is
    // public). This escalates that to HTTP 503 for an orchestrator that
    // routes traffic on readiness and wants fail-closed behaviour. Default
    // false: pulling every instance out of rotation turns a missing index
    // into a total outage, which is not automatically the better trade.
    SCHEMA_GUARD_FAIL_READINESS: Joi.string()
      .valid('true', 'false')
      .default('false'),

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

    // P1.1 — OPTIONAL, purely informational. This application has no way to
    // read Postgres's own `max_connections` setting, so the boot-time
    // capacity estimate in cluster-bootstrap.ts falls back to a fixed
    // threshold guess when this is unset. Supplying the real value (`SHOW
    // max_connections;`, run by an operator — read-only) turns that guess
    // into a precise percentage. See
    // tests/load/reports/P1.1_CAPACITY_WORKSHEET.md.
    DB_MAX_CONNECTIONS: Joi.number().integer().min(10),

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

    // AI-023 (FR-048, R7): the maximum number of tool calls one provider
    // round-trip may fan out to, independent of MAX_TOOL_ITERATIONS
    // (ai-execution.service.ts — the outer bound on how many ROUNDS a turn
    // may take; unchanged, not replaced). A single round with an unbounded
    // toolCalls array let one provider response drive an arbitrarily large
    // amount of work (booking/reschedule/cancel calls, DB writes) before the
    // outer round bound ever had a chance to matter. Calls beyond this cap
    // are refused deterministically (FR-049), never silently dropped.
    AI_MAX_TOOL_CALLS_PER_ITERATION: Joi.number().min(1).default(10),

    // AI-014 (FR-059, R8): application-level bound on QueueService's AI-
    // specific enqueue producer (queue.service.ts:263) — the shared BullMQ
    // producer profile deliberately has NO commandTimeout (Phase 0
    // correction, redis.config.ts:54-65, left unchanged by this key). Long
    // enough that a brief Redis blip is still buffered (FR-061); short
    // enough that a sustained outage fails fast rather than hanging on
    // ioredis's own uncapped retryStrategy.
    AI_QUEUE_ENQUEUE_TIMEOUT_MS: Joi.number().min(100).default(8000),

    // AI-015/AI-028 (FR-051-FR-055, D5): the realtime (`ai:message`) turn
    // rate limit. Separate threshold + window per identity class — the
    // mechanism (this key pair existing and being enforced) is NOT blocked;
    // only the specific numeric values are, pending PD-4 (authenticated) and
    // PD-5 (guest, FR-055/FR-077). The defaults below are conservative
    // interim values, stated here and in the re-verification record as
    // PROVISIONAL — not a decided threshold — until PD-4/PD-5 land.
    AI_WS_RATE_LIMIT_AUTHENTICATED_MAX_TURNS: Joi.number().min(1).default(30),
    AI_WS_RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS: Joi.number()
      .min(1)
      .default(60),
    AI_WS_RATE_LIMIT_GUEST_MAX_TURNS: Joi.number().min(1).default(15),
    AI_WS_RATE_LIMIT_GUEST_WINDOW_SECONDS: Joi.number().min(1).default(60),

    // F-16 (audit 2026-09): abuse bounds beyond the per-identity limits above.
    // `min(0)` on all of them — 0 switches the bound off, the operator's escape
    // hatch. Values are sizing defaults, not policy; tune to real traffic.
    //  - GUEST_SOURCE: turns per network ADDRESS per window, across every guest
    //    identity that address mints. Only meaningful when the address the server
    //    sees is the visitor's — behind a proxy that does not forward it, every
    //    visitor shares one address, so size it for the whole site or set 0.
    //  - GUEST_DAILY_TURN_BUDGET: platform-wide anonymous turns per UTC day.
    //  - WHATSAPP_CONTACT_*: one patient number on one clinic's line.
    AI_WS_RATE_LIMIT_GUEST_SOURCE_MAX_TURNS: Joi.number().min(0).default(200),
    AI_WS_RATE_LIMIT_GUEST_SOURCE_WINDOW_SECONDS: Joi.number()
      .min(1)
      .default(600),
    AI_GUEST_DAILY_TURN_BUDGET: Joi.number().min(0).default(20000),
    AI_WHATSAPP_CONTACT_MAX_TURNS: Joi.number().min(0).default(20),
    AI_WHATSAPP_CONTACT_WINDOW_SECONDS: Joi.number().min(1).default(60),
    AI_WHATSAPP_CONTACT_DAILY_MAX_TURNS: Joi.number().min(0).default(300),

    // AI-009 (FR-044, FR-091, SD-1): output-side system-prompt/tool-schema
    // disclosure check — a local, dependency-free token-shingle overlap
    // ratio (never an embedding call or LLM judge — FR-092, FR-093,
    // Principle XXXIV). THRESHOLD is the overlap ratio (0-1) at or above
    // which a reply is treated as reproducing the source; justified by
    // T104's false-positive test (a compliant reproduction trips it, an
    // ordinary answer sharing incidental wording does not). SHINGLE_SPAN is
    // the ONLY window-size key — SD-1's streaming hold-back window `W` is
    // DERIVED from it in code (never a separate configured value, per this
    // task's own "do not add a third key where one derives from another").
    AI_PROMPT_SIMILARITY_THRESHOLD: Joi.number().min(0).max(1).default(0.6),
    AI_PROMPT_SIMILARITY_SHINGLE_SPAN: Joi.number().min(3).default(8),

    // FND-031: how long a PAST_DUE ("expired-in-grace") subscription keeps its
    // full, unchanged capabilities before becoming GRACE_EXPIRED (new billable/
    // usage-increasing actions refused; reads stay available regardless).
    // Floored at 1 day so an unset/zero value can never mean "no grace at
    // all" (FR-B007g — configurable, never hardcoded, and never silently zero).
    SUBSCRIPTION_GRACE_DAYS: Joi.number().min(1).default(14),

    // Free-access lifecycle notices (start + 48h expiry warning) rollout
    // kill switch. Defaults ON; set to 'false' to stop `grant()` from writing
    // a start-notice outbox row and stop the expiry sweep from claiming
    // anything — see FreeAccessNoticeService's docblock for why this exists
    // (deploy-order safety: the worker must know the job name before any API
    // instance starts enqueueing it).
    FREE_ACCESS_NOTICES_ENABLED: Joi.string().valid('true', 'false').default('true'),

    JWT_ACCESS_SECRET: Joi.string().required(),
    JWT_REFRESH_SECRET: Joi.string().required(),

    JWT_ACCESS_TTL: Joi.string().default('15m'),
    JWT_REFRESH_TTL: Joi.string().default('7d'),

    // Anonymous guest AI session (GuestSessionService). Same "ttl string, cookie
    // Max-Age derived from it via ttlToMs()" pattern as the two above — never a
    // separately hardcoded millisecond constant, so the JWT and its cookie can
    // never drift apart.
    GUEST_SESSION_TTL: Joi.string().default('1d'),

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

    // Contract C10 (Marketplace) — per-cookie override for the TWO anonymous
    // patient cookies only: `guest_token` (guest-chat.controller.ts) and
    // `booking_session_id` (public-booking.controller.ts). `CookieService`
    // (access_token/refresh_token/csrf_token, the STAFF session cookies) is
    // never touched by these — see that file's own docstring. Defaulting to
    // the existing global COOKIE_SAMESITE/COOKIE_DOMAIN values means no
    // current deployment changes behaviour until these are explicitly set.
    PUBLIC_COOKIE_SAMESITE: Joi.string().valid('lax', 'strict', 'none'),
    PUBLIC_COOKIE_DOMAIN: Joi.string().hostname(),

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

    // ── Refresh-token rotation (AUTH-001/002/003 remediation) ─────────────
    // The bounded retry window that lets a client whose refresh RESPONSE was
    // lost resume from the successor, without that looking like token theft.
    // Capped hard on every axis: this is not a grace period on the old token
    // (which stays revoked forever), and it must never become an unlimited
    // replay window. `max(60)` is a boot-time refusal to configure a
    // minute-long replay opportunity; 0 disables retries entirely (strict
    // one-shot rotation). `_MIN_AGE_MS` is the floor below which a duplicate
    // is classified as CONCURRENT — refused, revoking nothing — which is what
    // keeps "N concurrent refreshes rotate exactly once" true under load.
    // See AuthService.resolveRevokedToken.
    AUTH_REFRESH_RETRY_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(0)
      .max(60)
      .default(10),
    AUTH_REFRESH_MAX_RETRIES: Joi.number().integer().min(0).max(10).default(3),
    AUTH_REFRESH_RETRY_MIN_AGE_MS: Joi.number()
      .integer()
      .min(0)
      .max(10_000)
      .default(500),

    // ── Authentication token retention (AUTH-005 remediation) ─────────────
    // Days an ALREADY-EXPIRED refresh_tokens / password_resets row is kept
    // before the `platform.authTokenCleanup` sweep removes it. Floored at 1 so
    // the margin that keeps cleanup from racing an in-flight request (see
    // AuthTokenMaintenanceService) can never be configured away.
    AUTH_TOKEN_RETENTION_DAYS: Joi.number().integer().min(1).default(7),
    AUTH_TOKEN_CLEANUP_BATCH: Joi.number()
      .integer()
      .min(1)
      .max(50_000)
      .default(1000),
    AUTH_TOKEN_CLEANUP_MAX_BATCHES: Joi.number()
      .integer()
      .min(1)
      .max(1000)
      .default(20),

    // ── Authentication abuse resistance (009-auth-abuse-resistance) ───────
    // Endpoint-specific bounds for the three public recovery/registration
    // routes (ZT-006) plus the shared bounded degraded-mode fallback (ZT-002).
    // Named constants for scope/namespace live in
    // src/modules/auth/auth-abuse.constants.ts — no magic value in a service.
    AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW: Joi.number()
      .integer()
      .min(1)
      .default(5),
    AUTH_FORGOT_PASSWORD_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(60)
      .max(86400)
      .default(900),
    AUTH_RESET_PASSWORD_MAX_PER_ACCOUNT: Joi.number()
      .integer()
      .min(1)
      .default(10),
    AUTH_RESET_PASSWORD_INVALID_CEILING: Joi.number()
      .integer()
      .min(1)
      .default(100),
    AUTH_RESET_PASSWORD_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(60)
      .max(86400)
      .default(900),
    AUTH_REGISTER_OWNER_MAX_PER_IDENTITY: Joi.number()
      .integer()
      .min(1)
      .default(3),
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
    AUTH_ABUSE_FALLBACK_WIDTH: Joi.number()
      .integer()
      .min(256)
      .max(65536)
      .default(4096),

    // ── Client-address trust (SEC-02) ─────────────────────────────────────
    // Number of reverse-proxy hops Express may trust for `req.ip`. 0 keeps the
    // legacy behaviour (socket peer). 1 = trust exactly the AWS ALB, which
    // appends the true peer to X-Forwarded-For. Deliberately capped at 1: a
    // larger count would trust a caller-controlled header entry. See
    // src/config/trust-proxy.ts.
    TRUST_PROXY_HOPS: Joi.number().integer().valid(0, 1).default(0),
    // Optional shared secret proving a request came through the trusted edge
    // (Vercel rewrite). Unset = inert. Requires TRUST_PROXY_HOPS=1.
    EDGE_PROXY_TOKEN: Joi.string().min(32).max(256),

    // ── Payments / Moyasar (PLATFORM-level only) ──────────────────────────
    // PAYMENT_PROVIDER is the single, central gateway selection. In dev/test
    // the keys may stay unset (the factory falls back to the Noop provider so
    // the app boots and runs without a live integration); in PRODUCTION a real
    // provider with missing essential keys fails the boot — see the explicit
    // check after schema validation below.
    // `.empty('')`: an empty `PAYMENT_PROVIDER=` line means "unset" (default), not an
    // invalid value that would refuse to boot. 'moyasar' stays the default until
    // an operator sets `tap` deliberately.
    PAYMENT_PROVIDER: Joi.string()
      .valid('moyasar', 'tap', 'noop')
      .empty('')
      .default('moyasar'),
    // Tap Payments (platform-level, https://developers.tap.company). Secret keys
    // are validated by PREFIX in the post-validation block below — never with a
    // Joi pattern, whose error message would echo the secret into boot logs.
    // TAP_ENV has no default here on purpose: production + tap must set it
    // explicitly (PaymentsConfig falls back to 'sandbox' for dev only).
    TAP_ENV: Joi.string().valid('sandbox', 'live').empty(''),
    TAP_MERCHANT_ID: Joi.string().allow('', null),
    TAP_TEST_SECRET_KEY: Joi.string().allow('', null),
    TAP_TEST_PUBLIC_KEY: Joi.string().allow('', null),
    TAP_LIVE_SECRET_KEY: Joi.string().allow('', null),
    TAP_LIVE_PUBLIC_KEY: Joi.string().allow('', null),
    TAP_PLATFORM_ID: Joi.string().allow('', null),
    TAP_WEBHOOK_URL: Joi.string().allow('', null),
    TAP_API_BASE: Joi.string().allow('', null),
    TAP_REQUEST_TIMEOUT_MS: Joi.number().integer().min(1000).max(120000),
    // Opt-in payable window for a hosted charge (Tap allows 5–60 minutes).
    TAP_CHARGE_EXPIRY_MINUTES: Joi.number().integer().min(5).max(60),
    // Clinic-not-present renewals + card saving. Off until Tap has activated
    // Save Card and non-3DS merchant-initiated charges on the account.
    TAP_RECURRING_ENABLED: Joi.boolean().truthy('true').falsy('false').empty(''),
    // Patient booking payments, settled by Tap straight to each clinic's merchant
    // (Tap Platform). Off until the platform is activated (TAP_PLATFORM_ID) and a
    // clinic has been onboarded and approved.
    TAP_BOOKING_PAYMENTS_ENABLED: Joi.boolean()
      .truthy('true')
      .falsy('false')
      .empty(''),
    // [OPTIONAL] Tap documents a separate "segment" secret key for the Lead /
    // Connect (clinic onboarding) calls. Unset = the active merchant secret key.
    TAP_SEGMENT_SECRET_KEY: Joi.string().allow('', null),
    // MOYASAR_SECRET_KEY: Joi.string().allow('', null),
    // MOYASAR_PUBLISHABLE_KEY: Joi.string().allow('', null),
    // MOYASAR_WEBHOOK_SECRET: Joi.string().allow('', null),
    // MOYASAR_API_BASE: Joi.string().allow('', null),
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
    // REFUND_REAPER_STALE_MIN: Joi.number().min(1).default(10),
    // REFUND_REAPER_HARDFAIL_MIN: Joi.number().min(1).default(120),
    // Payment reconciliation sweep thresholds, minutes (stale PENDING payments
    // re-verified against the gateway; hard threshold pages an operator).
    // PAYMENTS_RECON_STALE_MIN: Joi.number().min(1).default(15),
    // PAYMENTS_RECON_HARDFAIL_MIN: Joi.number().min(1).default(240),

    // ── Email (Resend by default; provider behind an abstraction) ─────────
    // `enabled` defaults to ON in production, OFF in dev (no-op provider) unless
    // EMAIL_ENABLED is set explicitly. EMAIL_SYNC=true delivers inline instead of
    // via the worker (for API-only deployments).
    EMAIL_PROVIDER: Joi.string().valid('resend', 'ses', 'noop').default('resend'),
    EMAIL_ENABLED: Joi.string().valid('true', 'false'),
    EMAIL_SYNC: Joi.string().valid('true', 'false').default('false'),
    RESEND_API_KEY: Joi.string().allow('', null),
    EMAIL_FROM: Joi.string().allow('', null),
    EMAIL_FROM_NAME: Joi.string().allow('', null),
    EMAIL_REPLY_TO: Joi.string().allow('', null),
    EMAIL_DEFAULT_LOCALE: Joi.string().default('en'),
    // Per-request timeout for the Resend HTTP call (ResendProvider defaults to
    // 10000). Capped below BullMQ's default 30s job lock: a send that outlives
    // the lock gets the job stall-requeued and delivered a second time while
    // the first request is still in flight.
    RESEND_HTTP_TIMEOUT_MS: Joi.number().integer().min(1000).max(25000),
    // Base URL used to build links inside emails (falls back to FRONTEND_ORIGIN).
    APP_URL: Joi.string().allow('', null),
    // Phase 11 (US7, T134) — HMAC secret for the stateless unsubscribe token
    // (identifies a (tenant, email) pair only). Optional: falls back to
    // JWT_ACCESS_SECRET (always required/present) so no new mandatory
    // deployment secret is introduced; set explicitly to use a dedicated key.
    EMAIL_UNSUBSCRIBE_SECRET: Joi.string().allow('', null),
    // Phase 11 (US7, T136) — HMAC secret configured on the Resend webhook
    // endpoint. Unset means bounce/complaint feedback is rejected outright
    // (fail closed), same posture as META_APP_SECRET/MOYASAR_WEBHOOK_SECRET.
    RESEND_WEBHOOK_SECRET: Joi.string().allow('', null),

    // ── Amazon SES (EMAIL_PROVIDER=ses — AWS migration) ───────────────────
    // No credentials here: the SDK resolves the runtime IAM role (ECS task
    // role). Region falls back to AWS_REGION. The timeout is capped below
    // BullMQ's 30 s job lock for the same reason as RESEND_HTTP_TIMEOUT_MS.
    // SES_FEEDBACK_QUEUE_URL turns on the worker's bounce/complaint consumer
    // (SES → SNS → SQS); unset = consumer idle.
    SES_REGION: Joi.string().allow('', null),
    SES_CONFIGURATION_SET: Joi.string().allow('', null),
    SES_HTTP_TIMEOUT_MS: Joi.number().integer().min(1000).max(25000),
    SES_FEEDBACK_QUEUE_URL: Joi.string().uri().allow('', null),
    // Set by the platform (ECS task definition); used by the S3/SES/SQS clients.
    AWS_REGION: Joi.string().allow('', null),

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
    // F-22: renamed from `OPENAI_CHAT_MODEL`, which was named like the
    // platform's effective chat model but never was one — `AiModelRouterService`
    // always supplies `request.model` from `ai.default_model`
    // (`/platform/settings`), so the old name was actively misleading. Still
    // constrained to the registry so it can never put an unauthorized model in
    // front of live traffic. Its two real jobs now: (1) the model applied when
    // a request names none at all (rare — only callers that bypass the router),
    // and (2) the model `OpenAiChatProvider`'s circuit breaker substitutes to
    // when the routed model trips (see AI_CIRCUIT_BREAKER_* below).
    AI_FALLBACK_MODEL: Joi.string()
      .valid(...AI_MODEL_IDS_ALL)
      .default(DEFAULT_AI_MODEL_ID),
    // F-22: consecutive-failure threshold / cooldown for the per-model circuit
    // breaker in `OpenAiChatProvider`. Unproven live — a first sizing guess,
    // not a measured value; tune once real failure-rate data exists.
    AI_CIRCUIT_BREAKER_THRESHOLD: Joi.number().integer().min(1).max(20).default(3),
    AI_CIRCUIT_BREAKER_COOLDOWN_MS: Joi.number()
      .integer()
      .min(1000)
      .max(600000)
      .default(60000),
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
    // Both are constrained to AI_MODEL_REGISTRY ids: a typo or an unregistered
    // model here used to sail through boot and surface only as an UNPRICED cost
    // row (or a provider 400) on the first routed turn.
    //
    // Validated against AI_MODEL_IDS_ALL, not the GA-only AI_MODEL_IDS: naming a
    // PREVIEW model here is how an OPERATOR opts into one after running the live
    // compatibility spec. That is a deliberate, reversible, single-variable act,
    // unlike the tenant-facing surfaces (agent DTO, ai.default_model), which stay
    // GA-only.
    // Tier-preserving migration of the previous 'gpt-4.1-mini' default: that
    // model was the registry's first ECONOMY entry and GPT-5.6 Luna is the
    // ECONOMY entry of the permitted set. Derived, so retiring a model moves
    // this with it instead of leaving a literal that no longer validates.
    AI_ECONOMY_MODEL: Joi.string()
      .valid(...AI_MODEL_IDS_ALL)
      .default(defaultModelForTier('ECONOMY')),
    AI_POWERFUL_MODEL: Joi.string()
      .valid(...AI_MODEL_IDS_ALL)
      .allow('', null),
    // Whether an unregistered model string PERSISTED on an agent row
    // (ai_agents.model) is ANNOUNCED when it is ignored. 'true' (default) logs
    // it once per distinct value; 'false' ignores it silently.
    //
    // It used to also decide WHETHER it was ignored — 'false' passed the stored
    // string through to the provider unchanged. It no longer can: an operator
    // variable must not be able to re-open the platform's model policy, and the
    // pass-through was the escape hatch that made that possible. The agent DTO
    // blocks new unregistered writes, and migration AiModelPolicyLunaTerra
    // rewrote the ones that already existed.
    AI_MODEL_ROUTING_STRICT: Joi.string()
      .valid('true', 'false')
      .default('true'),
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
    // Platform policy: comma-separated AI_FEATURE names that MUST be processed
    // regionally regardless of the tenant's own configuration. A listed feature
    // whose tenant has no usable regional deployment is REFUSED, never processed
    // globally. Empty (default) ⇒ residency is driven purely by the tenant's own
    // deployment row.
    AI_RESIDENCY_REQUIRED_FEATURES: Joi.string().allow('').default(''),

    RAG_TOP_K: Joi.number().default(5),
    // HNSW query-time recall/latency knob (higher = better recall, slower).
    HNSW_EF_SEARCH: Joi.number().default(60),
    // F-08: minimum cosine similarity a vector-search chunk must clear to be
    // shown to the model as knowledge. Without a floor, the ANN search always
    // returns its top-K rows even when the best of them is a near-zero match
    // to a question the knowledge base has nothing on.
    RAG_MIN_SCORE: Joi.number().min(0).max(1).default(0.5),
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
    // AWS migration: `s3` = Amazon S3 via the runtime IAM role (no keys);
    // `r2` (default) keeps the Cloudflare path above selectable for rollback.
    STORAGE_PROVIDER: Joi.string().valid('r2', 's3').default('r2'),
    S3_BUCKET: Joi.string().allow('', null),
    S3_REGION: Joi.string().allow('', null),
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

    // ── Previously-unvalidated operational keys (production-readiness pass) ─
    // Every key below was ALREADY read by shipped code — most of them through
    // a direct `process.env.X ?? '<default>'` at a module's top level — but
    // none was in this schema, so `allowUnknown: true` let a typo'd name or an
    // out-of-range value through silently. Two deliberate constraints on this
    // block, so it is a pure documentation/validation addition and not a
    // behaviour change:
    //
    //   1. NO `.default()` anywhere in it. Several of these keys are read at
    //      MODULE LOAD (e.g. `GUEST_ATTACHMENT_MAX_BYTES` in
    //      storage.constants.ts), which happens BEFORE ConfigModule validates
    //      and writes defaults back into `process.env` — a default here would
    //      therefore be silently ignored at exactly those call sites while
    //      appearing authoritative in this file. Each call site keeps owning
    //      its own fallback; this schema only rejects a value that is present
    //      and wrong.
    //   2. Shape only — the bounds mirror what the consuming code already
    //      treats as usable, never a new policy.
    //
    // The operator-facing documentation for all of these lives in
    // `.env.example`, which is generated against this file.

    // Seeder-only super-admin bootstrap (seed/admin.seed.ts). Production skips
    // admin creation entirely when unset — it never fabricates credentials.
    ADMIN_EMAIL: Joi.string().allow('', null),
    ADMIN_PASSWORD: Joi.string().allow('', null),

    // Secondary APP_URL fallback, read only by the non-production test OAuth
    // provider's redirect allow-list (oauth.registry.ts).
    API_BASE_URL: Joi.string().allow('', null),

    // Bounded wait for a pooled Postgres connection (typeorm.config.ts). Its
    // own `config.get(..., 10000)` fallback stays the source of the default.
    DB_POOL_CONNECTION_TIMEOUT: Joi.number().integer().min(1),

    // P1.3 — `DbPoolMetricsService`'s sample interval (db_pool_total/idle/
    // waiting gauges). Its own `config.get(..., 15000)` fallback stays the
    // source of the default. A cheap in-process property read (`pg-pool`'s
    // own counters, no query) — no need to make this configurably slow for
    // load reasons the way DLQ/queue-depth polling is.
    DB_POOL_METRICS_POLL_MS: Joi.number().integer().min(1000),

    // Discrete connection parts — read ONLY by `seed/data-source.ts`, and ONLY
    // when DATABASE_URL is unset (dev/CLI). Never set in production.
    DB_HOST: Joi.string().allow('', null),
    DB_PORT: Joi.number().port(),
    DB_USERNAME: Joi.string().allow('', null),
    DB_PASSWORD: Joi.string().allow('', null),
    DB_NAME: Joi.string().allow('', null),
    DB_LOGGING: Joi.string().valid('true', 'false'),

    // Queue/worker knobs read straight from `process.env` in
    // queue.constants.ts, queue-monitor.service.ts and outbox-relay.service.ts.
    // QUEUE_ENV_PREFIX is the one that matters most in a multi-environment
    // deployment: without it, two environments sharing one Redis database
    // consume each other's jobs.
    QUEUE_ENV_PREFIX: Joi.string().allow('', null),
    QUEUE_BACKOFF_MAX_MS: Joi.number().integer().min(1),
    QUEUE_LOG_COMPLETED: Joi.string().valid('true', 'false'),
    CAMPAIGN_GLOBAL_MAX_PER_SEC: Joi.number().min(1),
    DLQ_POLL_MS: Joi.number().integer().min(1),
    DLQ_WARN_THRESHOLD: Joi.number().integer().min(0),
    METRICS_QUEUE_DEPTH_POLL_MS: Joi.number().integer().min(1),
    OUTBOX_POLL_MS: Joi.number().integer().min(1),
    OUTBOX_BATCH: Joi.number().integer().min(1),
    OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1),
    OUTBOX_RECOVERY_POLL_MS: Joi.number().integer().min(1),
    OUTBOX_PUBLISHING_STUCK_MS: Joi.number().integer().min(1),

    // Notification dispatch (notification-dispatch.service.ts, module-load).
    NOTIF_RATE_PER_MIN: Joi.number().integer().min(1),
    NOTIF_LOG_RETENTION_DAYS: Joi.number().integer().min(1),

    // Platform request/webhook logging + retention (api-logging.interceptor.ts,
    // platform-maintenance.service.ts).
    PLATFORM_API_LOG_ENABLED: Joi.string().valid('true', 'false'),
    PLATFORM_API_LOG_SAMPLE: Joi.number().min(0).max(1),
    PLATFORM_API_LOG_RETENTION_DAYS: Joi.number().integer().min(1),
    PLATFORM_WEBHOOK_LOG_RETENTION_DAYS: Joi.number().integer().min(1),

    // Tenant access-policy rollout control (access-policy-mode.service.ts). An
    // unrecognised value is already treated as `enforce` at runtime so a typo
    // can never disable authorization; this makes it a loud boot error instead.
    ACCESS_POLICY_MODE: Joi.string().valid('shadow', 'enforce'),
    ACCESS_DECISION_CACHE_TTL_MS: Joi.number().integer(),

    // Staff invitation lifetime, minutes (auth.service.ts).
    STAFF_INVITATION_TTL_MIN: Joi.number().integer().min(5),

    // Guest-chat attachment cap, bytes (storage.constants.ts — module-load).
    GUEST_ATTACHMENT_MAX_BYTES: Joi.number().integer().min(1),

    // Direct WhatsApp send provider (meta-whatsapp.provider.ts). Same version
    // pattern as META_GRAPH_API_VERSION above.
    WHATSAPP_API_VERSION: Joi.string().pattern(/^v\d+\.\d+$/),
    WHATSAPP_HTTP_TIMEOUT_MS: Joi.number().integer().min(1000),

    // LEGACY shared-number notification channel only
    // (meta-whatsapp-cloud.provider.ts). The per-tenant Independent Tech
    // Provider flow does not read these — they stay unset in this deployment
    // model. Declared so a stray value is at least validated, never so that
    // setting them is encouraged.
    WHATSAPP_PHONE_NUMBER_ID: Joi.string().allow('', null),
    WHATSAPP_ACCESS_TOKEN: Joi.string().allow('', null),

    // Workflow HTTP-action timeout (workflow-action.executor.ts).
    WORKFLOW_WEBHOOK_TIMEOUT_MS: Joi.number().integer().min(1),

    // Integration-platform SSRF guard escape hatches + the in-memory test OAuth
    // provider (integration-url-guard.ts, oauth.registry.ts). All three are
    // no-ops outside production except the test provider; declared here so an
    // accidental `1`/`yes` cannot read as "enabled" at one site and not another.
    INTEGRATION_ALLOW_INSECURE_BASE_URL: Joi.string().valid('true', 'false'),
    INTEGRATION_ALLOW_PRIVATE_BASE_URL: Joi.string().valid('true', 'false'),
    INTEGRATION_OAUTH_TEST_PROVIDER: Joi.string().valid('true', 'false'),

    // The two prompt sub-budgets that were added after the AI block above was
    // written.
    //
    // `AI_ATTACHMENT_VISION_MODEL` used to sit here. It was read at exactly one
    // call site (`GuestAttachmentExtractionService.extractImage`), which now
    // routes through `AiModelRouterService` like every other AI call, so the
    // variable has no reader left and is deliberately not carried forward as a
    // dead knob that looks like it still selects a model. `allowUnknown: true`
    // means a stale value left in an operator's `.env` is ignored rather than
    // failing boot.
    AI_PROMPT_ATTACHMENT_TOKENS: Joi.number().integer().min(0),
    AI_PROMPT_BOOKING_CONTEXT_TOKENS: Joi.number().integer().min(0),

    // Presence-only: the platform AI-monitoring screen reports whether these
    // are configured. No code path in this repository calls either provider.
    ANTHROPIC_API_KEY: Joi.string().allow('', null),
    AZURE_OPENAI_API_KEY: Joi.string().allow('', null),
  });

  const { error, value } = schema.validate(config, {
    allowUnknown: true,
    abortEarly: false,
  });

  if (error) {
    throw new Error(`❌ Env validation error: ${error.message}`);
  }

  // ── Synchronize-migrated-DB waiver contract (P0.6 / SCHEMA-011) ───────────
  // Rejected here, unconditionally, regardless of NODE_ENV or
  // TYPEORM_SYNCHRONIZE — `true` is simply never a valid value for this
  // variable under the new contract, so there is no case where letting it
  // through and failing later (inside `assertSynchronizeIsSafeForTarget`,
  // only reached when synchronize is actually on against a migrated DB) is
  // more correct than failing here, at boot, immediately.
  if (value.TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB === 'true') {
    throw new Error(
      `❌ Env validation error: TYPEORM_SYNCHRONIZE_ALLOW_MIGRATED_DB=true is ` +
        `no longer accepted (P0.6) — a bare boolean waived the migrated-database ` +
        `guard for WHATEVER database DATABASE_URL happened to name, which meant ` +
        `a .env copied elsewhere, or a repointed DATABASE_URL, silently inherited ` +
        `the waiver too. Set it to the exact database name from your ` +
        `DATABASE_URL instead (e.g. "ziyarati") — the waiver now applies ONLY to ` +
        `that specific database, and only when it is reached over a loopback ` +
        `host (localhost/127.0.0.1/::1). See ` +
        `tests/load/reports/P0.4_PRODUCTION_REPAIR_PLAN.md § 1.`,
    );
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

  // Same rule, mirrored for the Marketplace's two public cookies (contract C10).
  if (
    value.PUBLIC_COOKIE_SAMESITE === 'none' &&
    value.NODE_ENV !== 'production'
  ) {
    throw new Error(
      `❌ Env validation error: PUBLIC_COOKIE_SAMESITE is "none" but NODE_ENV is ` +
        `not "production", so guest_token/booking_session_id would be issued ` +
        `without the Secure attribute. Use "lax" or "strict" outside production, ` +
        `or run with NODE_ENV=production.`,
    );
  }

  // ── Cross-site cookies require a production-grade origin allow-list ───────
  // `SameSite=None` is a legitimate setting (a cross-site Marketplace, a
  // separately hosted widget) and is NOT refused here. What it changes is who
  // decides which sites may ride the visitor's session: the browser stops
  // withholding the auth/guest cookie from other sites, so the only thing left
  // is the server-side `FRONTEND_ORIGIN` check — REST CORS, and for the
  // realtime socket the handshake `Origin` check in ws-handshake-admission.ts,
  // which holds whatever SameSite says. That makes a weak allow-list the whole
  // exposure: an `http://` or loopback entry would let a page served over
  // cleartext, or from the visitor's own machine, use their session cross-site.
  // `Secure` cookies are only ever set over https, so no working deployment
  // needs such an entry alongside `none`. Names variables only, never values
  // (the ZT-005 convention above).
  if (
    value.NODE_ENV === 'production' &&
    (value.COOKIE_SAMESITE === 'none' ||
      value.PUBLIC_COOKIE_SAMESITE === 'none')
  ) {
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    const weakEntry = String(value.FRONTEND_ORIGIN ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .some((entry) => {
        try {
          const { protocol, hostname } = new URL(entry);
          return (
            protocol !== 'https:' ||
            loopback.has(hostname) ||
            hostname.endsWith('.localhost')
          );
        } catch {
          return true;
        }
      });
    if (weakEntry) {
      throw new Error(
        `❌ Env validation error: COOKIE_SAMESITE or PUBLIC_COOKIE_SAMESITE is ` +
          `"none" in production, which sends the session cookies cross-site — ` +
          `so FRONTEND_ORIGIN must list only https origins on non-loopback ` +
          `hosts. Remove the http:// or localhost entry, or use "lax".`,
      );
    }
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
  // if (value.NODE_ENV === 'production' && value.PAYMENT_PROVIDER !== 'noop') {
  //   const missing: string[] = [];
  //   if (!String(value.MOYASAR_SECRET_KEY ?? '').trim())
  //     missing.push('MOYASAR_SECRET_KEY');
  //   if (!String(value.MOYASAR_WEBHOOK_SECRET ?? '').trim())
  //     missing.push('MOYASAR_WEBHOOK_SECRET');
  //   if (missing.length > 0) {
  //     throw new Error(
  //       `❌ Env validation error: PAYMENT_PROVIDER is "${value.PAYMENT_PROVIDER}" but ` +
  //         `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
  //         `Payments cannot run in production without gateway credentials. ` +
  //         `Set the missing variable(s), or set PAYMENT_PROVIDER=noop to explicitly disable live payments.`,
  //     );
  //   }
  // }

  // ── Tap checks ───────────────────────────────────────────────────────────
  // (a) Key PREFIXES, in every environment, whenever a key is present: a live key
  //     pasted into the test slot (or the reverse) is how real money gets charged
  //     from "sandbox", so it must not boot. Names only — never the value.
  // (b) Production + PAYMENT_PROVIDER=tap: the active credentials, the explicit
  //     environment and a reachable webhook URL are mandatory. Unlike the legacy
  //     Moyasar block above (disabled in commit 3c28259), this one is scoped to
  //     the provider being chosen deliberately, so it cannot block an existing
  //     deployment. Opt out explicitly with PAYMENT_PROVIDER=noop.
  {
    const tapTestKey = String(value.TAP_TEST_SECRET_KEY ?? '').trim();
    const tapLiveKey = String(value.TAP_LIVE_SECRET_KEY ?? '').trim();
    const tapProblems: string[] = [];
    if (tapTestKey && !tapTestKey.startsWith('sk_test_')) {
      tapProblems.push('TAP_TEST_SECRET_KEY must start with "sk_test_"');
    }
    if (tapLiveKey && !tapLiveKey.startsWith('sk_live_')) {
      tapProblems.push('TAP_LIVE_SECRET_KEY must start with "sk_live_"');
    }
    // The segment key follows TAP_ENV like the merchant keys do (one variable,
    // so it must match the environment that is active).
    const tapSegmentKey = String(value.TAP_SEGMENT_SECRET_KEY ?? '').trim();
    const tapSegmentPrefix = value.TAP_ENV === 'live' ? 'sk_live_' : 'sk_test_';
    if (tapSegmentKey && !tapSegmentKey.startsWith(tapSegmentPrefix)) {
      tapProblems.push(
        `TAP_SEGMENT_SECRET_KEY must start with "${tapSegmentPrefix}" while TAP_ENV is ${value.TAP_ENV ?? 'sandbox'}`,
      );
    }
    // Charging on a clinic's behalf needs the platform id Tap issues on
    // activation; without it every clinic charge would be refused at run time,
    // so refuse to boot the flag instead.
    if (
      value.TAP_BOOKING_PAYMENTS_ENABLED === true &&
      !String(value.TAP_PLATFORM_ID ?? '').trim()
    ) {
      tapProblems.push(
        'TAP_BOOKING_PAYMENTS_ENABLED is true but TAP_PLATFORM_ID is not set',
      );
    }

    if (value.NODE_ENV === 'production' && value.PAYMENT_PROVIDER === 'tap') {
      const missing: string[] = [];
      if (!value.TAP_ENV) missing.push('TAP_ENV');
      if (!String(value.TAP_MERCHANT_ID ?? '').trim()) missing.push('TAP_MERCHANT_ID');
      const activeKeyVar =
        value.TAP_ENV === 'live' ? 'TAP_LIVE_SECRET_KEY' : 'TAP_TEST_SECRET_KEY';
      if (!String(value[activeKeyVar] ?? '').trim()) missing.push(activeKeyVar);

      const webhookUrl = String(value.TAP_WEBHOOK_URL ?? '').trim();
      if (!webhookUrl) {
        missing.push('TAP_WEBHOOK_URL');
      } else {
        let ok = false;
        try {
          const u = new URL(webhookUrl);
          ok =
            u.protocol === 'https:' &&
            !['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
        } catch {
          ok = false;
        }
        if (!ok) {
          tapProblems.push(
            'TAP_WEBHOOK_URL must be a public https URL (Tap cannot post to localhost)',
          );
        }
      }
      if (missing.length > 0) {
        tapProblems.push(
          `PAYMENT_PROVIDER is "tap" in production but ${missing.join(', ')} ${
            missing.length === 1 ? 'is' : 'are'
          } not set`,
        );
      }
    }

    if (tapProblems.length > 0) {
      throw new Error(
        `❌ Env validation error: ${tapProblems.join('; ')}. ` +
          `Set the variable(s) correctly, or set PAYMENT_PROVIDER=noop to explicitly disable live payments.`,
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

  // ── Edge token needs the ALB hop to be trusted (SEC-02) ───────────────────
  // The token only makes sense when Express resolves `req.ip` to the
  // ALB-appended address; with hops=0 the edge check could never match and the
  // operator would believe per-user throttling was on when it is not.
  if (value.EDGE_PROXY_TOKEN && Number(value.TRUST_PROXY_HOPS) !== 1) {
    throw new Error(
      `❌ Env validation error: EDGE_PROXY_TOKEN is set but TRUST_PROXY_HOPS is ` +
        `not 1. The edge token is only meaningful behind the ALB; set ` +
        `TRUST_PROXY_HOPS=1 or unset EDGE_PROXY_TOKEN.`,
    );
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

  // ── Query-logging fail-fast (production only, AI-011) ─────────────────────
  // Mirrors the reset-token fail-fast immediately above (the same reference
  // pattern for refusing to boot on an insecure production configuration).
  // TYPEORM_LOGGING is a pre-existing key (no new key here) — this is a
  // production GATE on it, not a new setting. With it enabled, every SQL
  // statement (parameter values included) is written to raw console output,
  // which the audit demonstrated leaking planted secret-shaped values.
  // Outside production the setting works exactly as today, including this
  // repository's own current development value.
  if (value.NODE_ENV === 'production' && value.TYPEORM_LOGGING === 'true') {
    throw new Error(
      `❌ Env validation error: TYPEORM_LOGGING is "true" but NODE_ENV is ` +
        `"production". Raw SQL logging (parameter values included) must never ` +
        `run in production — it writes tenant data and secrets to console ` +
        `output. Set TYPEORM_LOGGING=false, or unset it entirely.`,
    );
  }

  // ── Transactional email sender fail-fast (production only) ────────────────
  // Same ZT-005 posture as above. Email defaults to ON in production (see
  // resolveEmailConfig), and every send happens in whichever process consumes
  // the `email` queue — usually the WORKER, not the API. Production's worker
  // ran for weeks with EMAIL_FROM="" while the API held a valid value: every
  // email was rejected by Resend (422 invalid `from`), recorded as FAILED, and
  // the BullMQ job still reported success. Each process root validates its
  // OWN environment here, so the worker can no longer boot in that state.
  // Names variables only, never values.
  const emailLive =
    value.NODE_ENV === 'production' &&
    value.EMAIL_ENABLED !== 'false' &&
    (value.EMAIL_PROVIDER === 'resend' || value.EMAIL_PROVIDER === 'ses');
  if (emailLive) {
    const missing: string[] = [];
    if (
      value.EMAIL_PROVIDER === 'resend' &&
      !String(value.RESEND_API_KEY ?? '').trim()
    )
      missing.push('RESEND_API_KEY');
    // SES authenticates with the runtime role; it only needs a region.
    if (
      value.EMAIL_PROVIDER === 'ses' &&
      !String(value.SES_REGION || value.AWS_REGION || '').trim()
    )
      missing.push('SES_REGION or AWS_REGION');
    if (!formatFromAddress(value.EMAIL_FROM, value.EMAIL_FROM_NAME)) {
      missing.push('EMAIL_FROM (and/or EMAIL_FROM_NAME)');
    }
    if (missing.length > 0) {
      throw new Error(
        `❌ Env validation error: email is enabled in production with ` +
          `EMAIL_PROVIDER=${value.EMAIL_PROVIDER}, but ${missing.join(', ')} is missing, blank or ` +
          `malformed. EMAIL_FROM must be "sender@your-verified-domain" or ` +
          `"Name <sender@your-verified-domain>"; EMAIL_FROM_NAME must not contain ` +
          `<, > or ". Set these on EVERY process that consumes the email queue ` +
          `(the worker), or set EMAIL_ENABLED=false to turn email off explicitly.`,
      );
    }
  }

  // ── Object storage fail-fast (production, S3 explicitly selected) ─────────
  // R2 stays fail-soft (upload routes answer 503) for backward compatibility,
  // but choosing STORAGE_PROVIDER=s3 without a bucket/region is an explicit,
  // detectable misconfiguration — every clinic document upload would fail.
  if (
    value.NODE_ENV === 'production' &&
    value.STORAGE_PROVIDER === 's3' &&
    (!String(value.S3_BUCKET ?? '').trim() ||
      !String(value.S3_REGION || value.AWS_REGION || '').trim())
  ) {
    throw new Error(
      `❌ Env validation error: STORAGE_PROVIDER=s3 in production requires ` +
        `S3_BUCKET and S3_REGION (or AWS_REGION).`,
    );
  }

  return value;
};
