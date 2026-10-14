# Logging & Observability Audit (Phase 0)

**Date:** 2026-10-14 · **Scope:** `Ziyarati-back` @ `6e0d925` (clean tree), `Ziyarati-font` @ `3307196` (clean tree)
**Method:** read the code, the Dockerfile, the Terraform and the CI workflows; resolved live DNS. Earlier audits
and project notes were treated as leads, not facts — every claim below was re-checked against the current tree.

---

## 1. Verified deployment topology

| Layer | What runs | Evidence |
|---|---|---|
| Frontend | Next.js 16.2.7 on **Vercel**. No route handlers (`app/**/route.ts` = 0). `proxy.ts` (Next 16 middleware) does locale + optimistic auth redirects. REST reaches the API through a Vercel **rewrite** (`/api/:path*` → `BACKEND_ORIGIN`); WebSocket goes direct to `NEXT_PUBLIC_WS_URL`. | `Ziyarati-font/next.config.ts:63`, `proxy.ts` |
| API | **AWS ECS Fargate**, eu-central-1, service `zt-production-api` (2 tasks), behind ALB + WAF. `api.ziyaratech.com` resolves to `zt-production-api-…elb.amazonaws.com` (checked 2026-10-14) — the Railway → AWS cutover has happened. | `nslookup`, `infra/terraform/modules/platform`, `modules/ecs` |
| Worker | Same image, `node dist/src/worker.js`, ECS service (1 task). BullMQ consumers + schedulers + QueueMonitor + a raw `/metrics` listener on `:9091`. | `src/worker.ts`, `Dockerfile` |
| Migrate | One-shot `node dist/src/migrate.js` task. | `Dockerfile` |
| Database | RDS PostgreSQL 17 (Multi-AZ), TLS with CA validation mandatory. | `src/config/database-ssl.ts`, Terraform `rds` |
| Redis | ElastiCache Valkey: BullMQ, Socket.IO adapter, throttler, locks, cache. | `src/queue/redis.config.ts` |
| Logs (today) | `awslogs` driver, **non-blocking, 25 MB buffer**, one log group per role: `/ziyaratech/<env>/{api,worker,migrate,ops}`, **30-day retention**, **KMS-encrypted**, CloudWatch **data-protection policy** as a read-side masking backstop. | `infra/terraform/modules/ecs/main.tf:40-95`, `modules/log-protection` |
| Alerts (today) | SNS topic → email (subscription was still *PendingConfirmation* in the 2026-10-09 notes — unverified now). CloudWatch metric filters on **text** patterns (`ERROR`, `"failed job="`, Tap payment phrases) + ALB 5xx-rate alarms + Route 53 external health check + a CloudWatch dashboard. | `infra/terraform/modules/monitoring/main.tf` |
| CI/CD | GitHub Actions `deploy-aws.yml` (OIDC → ECR → ECS, image scan gate). | `.github/workflows/` |

**Consequence for the design:** the backend runs on infrastructure ZiyaraTech controls, but on a *managed*
runtime (Fargate): no Docker socket, no host agent, no persistent local disk. A central, encrypted,
access-controlled log store with 30-day retention **already exists** (CloudWatch Logs). There is no Loki,
Grafana, Prometheus server, collector or tracing backend anywhere in production, and nothing scrapes the
Prometheus `/metrics` endpoints on AWS.

---

## 2. Existing logging implementation

