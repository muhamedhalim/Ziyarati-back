# Logging & Observability

How ZiyaraTech logs, where the logs go, how to search them, and what alerts on them.
Discovery findings and the reasoning behind these choices: [LOGGING-AUDIT.md](LOGGING-AUDIT.md).

---

## 1. Architecture

```
                      PRODUCTION (AWS, eu-central-1)                         LOCAL / VERIFICATION
 ┌───────────────┐   stdout/stderr    ┌──────────────────────┐        ┌──────────────┐
 │ API task(s)   │ ─JSON lines──────▶ │ awslogs driver        │        │ app container│─▶ Docker json-file
 │ Worker task   │                    │ (non-blocking, 25 MB) │        └──────────────┘        │
 └───────────────┘                    └──────────┬───────────┘                                  ▼
        │ /metrics (Prometheus fmt)              ▼                                       Grafana Alloy
        │ (not scraped on AWS yet)   CloudWatch Logs  /ziyaratech/<env>/{api,worker,…}           │
        │                            KMS · 30 d · data-protection masking               ┌────────┴───────┐
        │                                        │                                       ▼                ▼
        │                       metric filters ──▶ CloudWatch alarms ──▶ SNS        Loki (30 d)   Prometheus ◀─ /metrics
        │                       Logs Insights saved queries                              │                │
        ▼                                                                                └──▶ Grafana ◀───┘ ◀── Tempo (traces)
 OTLP traces (optional, OTEL_ENABLED)                                                 rules → Alertmanager
```

- **Production central store: CloudWatch Logs** (already provisioned by Terraform: per-role log groups, 30-day
  retention, KMS encryption, IAM-restricted read, a data-protection masking policy, SNS alerting). Logs are JSON,
  so CloudWatch Logs Insights queries by field. No new paid service.
- **Local / verification store: Loki + Grafana** (`observability/`), fed by Grafana Alloy from Docker, with
  Prometheus (metrics + rules), Alertmanager and Tempo (traces). Bound to localhost. Also the reference design if the
  backend ever runs on infrastructure where a self-hosted pipeline makes sense.
- **Frontend (Vercel):** server-side request errors are written as one JSON line each to Vercel's runtime logs
  (`Ziyarati-font/instrumentation.ts`). They are **not** shipped to CloudWatch automatically (§12).

The application never depends on the pipeline: it writes synchronously to stdout/stderr and the `awslogs` driver
runs in non-blocking mode, so a slow or broken log pipeline cannot stall a booking or a payment.

## 2. Log schema

Every line is one JSON object (stdout; `error`/`fatal` go to stderr):

| Field | Always | Meaning |
|---|---|---|
| `timestamp` | ✔ | UTC ISO-8601, millisecond precision (`2026-10-14T13:08:06.295Z`) |
| `level` | ✔ | `debug` · `info` · `warn` · `error` · `fatal` |
| `service` | ✔ | `ziyaratech-api` / `ziyaratech-worker` (`SERVICE_NAME` overrides) |
| `env` | ✔ | `production` / `staging` / `development` / … (`APP_ENV`, else derived from `NODE_ENV`) |
| `version` | ✔ | `APP_VERSION`, else the build's commit SHA (`APP_REVISION`), else `unknown` |
| `pid` | ✔ | process id (useful with `API_CLUSTER_WORKERS>1`) |
| `event` | ✔ | stable machine-searchable name (§3) |
| `message` | ✔ | human-readable text, scrubbed, single line, ≤ 8 KB |
| `context` | | the Nest logger context (class name) |
| `request_id` | in a request / job | the `X-Request-ID` of the request — and, inside a job, of the request that enqueued it |
| `user_id`, `tenant_id` | when authenticated | from the authenticated principal only (never headers/body) |
| `platform_admin` | | `true` for super-admin (tenant-less) operations |
| `trace_id`, `span_id` | when tracing is on and a span is active | |
| `queue`, `job_name`, `job_id`, `attempt` | inside a BullMQ job | |
| `duration_ms` | timed operations | |
| `error` | on failures | `{ type, message, code?, stack? (error/fatal only), cause? }` — scrubbed |
| _event fields_ | | e.g. `route`, `status`, `method`, `provider`, `outcome`, `payment_id` … |

Base fields cannot be overwritten by event fields (a field named `level` is written as `data_level`).