| Piece | What it does | File |
|---|---|---|
| `RedactingLogger` | App-wide Nest `LoggerService` (API + worker). Extends `ConsoleLogger`; scrubs every string/Error/plain-object argument. **Output is Nest's human text format**, not JSON. | `src/common/logging/redacting-logger.ts` |
| `scrubText` / `scrubError` / `summarizeBodyForLog` | Value-shape scrubbing: emails, 9–19 digit runs (phones, national IDs, cards, incl. Arabic-Indic digits), JWTs, bearer/basic credentials, signed-URL params, Postgres row values. | `src/common/utils/log-scrubber.util.ts` |
| `sanitizeForLog` / `sanitizeUrlForLog` | Key-name redaction (password/secret/token/authorization/apikey/cookie/card/iban/ssn + exact PII names), query-param redaction, capability-token path segments. | `src/common/utils/sanitize.util.ts` |
| `requestContext` middleware | Honours a caller `X-Request-Id` only if `^[A-Za-z0-9._:-]{1,128}$`, otherwise generates a UUID; echoes `X-Request-Id`, adds `X-App-Revision`. | `src/common/middleware/request-context.middleware.ts` |
| Tenant ALS | `TenantContextService` (AsyncLocalStorage): principal, tenant, `correlationId`, matched route. Opened per request in `main.ts`, populated by `TenantContextInterceptor` after auth; re-opened per job by `runInTenantContext` (restores `correlationId`, verifies tenant/actor first). | `src/core/tenant-context/*`, `src/queue/tenant-context.runner.ts` |
| `AllExceptionsFilter` | Single canonical error response. Logs 5xx at `error` (scrubbed stack + cause), 4xx at `warn`, as **a JSON string embedded in a text line**, with request id, user, tenant, sanitized URL and body *shape* only. | `src/common/filters/all-exceptions.filter.ts` |
| `api_logs` table | Per-request DB row from `ApiLoggingInterceptor` (after guards); 10 % sampled in production except API-key traffic and ≥400. This is a **product feature** (integration usage metering), not operational logging. | `src/modules/platform/interceptors/api-logging.interceptor.ts` |
| Prometheus | `prom-client` dedicated registry: HTTP duration histogram (pre-guard, `method`+`status_code` only), BullMQ outcome counter + depth gauge, DB pool gauges, `db_queries_total{route}`, auth-abuse/refresh/login-protection counters, WhatsApp/AI counters, default process metrics. `GET /api/v1/metrics` (bearer `METRICS_TOKEN`, fail-closed in prod) and worker `:9091/metrics`. | `src/metrics/*` |
| `QueueMonitorService` | QueueEvents listener per queue (worker only): logs every `failed`/`stalled`, polls DLQ depth, sweeps expired DLQ jobs. | `src/worker/queue-monitor.service.ts` |
| TypeORM logger | `MetricsAwareTypeOrmLogger` wraps `AdvancedConsoleLogger`; SQL logging is off in production (`TYPEORM_LOGGING=false`), only errors. | `src/config/typeorm.config.ts:40-80,147-246` |
| Durable audit trails | `audit_logs` (login-protection, refresh reuse, admin actions), RBAC permission audit, `ApiKeyAuditService`, activity log. These are DB records, separate from diagnostic logs — **keep them separate**. | `src/modules/auth/auth.service.ts:403`, `src/modules/rbac-audit`, `src/modules/platform/api-key-audit.service.ts` |
| Frontend | `console.error` in two error boundaries, logout, and the Meta Embedded-Signup diagnostic (event names only). No server logging helper, no `instrumentation.ts` (only `instrumentation-client.ts`). Request ids from API error bodies are already surfaced (`app/lib/error-handler.ts`). | `Ziyarati-font/app/*` |

### 2.1 Limitations found

| # | Limitation | Impact |
|---|---|---|
| L-1 | Logs are **Nest text lines**, not JSON; the filter's JSON lives inside a text message. | CloudWatch Logs Insights can't filter by field; every search is substring grep. |
| L-2 | **`request_id`, `user_id`, `tenant_id` appear only in exception-filter lines.** Every other line in a request or job has no correlation key. | "Diagnose a production error by request id" is impossible beyond the one filter line. |
| L-3 | **No HTTP access log.** The only per-request record is the sampled `api_logs` DB row (post-guard, so 401/403/429 from guards are invisible to it). | No way to reconstruct traffic or latency for one request from logs. |
| L-4 | **No log level control.** No `LOG_LEVEL`; Nest's default emits `debug`/`verbose` in production. | Noise + cost; no way to turn diagnostics up/down without a deploy. |
| L-5 | **No version in logs.** `APP_REVISION` is read by `getAppRevision()` but never set by the Dockerfile or the deploy workflow, so `X-App-Revision`/`/health` report `unknown`. | Cannot tie a log line to a release. |
| L-6 | **No process-level crash handling.** No `uncaughtException`/`unhandledRejection` handlers anywhere; a crash prints an unstructured stack straight from Node. | Fatal crashes are the least searchable events in the system. |
| L-7 | **Job failures are logged 2–3×**: the processor's own `@OnWorkerEvent('failed')` (24 processors) + `QueueMonitor` — and QueueMonitor runs in *every* worker replica, so with N workers each failure is logged N more times and `bullmq_jobs_total` is over-counted by N on a `sum()`. Job start/duration/attempt are not recorded at all. | Duplicate noise; no job latency; retries vs. final failure indistinguishable. |
| L-8 | No outbound provider latency/outcome metrics (Meta, Tap, OpenAI, Resend). Each client logs its own failures in its own format. | Can't separate "provider down" from "our bug" quickly. |
| L-9 | Prometheus endpoints exist but **nothing scrapes them on AWS** (F-10 of the infra audit). | The best metrics in the codebase are unused in production. |
| L-10 | CloudWatch metric filters match **text fragments** (`ERROR`, `"failed job="`, payment phrases). | Any log-format change silently breaks alarms unless the filters change in the same release. |
| L-11 | No trace context (no OpenTelemetry), no `trace_id`/`span_id`. | No cross-service latency breakdown. |
| L-12 | Vercel logs are not shipped anywhere; only Vercel's own runtime-log retention applies. | Frontend server errors are not searchable alongside backend logs. |
| L-13 | No alert for repeated failed logins per source IP, no "service went silent" alert based on logs (only task-count and external health checks). | Credential-stuffing and silent-worker incidents rely on someone looking. |

---

## 3. Entry points and relevant modules

- `src/main.ts` — API bootstrap: logger, trust proxy (`TRUST_PROXY_HOPS`, 1 on AWS = the ALB), HTTP timing middleware (pre-guard), compression, `requestContext`, tenant ALS, global filter, CORS, prefix `api/v1`, raw `/api/v1/health`, Socket.IO Redis adapter, SIGTERM/SIGINT → `app.close()`.
- `src/cluster-bootstrap.ts` — optional in-task Node cluster (`API_CLUSTER_WORKERS`, 1 on AWS).
- `src/worker.ts` / `src/worker.module.ts` — worker context, metrics listener, graceful drain.
- `src/migrate.ts`, `src/retention-run.ts`, `src/tenant-offboard.ts`, `src/tap-preflight.ts` — one-shot CLIs (console output by design).
- Global guards (order): Throttler → JwtAuth → Csrf → Maintenance → SubscriptionAccess → Feature (+ per-route permission guards). Rejections surface as `AppError`/`HttpException` through `AllExceptionsFilter`.
- `@nestjs/bullmq` 11.0.4 creates every `Worker` through `ProcessorDecoratorService.decorate()` — a documented override point that wraps **all** processors from one place.
- Outbound HTTP: every provider (Meta Graph, Meta WhatsApp send, Tap, OpenAI SDK v6, Resend) uses Node's built-in `fetch` (undici), which publishes `diagnostics_channel` events — one central, non-invasive hook. AWS SDK v3 (S3, SES, SQS) uses `node:http` and is **not** covered by that hook.
- Domain events (`EventEmitter2`): `appointment.*`, `payment.*`, `refund.recorded`, … emitted after successful state transitions.

## 4. Request context and tenant isolation (as built)