The API and worker write **only** JSON (verified on the production image: 0 non-JSON lines). The one-shot operator
CLIs (`migrate.js`, `retention-run.js`, `tenant-offboard.js`, `tap-preflight.js`) print plain text by design — they
are read by a person during a deploy and land in the `/ziyaratech/<env>/migrate|ops` log groups.

## 3. Event names

Convention: `<domain>.<subject>.<outcome>` — lower_snake segments, past-tense outcomes. Names are an API for
queries, alarms and dashboards: **never rename one in place** (add the new one, migrate queries, retire the old).
The catalogue lives in [`src/common/logging/log-events.ts`](src/common/logging/log-events.ts).

| Area | Events |
|---|---|
| Lifecycle | `app.startup.completed`, `app.shutdown.started/completed/failed`, `app.heartbeat`, `process.uncaught_exception`, `process.unhandled_rejection` |
| HTTP | `http.request.completed` (one per request), `http.request.failed` (5xx), `http.request.rejected` (4xx), `http.rate_limited` |
| Auth | `auth.login.succeeded/failed`, `auth.logout.succeeded`, `auth.authentication.failed` (401), `auth.authorization.denied` (403), `auth.refresh.failed`, `auth.refresh.reuse_detected`, `auth.password_reset.requested/completed`, `auth.password.changed`, `auth.api_key.changed`, `auth.role_permissions.changed` |
| Appointments | `appointment.booking.succeeded/failed`, `appointment.status.changed`, `appointment.rescheduled` |
| Payments | `payment.state.changed`, `payment.processing.failed`, `payment.webhook.failed`, `payment.refund.recorded` |
| Integrations | `provider.request.completed/failed`, `webhook.processing.failed` |
| Jobs | `job.processing.started/completed` (debug), `job.processing.retry_scheduled`, `job.processing.failed`, `job.processing.deferred`, `job.stalled`, `queue.dlq.depth_high` |

Lines written by existing code as plain text (`this.logger.log('…')`) are filed under `<context_snake>.log`
(e.g. `queue_monitor.log`), so they remain groupable.

## 4. Levels

| Level | Use for | Production default |
|---|---|---|
| `debug` | safe diagnostic detail: job start/success, provider successes and 4xx, health-probe access lines | dropped |
| `info` | lifecycle, one access line per request, committed business transitions, heartbeats | kept |
| `warn` | handled anomalies: retries, 4xx, 401/403/429, provider 5xx/429/timeouts, stalled jobs | kept |
| `error` | a failed request (5xx), a job that failed for good, a failed operation | kept |
| `fatal` | the process is going down (uncaught exception / unhandled rejection) | kept |

`LOG_LEVEL` sets the threshold (default `info` when deployed, `debug` locally).

## 5. Writing logs

Keep using Nest's logger — nothing else is needed:

```ts
private readonly logger = new Logger(MyService.name);

this.logger.log('Plain text still works');                          // event: my_service.log
this.logger.warn({                                                   // searchable event
  event: LOG_EVENT.PAYMENT_STATE_CHANGED,
  message: 'Payment failed',
  payment_id: payment.id,
  state: 'failed',
});
this.logger.error({ event: 'x.y.failed', message: 'Sync failed', error: err }); // error → type/message/stack
```

Do: log ids, statuses, counts, durations, error classes. Use `snake_case` field names.
Don't: log request/response objects, ORM entities, job payloads, provider bodies, tokens, or free text a patient
or clinician typed. Don't log a failure you are about to rethrow — its owner logs it (§7).

## 6. Request IDs and correlation

1. `X-Request-ID` from the caller is honoured only if it matches `^[A-Za-z0-9._:-]{1,128}$`; anything else
   (too long, spaces, quotes, CR/LF) is replaced by a UUID. The id is returned in the `X-Request-ID` response
   header and in every error body (`requestId`).
2. It is stored in the request's AsyncLocalStorage context, so every log line written while handling the request —
   across `await`s — carries `request_id`, plus `user_id`/`tenant_id` once authentication has run.
3. Jobs enqueued during the request carry it as `correlationId`; the worker restores it, so the job's lines carry the
   **same `request_id`** as the request that caused them.
4. With tracing on, `trace_id`/`span_id` are added (§11).

## 7. Error ownership (no duplicate error lines)

| Failure | Logged once by | Event |
|---|---|---|
| A request that ends in an exception | `AllExceptionsFilter` | `http.request.failed` / classified security or domain event |
| The fact that a request happened | access-log middleware (pre-guard, sees 100 %) | `http.request.completed` (info, even for 5xx) |
| A BullMQ attempt that throws | processor wrapper (`job-instrumentation.ts`) | `job.processing.retry_scheduled` (warn) / `job.processing.failed` (error) |
| A stalled job | `QueueMonitorService` | `job.stalled` |
| A crash | process handler | `process.*` (fatal), then graceful shutdown, exit 1 |

The per-processor `@OnWorkerEvent('failed')` lines and `QueueMonitor`'s QueueEvents `failed` line were demoted to
`debug` (QueueMonitor runs in every worker replica, so it logged each failure N times). Their non-logging work
(DLQ parking, dead-lettering, the payments "outcome never applied" `ALERT`) is unchanged.

## 8. Redaction and privacy

Layers, in order:
1. **Allow-listing at the source.** The access log reads only method, route template, status, duration, response
   size, the authenticated principal and the trusted-proxy client address. No headers, cookies, bodies or query
   strings. The exception filter logs a body's *shape* only (`[string:24]`), never its text. Business events log ids.
2. **Never serialize objects.** Class instances (requests, sockets, ORM entities) become `[ClassName]`.
3. **Key-name redaction** (`sanitize.util.ts`): password, secret, token, authorization, api key, cookie, card/cvv/
   iban/account numbers, ssn, mfa/otp/totp, recovery/backup codes, session ids, signatures, private keys,
   credentials, and exact PII names (email, phone, names, national id, notes, diagnosis, symptoms, medications, …),
   in any naming style (`access_token`, `refreshToken`, `X-Api-Key`, nested objects, arrays).
4. **Value-shape scrubbing** (`log-scrubber.util.ts`) on every string, message and stack: emails, 9–19-digit runs
   (phones, national/Iqama ids, cards — incl. Arabic-Indic digits), JWTs, bearer/basic credentials, signed-URL and
   token query parameters, Postgres row values.
5. **Injection safety.** Output is JSON (control characters escaped); `message` additionally has CR/LF/control
   characters replaced, so a value can never forge a second line.
6. **Read-side backstop (CloudWatch only):** the log-group data-protection policy masks e-mails, Saudi mobile
   numbers, national ids and JWTs for principals without `logs:Unmask`.

**Verify:** `npx jest src/common/logging/redaction src/common/logging/structured-logger` (fake secrets/PII pushed
through the real logger; asserts none reaches the output).

**Limits — not claimed away:** a secret under an *unrecognised key* whose value has *no recognisable shape* (e.g.
`{ foo: 'hunter2' }`) is not caught; short numbers (< 9 digits) inside free text are kept; key matching is
deliberately broad and can hide harmless fields (`signatureValid`). The allow-list/no-objects rules are the primary
defence; the deny-lists are the backstop. Client IPs are personal data: full IPs appear only on security events
(failed logins, 401/403/429); the access log truncates them (`LOG_ACCESS_CLIENT_IP`).

**Tenant isolation:** `tenant_id` comes only from the authenticated principal (or a job whose tenant/actor was
re-authorized by `runInTenantContext`). Logs are operator-only (IAM on CloudWatch, Grafana login locally); there is
no tenant-facing log endpoint.

## 9. Environment variables

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` deployed / `debug` local | `debug`…`fatal`, `silent` |
| `LOG_FORMAT` | `json` deployed / `pretty` local | deployed environments are always JSON |
| `LOG_ACCESS_CLIENT_IP` | `truncated` | `full` · `truncated` (/24, /48) · `off` |
| `LOG_HEARTBEAT_INTERVAL_MS` | `60000` | `0` disables; the "logs silent" alarms need it |
| `SERVICE_NAME` | `ziyaratech-<role>` | `^[a-z0-9-]{1,64}$` |
| `APP_ENV` | from `NODE_ENV` | Terraform sets it per environment |
| `APP_VERSION` | — | release tag; else `APP_REVISION` |
| `APP_REVISION` | — | commit SHA; set by `docker build --build-arg APP_REVISION=$GITHUB_SHA` (CI does this) |
| `QUEUE_LOG_COMPLETED` | `false` | legacy per-job completion lines |
| `OTEL_ENABLED` | `false` | turns tracing on (§11) |
| `OTEL_TRACES_SAMPLER_ARG` | `0.1` deployed / `1` local | root sampling ratio |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | e.g. `http://tempo:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | e.g. `authorization=Bearer%20<token>` for an authenticated collector |
| `METRICS_TOKEN` | — | bearer token for `/api/v1/metrics` and the worker's `:9091/metrics` (fail-closed in production) |