- Tenant id in logs must come from the **authenticated principal** (`request.user.tenantId` set by `JwtAuthGuard`/`ApiKeyAuthGuard`) or, in jobs, from `runInTenantContext` **after** `WorkerAuthorizationService.assertAuthorized`. Never from headers/body. The current code already does this; the new logger must read the same ALS store and nothing else.
- Super admin = `tenantId === null` + `SUPER_ADMIN` role (`TenantContextService.isSuperAdmin`).
- `req.ip` honours `TRUST_PROXY_HOPS` (hop count, never `true`) — the access log must use `req.ip`, never `X-Forwarded-For` directly.
- Logs are operator-only (CloudWatch IAM). There is no tenant-facing log endpoint, and none will be added. `api_logs` is tenant-scoped product data and stays as it is.

## 5. Sensitive-data exposure risks

| Risk | Status |
|---|---|
| Raw request bodies | Never logged (filter logs body *shape*). Keep. |
| Query strings | Redacted for sensitive/free-text params. The new access log will log the **route template**, not the URL. |
| Meta Graph calls carry `access_token` in the **query string** | Any new outbound instrumentation must drop the query string entirely. |
| Provider error strings echoing recipients / IDs | Scrubbed by shape in `RedactingLogger`; must stay true for the new logger (same scrubber). |
| `auth.service.ts:500` interpolates a normalized email into a warning | Scrubbed to `[EMAIL]` by shape today; must remain so. |
| `AUTH_EXPOSE_RESET_TOKEN` dev flag logs a reset token | Refused in production by `env.validation.ts`. Unchanged. |
| SQL parameters | TypeORM query logging is off in prod; RDS parameter group sets `log_parameter_max_length=0` (infra F-11). Unchanged. |
| CloudWatch data-protection regex `SaudiMobileNumber` matches digit runs inside UUIDs (e.g. `5-1234-5678`) | Read-side masking may partially mask `request_id` values *when displayed* to principals without `logs:Unmask`. Filtering still runs on stored data. Documented in `LOGGING.md` troubleshooting. |
| **Out of scope but found:** `Ziyarati-back/app.json` and `.env.strix` hold plaintext credentials (OpenAI key, JWT secrets, Meta app secret, metrics token…). Both are git-ignored now, but the 2026-10-09 notes record `.env.strix` as previously committed with values shared with production. | **Rotate** the affected secrets; delete the local files once rotated. Not changed by this work. |

## 6. Recommended architecture

**Application (both process roots):**
1. One structured logger — `pino` (pinned) behind Nest's `LoggerService`, so the ~250 existing `new Logger(ctx)` call sites keep working unchanged and every line becomes one JSON object with the agreed schema. The existing scrubber/sanitizer stays the single redaction seam.
2. Context enrichment from the **existing** tenant ALS (no second request-context system), plus a small job-context ALS for queue/job/attempt.
3. One access-log line per request from the existing pre-guard timing middleware (sees 100 % of requests, including guard rejections), with the route template.
4. Error ownership: `AllExceptionsFilter` owns request failures (and classifies 401/403/429 and login failures into security events); the job wrapper owns job failures; process handlers own crashes. Duplicate per-processor/QueueMonitor failure lines are demoted.
5. Outbound provider metrics + debug logs from `diagnostics_channel('undici:*')`, query strings dropped.
6. Business events from the existing domain-event bus (no change to booking/payment code paths).
7. Optional OpenTelemetry (off by default), `trace_id`/`span_id` injected into logs when a span is active.

**Central store — production: CloudWatch Logs (already provisioned).** Rationale: it already has KMS encryption,
30-day retention, IAM-restricted read, a data-protection backstop, non-blocking ingestion, an SNS alert path and
zero extra services. Moving production logs to self-hosted Loki on Fargate would add an ECS service, S3 storage,
an authenticated ingestion endpoint and a FireLens sidecar per task — more cost and attack surface for no
capability the team currently lacks. With JSON logs, Logs Insights gives field-level search; metric filters move to
JSON patterns; alarms reuse SNS. All Terraform changes are written but **not applied** (needs approval).