## 10. Local stack

```bash
# one-time: local secrets (git-ignored)
mkdir -p observability/.secrets
node -e "require('fs').writeFileSync('observability/.secrets/grafana_admin_password', require('crypto').randomBytes(24).toString('hex'))"
node -e "require('fs').writeFileSync('observability/.secrets/metrics_token', require('crypto').randomBytes(24).toString('hex'))"

# start / stop the observability stack
docker compose -f observability/docker-compose.yml up -d
docker compose -f observability/docker-compose.yml down          # add -v to delete stored data

# run the production image with its logs collected (disposable DB/Redis volumes)
docker build --build-arg APP_REVISION=$(git rev-parse HEAD) -t ziyarati-backend:local .
OBS_METRICS_TOKEN=$(cat observability/.secrets/metrics_token) API_PORT=3300 WORKER_METRICS_PORT=19091 \
  docker compose -f docker-compose.prod.yml -f observability/docker-compose.app.yml up -d --no-build

# prove a request's logs reach Loki through the collector
node scripts/observability/verify-log-ingestion.mjs
```

| UI | URL |
|---|---|
| Grafana (admin / the password file) | http://127.0.0.1:3400 → dashboard *ZiyaraTech — Service Overview* |
| Prometheus | http://127.0.0.1:9090 |
| Alertmanager | http://127.0.0.1:9093 |
| Alloy | http://127.0.0.1:12345 |

Resources: ~1.5–2.5 GB RAM for the six containers; Loki disk ≈ compressed log volume × retention (typically
5–10× smaller than raw).

## 11. Searching

### By request id
- **CloudWatch** → Logs Insights → *Saved queries* → `ZiyaraTech/<env>/request-id`, replace `REPLACE_ME`:
  ```
  fields @timestamp, service, level, event, message, route, status, duration_ms, user_id, tenant_id, job_id
  | filter request_id = "<id>" | sort @timestamp asc
  ```
- **Loki (Grafana)**: dashboard row *Investigate a request* (paste the id), or Explore:
  `{service=~"ziyaratech-.+"} | json | request_id="<id>"`

### Saved queries (CloudWatch, `infra/terraform/modules/monitoring/logs.tf`) and LogQL equivalents