**Self-hosted reference stack — local/dev and verification: Loki + Grafana + Alloy + Prometheus + Tempo**
(`observability/`), bound to localhost, Grafana with auth, 30-day Loki retention. It is the disposable stack the
ingestion-verification script runs against, and the portable option if the backend ever moves to a VPS. Grafana
can also add a CloudWatch data source to view production without moving data.

**Frontend:** Vercel runtime logs remain the store (log drains need a paid Vercel plan → manual decision).
Add `instrumentation.ts` `onRequestError` that writes one structured, PII-free JSON line per server error.

## 7. Planned file changes

Backend — add: `src/common/logging/{structured-logger,log-context,log-config,log-events,process-handlers,http-access-log,provider-instrumentation,job-instrumentation,observability-events.listener,tracing}.ts` (+ specs), `test/logging-*.e2e-spec.ts`, `scripts/observability/verify-log-ingestion.mjs`, `observability/**`, `LOGGING.md`.
Backend — modify: `main.ts`, `worker.ts`, `cluster-bootstrap.ts` (none if avoidable), `all-exceptions.filter.ts` (+spec), `queue-monitor.service.ts`, `metrics.service.ts`, `auth.service.ts` (success/logout/reset events only), `env.validation.ts`, `.env.example`, `Dockerfile` (`APP_REVISION` build arg), `deploy-aws.yml` (pass the SHA), Terraform `monitoring` + `platform` (JSON filters, saved queries, `APP_ENV`).
Frontend — add: `instrumentation.ts`.

## 8. Dependencies

| Package | Why | Notes |
|---|---|---|
| `pino@10.3.1` (prod) | Mature JSON logger, level filtering, safe stringify, sync destination. | 10.4.0 is < 2 weeks old → pinned to 10.3.1. `nestjs-pino`/`pino-http` **not** added: they would duplicate the existing request-id middleware, ALS and timing middleware. |
| OpenTelemetry (optional tracing) | `@opentelemetry/api`, `sdk-trace-node`, `exporter-trace-otlp-http`, `instrumentation-http/express/pg/ioredis/undici`. | Evaluated in Phase 7; loaded only when `OTEL_ENABLED=true`. |

## 9. Risks, compatibility, migration

- **Alarm continuity:** the `ERROR` text filter stops matching JSON (`"level":"error"`). The Terraform update must ship **in the same release** as the image. The `"failed job="` and payment phrases are preserved inside the JSON `message` so those filters keep matching either way.
- **Log volume/cost:** access logs add one line (~350–450 B) per request. CloudWatch ingestion in eu-central-1 is priced per GB; see `LOGGING.md §Cost`. Health checks are logged at `debug` (filtered in prod).
- **Tests:** `all-exceptions.filter.spec.ts` asserts the old JSON-string payload and must be updated with the new structured shape.
- **Shared working tree:** another session may edit this repo concurrently; check mtimes before attributing failures.
- **No DB migrations, no entity changes, no change to API responses, guards, job options or payment logic.**

## 10. Phased plan

1. Structured logger + config + schema tests.
2. Context + access log + request-id tests (HTTP e2e).
3. Error ownership + process handlers.
4. Business/integration coverage (auth events, domain-event listener, provider instrumentation, job wrapper).
5. Redaction tests with fake secrets/PII.
6. `observability/` stack + Terraform CloudWatch updates.
7. Optional OpenTelemetry.
8. Metrics, alert rules, dashboard, saved queries.
9. Startup/shutdown events.
10. Unit + e2e + build + regression runs; end-to-end ingestion script against the local Loki stack (CloudWatch path verified only if/when deployed — not done here).
11. `LOGGING.md`, final report.