| Question | CloudWatch saved query | LogQL |
|---|---|---|
| Errors in the last hour | `errors-last-hour` | `{service=~"ziyaratech-.+", level=~"error\|fatal"}` (range: 1h) |
| Top error types | `top-error-types` | `topk(10, sum by (event, error_type) (count_over_time({level=~"error\|fatal"} \| json error_type="error.type" [1h])))` |
| One service + env | — | `{service="ziyaratech-worker", env="production"}` |
| Failed-login bursts | `failed-logins-by-ip` | `sum by (client_ip) (count_over_time({service="ziyaratech-api"} \| json \| event="auth.login.failed" [5m]))` |
| Failed BullMQ jobs | `failed-jobs` | `{service="ziyaratech-worker"} \| json \| event=~"job.processing.(failed\|retry_scheduled)\|job.stalled"` |
| WhatsApp / AI / payment / provider failures | `integration-failures`, `provider-failures` | `{service=~"ziyaratech-.+"} \| json \| event=~"provider.request.failed\|payment.(processing\|webhook).failed\|webhook.processing.failed"` |
| Slow routes (p50/p95/p99) | `route-latency` | metrics: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))` |
| Everything for one clinic | `tenant-activity` | `{service=~"ziyaratech-.+"} \| json \| tenant_id="<uuid>"` |

Labels in Loki are only `service`, `env`, `level`. Everything else (`request_id`, `tenant_id`, `user_id`, `job_id`,
`trace_id`) is a JSON field — use `| json | field="…"`, never a label selector.

> CloudWatch's masking policy may partially mask a displayed `request_id` for principals without `logs:Unmask`
> (its mobile-number regex can match digit groups inside a UUID). Filtering still runs on the stored value.

### Tracing and data residency
Tracing is an **egress path**: with `OTEL_ENABLED=true` the app sends span data (route templates, SQL text without
parameters, Redis command names, provider hosts) to `OTEL_EXPORTER_OTLP_ENDPOINT`. The subprocessor egress scan
(`subprocessor-egress.spec.ts`) does not detect it (the exporter is loaded lazily), so treat it as a residency
decision: point it only at a self-hosted collector in the same region (e.g. an in-VPC Tempo/ADOT), never a
third-party SaaS endpoint, unless the subprocessor register is updated first.

### Correlating logs with traces
With `OTEL_ENABLED=true`, lines written inside a sampled span carry `trace_id`. In Grafana, a `trace_id` in a Loki
line links to the Tempo trace; from a Tempo span, *Logs for this span* runs
`{service=~"ziyaratech-.+"} | json | trace_id="<id>"`. Traces cover incoming HTTP, Express routing, `pg`, `ioredis`,
outbound `fetch`, and one span per BullMQ job. They do **not** cross the queue boundary: API → worker correlation is
by `request_id`.

## 12. Runbooks

- **5xx ratio / error rate** — `errors-last-hour`, then `request-id` for one failing request. Group by `event` and
  `error.type` (`top-error-types`). A spike on one `route` after a deploy → compare `version`.
- **Fatal crash** — the `process.*` line has `error.stack`, `origin`; the previous lines with the same `pid` show
  what it was doing. ECS (or the cluster primary) restarts the process; repeated crashes → roll back.
- **Failed-login burst** — `failed-logins-by-ip`. One source → consider a WAF IP block; many sources with
  `reason=invalid_credentials` → credential stuffing; `reason=rate_limited` means protection is working.
- **Failed jobs** — `failed-jobs`, then `request-id` with the `request_id` on the job line to see the originating
  request. `unrecoverable=true` → bad payload / authorization, no retry. DLQ depth alerts: `queue.dlq.depth_high`.
- **Provider failures** — `provider-failures` by `provider`/`outcome`: `timeout`/`network_error` → NAT egress or
  provider outage; `rate_limited` → back off; `server_error` → provider status page.
- **Missing logs** (silence alarm) — 1) ECS: is the task running? 2) Is the task writing (`aws logs tail
  /ziyaratech/<env>/api --since 10m`)? 3) Locally: `up{job="alloy"}`, `loki_write_dropped_entries_total`,
  Alloy UI → components. 4) `LOG_LEVEL` set above `info`? 5) Heartbeat disabled (`LOG_HEARTBEAT_INTERVAL_MS=0`)?

## 13. Metrics

Prometheus format on `GET /api/v1/metrics` (API) and `:9091/metrics` (worker), bearer `METRICS_TOKEN`. Labels are
closed sets only — never request, user, tenant, job ids or e-mails.

| Metric | Labels |
|---|---|
| `http_request_duration_seconds` (histogram, pre-guard) | `method`, `status_code` |
| `log_events_total`, `logger_write_failures_total` | `level` |
| `bullmq_job_duration_seconds`, `bullmq_job_attempts_total` (per replica; `sum()` is correct) | `queue`, `outcome` |
| `bullmq_jobs_total` (QueueEvents; every replica counts every job — use `max()`), `bullmq_queue_depth` | `queue`, `status`/`state` |
| `external_requests_total`, `external_request_duration_seconds` | `provider`, `outcome` |
| `db_pool_total/idle/waiting`, `db_queries_total` | `route` |
| WhatsApp / AI / auth-abuse counters, default Node process metrics | see `src/metrics/metrics.service.ts` |

On AWS nothing scrapes these yet (infra audit F-10); the CloudWatch alarms therefore use log-derived metrics. Adding a
scraper (CloudWatch agent sidecar or Amazon Managed Prometheus) is a follow-up that needs approval (cost).

## 14. Alerts

### CloudWatch (production) — `infra/terraform/modules/monitoring/logs.tf` (+ existing `main.tf`)

| Alarm | Expression | Threshold / window | Action |
|---|---|---|---|
| `critical-fatal-process-error` | count `{ $.level = "fatal" }` | ≥ 1 in 5 min | §12 Fatal crash |
| `warning-app-5xx-ratio` | `100 × Http5xx / HttpRequests` from access lines | > `http_5xx_ratio_percent` (2) with ≥ `http_5xx_min_requests` (50) per `http_5xx_period_seconds` (300 s); 2 of 3 periods | §12 5xx ratio |
| `warning-failed-login-burst` | count `auth.login.failed` | ≥ `failed_login_burst_threshold` (20) / 5 min | §12 Failed-login burst |
| `warning-failed-logins-single-ip` | Contributor Insights top `client_ip` | ≥ `failed_login_ip_threshold` (10) / 5 min | WAF block candidate |
| `warning-refresh-token-reuse` | count `auth.refresh.reuse_detected` | ≥ 1 / 5 min | check `user_id`, `client_ip` |
| `critical-{api,worker}-logs-silent` | count `app.heartbeat` | < 1 for 10 min (missing = breaching) | §12 Missing logs |
| `warning-provider-failures-<provider>` | `ProviderFailures{Provider}` | > 10 / 5 min for 10 min | §12 Provider failures |
| `warning-booking-server-failures` | `appointment.booking.failed` with status ≥ 500 | ≥ 3 / 15 min | errors-last-hour |
| `warning-payment-failures` | payment processing/webhook failures, failed payments | ≥ 5 / 15 min | integration-failures |
| `warning-job-retry-storm` | `job.processing.retry_scheduled` | > 100 / 5 min for 10 min | failed-jobs |
| existing `warning/critical-failed-jobs` | `job.processing.failed` (now JSON) | > 10 / > 50 per 5 min | failed-jobs |
| existing `warning-{api,worker}-error-lines` | `level` error/fatal (now JSON) | > 50 / 5 min for 10 min | errors-last-hour |
| existing ALB 5xx rate, p95, task count, payments (`"ALERT:"` …) | unchanged | | |

Noise control: quiet periods never evaluate the ratio (minimum-request guard); counts use `notBreaching` for missing
data; the silence alarms are the only `breaching` ones — **disable their actions during planned scale-to-zero**
(`aws cloudwatch disable-alarm-actions --alarm-names zt-production-critical-worker-logs-silent`), or set
`enable_log_silence_alarms = false`.

### Prometheus / Loki (self-hosted stack) — `observability/prometheus/rules/`, `observability/loki/rules/`
Same intents: 5xx ratio > 2 % (≥ 50 req/5 min, `for: 5m`), p95 > 1 s, error-line rate > 12/min, provider failures,
WhatsApp AI turn failures, job failures/retry storms, DB pool saturation, scrape target down, collector dropping
lines, Loki discarding lines; LogQL: failed logins from one source (≥ 10/5 min), API/worker heartbeat absent 10 min,
any fatal line.

### Notification channels (manual setup)
- **CloudWatch:** alarms publish to the existing SNS topic `zt-<env>-alerts`. Each e-mail in `alert_emails` must
  click the confirmation link (the 2026-10-09 notes recorded it as *PendingConfirmation*). Slack/PagerDuty: add an SNS
  subscription (AWS Chatbot or HTTPS endpoint).
- **Alertmanager:** ships with a receiver that notifies nobody. Add a receiver in
  `observability/alertmanager/alertmanager.yml` with credentials from a secret file.

## 15. Retention

| Store | Default | Change it |
|---|---|---|
| CloudWatch application logs | 30 days | `log_retention_days` in `environments/<env>/main.tf` → `terraform apply` |
| CloudWatch Container Insights | 7 days | `modules/ecs/main.tf` |
| Loki (local) | 30 days (`720h`), compactor-enforced | `LOKI_RETENTION_PERIOD=…h` then restart Loki |
| Prometheus (local) | 30 days / 5 GB | `PROMETHEUS_RETENTION`, `PROMETHEUS_RETENTION_SIZE` |
| Tempo (local) | 7 days | `observability/tempo/tempo.yaml` `block_retention` |
| Security audit records | per the DB retention policy | `audit_logs`, RBAC/API-key audit tables (`retention-run`) — **not** in the log pipeline |

Logs are diagnostic, not the audit trail: they are mutable by whoever administers the store and expire after
30 days. Durable, access-controlled security records stay in the database audit tables. Expired CloudWatch events
are deleted by AWS; Loki deletes chunks `retention_delete_delay` (2 h) after they expire. Neither store is backed up
— by design, logs are not retained beyond their window.

## 16. Pipeline failure modes

| Failure | What happens | Bound |
|---|---|---|
| CloudWatch slow/unreachable | `awslogs` non-blocking mode buffers in memory, then **drops** lines | 25 MB per container |
| Collector (Alloy) down | lines stay in Docker's json-file log; Alloy resumes from its saved position | `max-size 20m × max-file 5` per container — older lines rotate out (lost) |
| Loki down / rejecting | Alloy retries with backoff (≤ 10 tries, ≤ 5 min), then drops the batch → `loki_write_dropped_entries_total` alert | per batch |
| A line cannot be serialized | a `logger.write_failed` marker line instead; `logger_write_failures_total` | — |
| Tracing collector down | spans dropped from the bounded batch queue (2048) | the app is unaffected |

## 17. Credentials

- **CloudWatch:** no credentials in the app — the ECS task's execution role writes logs. Read access is IAM.
- **`METRICS_TOKEN`:** rotate by writing the new value to the app secret (AWS Secrets Manager `zt/<env>/app`) and the
  scraper's token file at the same time, then redeploy; scrapes 401 in between.
- **Grafana admin (local):** replace `observability/.secrets/grafana_admin_password`, then
  `docker compose -f observability/docker-compose.yml exec grafana grafana cli admin reset-admin-password "$(cat observability/.secrets/grafana_admin_password)"`.
- **Remote Loki / OTLP ingestion (if adopted):** put Loki behind a TLS reverse proxy that requires a per-sender
  token (or Loki multi-tenant auth); give Alloy `basic_auth`/`bearer_token_file` and the app
  `OTEL_EXPORTER_OTLP_HEADERS`. Rotate by adding the new token at the proxy, rolling the senders, then removing the
  old one. Never expose Loki's push API or Grafana without authentication.

## 18. Frontend (Vercel)

`Ziyarati-font/instrumentation.ts` → one `web.request.failed` JSON line per server error (route template, method,
Next's error `digest`, scrubbed message; never headers, cookies, the raw path or the stack). Vercel keeps runtime logs
for its plan's retention. Shipping them centrally needs a **Vercel Log Drain** (a paid-plan feature) pointed at an
authenticated endpoint — a decision for the owner, not configured here. Browser-side logging stays minimal.

## 19. Cost (estimates — check current AWS pricing for eu-central-1)

| Item | Driver | Rough monthly cost |
|---|---|---|
| CloudWatch Logs ingestion | access lines ≈ 400–450 B each; at an average 10 req/s ≈ 11–12 GB | ≈ USD 7–8 (≈ USD 0.63/GB) |
| CloudWatch Logs storage (30 d) | compressed | < USD 1 |
| Heartbeats | 2 processes × 1,440 lines/day | negligible |
| New custom metrics from filters | ~14 | ≈ USD 4 |
| New alarms | ~15 | ≈ USD 1.5 |
| Contributor Insights rule | 1 rule + matched events | ≈ USD 0.50 |
| Logs Insights queries | per GB scanned (≈ USD 0.0063/GB) | usage-based |

Log volume scales linearly with traffic: the access line dominates. If cost matters more than per-request records,
raise `LOG_LEVEL` for a noisy service rather than sampling access lines (they are what request-id search relies on).

## 20. Verification

```bash
npx jest src/common/logging                  # schema, levels, redaction, context, HTTP pipeline, jobs (real Redis), providers, crash handling
npx jest src/common/filters src/worker       # error ownership in the filter, QueueMonitor and processors
node scripts/observability/verify-log-ingestion.mjs   # real app → Docker → Alloy → Loki, by request_id
```
The ingestion script exits 0 (VERIFIED), 1 (FAILED) or 2 (BLOCKED: stack not reachable).

## 21. Manual steps before production benefits

1. Merge, then deploy the image **and** `terraform apply` the monitoring/platform changes **in the same release**
   (the JSON filters do not match the old text logs; the "logs silent" alarms would fire against an old image).
2. Confirm the SNS e-mail subscription(s).
3. Optional, needs approval: a Prometheus scraper on AWS (§13), a tracing backend + `OTEL_ENABLED=true`, a Vercel
   Log Drain (§18).
