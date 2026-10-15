# Logging, privacy and observability

| | |
|---|---|
| **Last revised** | 2026-10-15 (consolidation); source documents dated 2026-08-12 … 2026-10-15 |
| **Documentation status** | Consolidated. Part A is current-state; Part B is the live operations guide; Parts C–F are preserved dated records. |
| **Scope** | Structured logging, redaction/privacy of patient data in logs and traces, the local and AWS observability pipeline, alerts, retention, and the 2026-10 audit → remediation chain. |
| **Code references** | `src/common/logging/`, `src/common/utils/{log-scrubber,sanitize}.util.ts`, `src/common/filters/all-exceptions.filter.ts`, `observability/`, `infra/terraform/modules/{monitoring,log-protection}/`, `test/utils/log-canaries.ts` |
| **Commits** | `44cbbc7` ("logging", audited), `daf8b95` ("logging-secu", remediation) |
| **Evidence harnesses** | `../docs/logging-security-audit-2026-10-14/`, `../docs/logging-privacy-remediation-2026-10-14/` (workspace root `docs/`) |

**Status vocabulary.** Part A: *Fixed in code*, *Deployed*, **Pending**, **Blocked**, **Not Verified** (defined in A.2).
Parts C–F keep their own (`CONFIRMED`, `FIXED LOCALLY ONLY`, `BLOCKED`, `NOT FIXED`, …).

## Contents

- [Part A: Current state and verification](#part-a-current-state-and-verification)
  - [A.1 Where things stand](#a1-where-things-stand)
  - [A.2 Finding ledger (consolidated)](#a2-finding-ledger-consolidated)
  - [A.3 Discrepancies and outdated statements](#a3-discrepancies-and-outdated-statements)
  - [A.4 Open items](#a4-open-items)
  - [A.5 Source documents merged into this file](#a5-source-documents-merged-into-this-file)
- [Part B: Operations guide](#part-b-operations-guide)
  - [1. Architecture](#1-architecture)
  - [2. Log schema](#2-log-schema)
  - [3. Event names](#3-event-names)
  - [4. Levels](#4-levels)
  - [5. Writing logs](#5-writing-logs)
  - [6. Request IDs and correlation](#6-request-ids-and-correlation)
  - [7. Error ownership (no duplicate error lines)](#7-error-ownership-no-duplicate-error-lines)
  - [8. Redaction and privacy](#8-redaction-and-privacy)
  - [9. Environment variables](#9-environment-variables)
  - [10. Local stack](#10-local-stack)
  - [11. Searching](#11-searching)
  - [12. Runbooks](#12-runbooks)
  - [13. Metrics](#13-metrics)
  - [14. Alerts](#14-alerts)
  - [15. Retention](#15-retention)
  - [16. Pipeline failure modes](#16-pipeline-failure-modes)
  - [17. Credentials](#17-credentials)
  - [18. Frontend (Vercel)](#18-frontend-vercel)
  - [19. Cost (estimates — check current AWS pricing for eu-central-1)](#19-cost-estimates--check-current-aws-pricing-for-eu-central-1)
  - [20. Verification](#20-verification)
  - [21. Manual steps before production benefits](#21-manual-steps-before-production-benefits)
- [Part C: Phase-0 discovery audit (2026-10-14)](#part-c-phase-0-discovery-audit-2026-10-14)
  - [1. Verified deployment topology](#1-verified-deployment-topology)
  - [2. Existing logging implementation](#2-existing-logging-implementation)
  - [3. Entry points and relevant modules](#3-entry-points-and-relevant-modules)
  - [4. Request context and tenant isolation (as built)](#4-request-context-and-tenant-isolation-as-built)
  - [5. Sensitive-data exposure risks](#5-sensitive-data-exposure-risks)
  - [6. Recommended architecture](#6-recommended-architecture)
  - [7. Planned file changes](#7-planned-file-changes)
  - [8. Dependencies](#8-dependencies)
  - [9. Risks, compatibility, migration](#9-risks-compatibility-migration)
  - [10. Phased plan](#10-phased-plan)
- [Part D: Patient-data leakage and OpenTelemetry security audit (2026-10-14)](#part-d-patient-data-leakage-and-opentelemetry-security-audit-2026-10-14)
  - [1. Executive summary](#1-executive-summary)
  - [2. Architecture and data flow (as implemented, verified in code and live config)](#2-architecture-and-data-flow-as-implemented-verified-in-code-and-live-config)
  - [3. Findings](#3-findings)
  - [4. Verified-clean (tested; not "secure", only "no leak found by this test")](#4-verified-clean-tested-not-secure-only-no-leak-found-by-this-test)
  - [5. Sensitive-field placement matrix](#5-sensitive-field-placement-matrix)
  - [6. Test results](#6-test-results)
  - [7. Secrets in git history (values never shown)](#7-secrets-in-git-history-values-never-shown)
  - [8. Not verified (needs access this audit did not have, or chose not to use)](#8-not-verified-needs-access-this-audit-did-not-have-or-chose-not-to-use)
  - [9. Prioritized remediation plan (smallest safe change first)](#9-prioritized-remediation-plan-smallest-safe-change-first)
  - [10. OpenTelemetry decision](#10-opentelemetry-decision)
- [Part E: Privacy remediation report (2026-10-14)](#part-e-privacy-remediation-report-2026-10-14)
  - [1. Executive summary and residual risk](#1-executive-summary-and-residual-risk)
  - [2. Findings: verified status and remediation](#2-findings-verified-status-and-remediation)
  - [3. Files changed and why](#3-files-changed-and-why)
  - [4. Tests executed (actual results)](#4-tests-executed-actual-results)
  - [5. Canary results: before → after](#5-canary-results-before--after)
  - [6. Terraform plan summary and unverified AWS state](#6-terraform-plan-summary-and-unverified-aws-state)
  - [7. Local vs production verification](#7-local-vs-production-verification)
  - [8. Blockers, risks, and recommended rollout order](#8-blockers-risks-and-recommended-rollout-order)
  - [9. Rollback](#9-rollback)
  - [10. Status of every finding](#10-status-of-every-finding)
- [Part F: Degraded-mode alert handoff (ZT-H06 / D7)](#part-f-degraded-mode-alert-handoff-zt-h06--d7)
  - [1. The signal](#1-the-signal)
  - [2. The recommended alert condition](#2-the-recommended-alert-condition)
  - [3. D7 — this is an operational handoff, not a code blocker](#3-d7--this-is-an-operational-handoff-not-a-code-blocker)
  - [4. No alert provider or dependency introduced](#4-no-alert-provider-or-dependency-introduced)

---


## Part A: Current state and verification

> Authored in the 2026-10-15 consolidation. Part B is the live operations guide; Parts C–F are preserved dated
> audit/remediation/handoff records. Where Part A and a later part disagree, **Part A wins**.

### A.1 Where things stand

- **Part B (operations guide) describes the shipped design** — structured JSON logs to stdout, CloudWatch in
  production, an optional local Loki/Grafana/Tempo stack, redaction rules, alerts, retention.
- **The 2026-10-14 security audit (Part D) judged logging NOT SAFE for patient data** and registered
  17 findings: LSA-01…LSA-17 (0 Critical · 3 High · 5 Medium · 9 Low).
- **The code remediation is committed and deployed.** Backend commit `daf8b95` ("logging-secu", 2026-10-15)
  carries the fixes (safe TypeORM logger, tracing allow-list, field allow-list sanitizer, filter changes,
  scrubber hardening, seed/migrate output, canary harness). The 2026-10-15 AWS infrastructure audit
  (`Ziyarati-back/infra/docs/INFRASTRUCTURE-AUDITS.md`) records that the running ECS task definitions
  (`zt-production-api:15`, `zt-production-worker:13`) use CI image `daf8b95…`. The remediation report (Part E)
  was written **before** the commit and still says "uncommitted / not deployed" — that wording is **outdated**.
- **What is still not live:** the CloudWatch **data-protection (masking) policies** and the logging alarms
  are committed Terraform that has **not been applied** (the production plan on 2026-10-15 lists "50 to add",
  including 8 log data-protection policies and 13 alarms). Until that apply is approved and verified,
  LSA-02 is open and already-written production lines remain readable.
- **Evidence harnesses** (synthetic canary data only) live outside the product repos:
  `docs/logging-security-audit-2026-10-14/` and `docs/logging-privacy-remediation-2026-10-14/` in the workspace
  root.

### A.2 Finding ledger (consolidated)

Status words follow Part E: **Fixed in code** = change committed and covered by regression/canary tests;
**Deployed** = the running image is `daf8b95…` per the infra audit; **Pending** / **Blocked** = needs an
operational decision; **Not Verified** = no check possible in this pass. "Live-log verification" (querying
production logs after the new image) was **not performed** in this pass.

| ID | Sev. | Subject | Code | Production |
|---|---|---|---|---|
| LSA-01 | High | TypeORM prints SQL + bound parameters (PII) | Fixed — `src/common/logging/typeorm-safe-logger.ts` present, used by all DataSources | Deployed (image `daf8b95`); **live-log verification Not Verified**; **37 old parameter lines persist** until retention expiry (~2026-11-11) |
| LSA-02 | High | CloudWatch log groups had no data-protection policy; production plan failed (`GreaterThan` operator) | Fixed — operator corrected, policy + 8 targeted resources committed | **Pending — apply not approved/run** (plan 50 add / 4 change / 3 destroy on 2026-10-15) |
| LSA-03 | High | OTLP exporter sent unsanitized spans to any endpoint | Fixed — https + host allow-list; spans sanitized | Deployed; `OTEL_*` absent in task definitions at the time of the audit |
| LSA-04 | Med | Field deny-list design leaked non-shape values | Fixed for structured fields (allow-list). **Residual: free text inside *message*/exception strings is shape-scrubbed only** | Deployed |
| LSA-05 | Med | Scrubber gaps (%2B, keys, cookies, OTP, phones, IPs) | Fixed | Deployed |
| LSA-06 | Med | Raw URL in error log / Nest 404 message | Fixed (`route` + `query_keys` only) | Deployed |
| LSA-07…LSA-12, LSA-14 | Med/Low | Body summary, full IPs, correlation-ID spoofing, context-key precedence, record size cap, seed/migrate output, frontend server-error log parity | Fixed in code | Deployed (backend); **Vercel runtime log contents/retention Not Verified** (no access) |
| LSA-13 | Low | RDS `log_error_verbosity` / `log_min_error_statement` log statement text | Proposal only | **Blocked** on operational decision |
| LSA-15 | Low | Local observability stack hazards | Documented in `observability/docker-compose.yml` | n/a (local) |
| LSA-16 | Low | `logs:Unmask` allowed for a long-lived IAM user and the apply role | Terraform change committed (`infra/terraform/bootstrap/main.tf`) | **Pending apply** |
| LSA-17 | Low | Tracked `scripts/perf/load/session-cookie.txt` with expired JWTs | File removed; pattern gitignored | Remains in git history (no rewrite); secret rotation **Not Verified** |

### A.3 Discrepancies and outdated statements

| # | Source statement | Current knowledge |
|---|---|---|
| D1 | Part E: "not deployed", "no commit" | Commit `daf8b95`; deployed per infra audit (A.1). Masking apply still outstanding. |
| D2 | Part D: "Production state observed: ECS `zt-production-api:14`, `worker:12` run image `backend:44cbbc7`" | Superseded — task definitions are now `:15` / `:13` on `daf8b95…`. |
| D3 | Part C (phase-0 audit, 2026-10-14, HEAD `6e0d925`) lists topology and gaps as of that commit | Still the best written topology description; individual gaps are tracked by the LSA ledger above and by the infra reports. |
| D4 | Part B §19 cost figures are estimates | The measured AWS cost record is in `infra/docs/COST.md` (CloudWatch not itemised there). |

### A.4 Open items

| Item | Status |
|---|---|
| Approve + apply the targeted Terraform for log data-protection policies, alarms, metric filters (and `logs:Unmask` hardening) | **Pending** |
| Re-run the canary harness against the **live** log groups after apply (count/classification queries only) | **Not Verified** |
| Free text in log messages / exception messages (LSA-04 residual) | **Pending** — needs call-site review |
| LSA-13 RDS log parameters | **Blocked** — operational decision |
| Rotate any credential embedded in the removed cookie file if its secrets match a live environment | **Not Verified** |
| ZT-H06 degraded-mode alert rule (Part F) — no rule referencing `auth_login_protection_events_total` found under `infra/` or `observability/` | **Pending** |

### A.5 Source documents merged into this file


| Former file | Date | Now |
|---|---|---|
| `Ziyarati-back/LOGGING.md` (operations guide — this path is kept) | 2026-10-14/15 | [Part B](#part-b-operations-guide) |
| `Ziyarati-back/LOGGING-AUDIT.md` | 2026-10-14 | [Part C](#part-c-phase-0-discovery-audit-2026-10-14) |
| `Ziyarati-back/LOGGING-SECURITY-AUDIT.md` | 2026-10-14 | [Part D](#part-d-patient-data-leakage-and-opentelemetry-security-audit-2026-10-14) |
| `Ziyarati-back/docs/LOGGING-PRIVACY-REMEDIATION.md` | 2026-10-14 | [Part E](#part-e-privacy-remediation-report-2026-10-14) |
| `Ziyarati-back/docs/SECURITY_ALERTING_HANDOFF.md` | 2026-08-12 | [Part F](#part-f-degraded-mode-alert-handoff-zt-h06--d7) |


---

## Part B: Operations guide

This is the former top-level content of `LOGGING.md` (the path is unchanged). Section numbers below are the guide's own; code comments elsewhere that cite "`LOGGING.md` §8" etc. refer to these.

How ZiyaraTech logs, where the logs go, how to search them, and what alerts on them.
Discovery findings and the reasoning behind these choices: [Ziyarati-back/LOGGING.md (Part C)](#contents).

---

### 1. Architecture

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

### 2. Log schema

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

### 3. Event names

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

### 4. Levels

| Level | Use for | Production default |
|---|---|---|
| `debug` | safe diagnostic detail: job start/success, provider successes and 4xx, health-probe access lines | dropped |
| `info` | lifecycle, one access line per request, committed business transitions, heartbeats | kept |
| `warn` | handled anomalies: retries, 4xx, 401/403/429, provider 5xx/429/timeouts, stalled jobs | kept |
| `error` | a failed request (5xx), a job that failed for good, a failed operation | kept |
| `fatal` | the process is going down (uncaught exception / unhandled rejection) | kept |

`LOG_LEVEL` sets the threshold (default `info` when deployed, `debug` locally).

### 5. Writing logs

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

### 6. Request IDs and correlation

1. `X-Request-ID` from the caller is honoured only if it matches `^[A-Za-z0-9._:-]{1,128}$` **and** looks
   machine-generated — it contains a UUID or a 16+ character run mixing letters and digits, and has no phone/
   e-mail/ID shape (LSA-09). Anything else (too long, spaces, quotes, CR/LF, a chosen word or number such as a
   phone) is replaced by a UUID. The id is returned in the `X-Request-ID` response
   header and in every error body (`requestId`).
2. It is stored in the request's AsyncLocalStorage context, so every log line written while handling the request —
   across `await`s — carries `request_id`, plus `user_id`/`tenant_id` once authentication has run.
3. Jobs enqueued during the request carry it as `correlationId`; the worker restores it, so the job's lines carry the
   **same `request_id`** as the request that caused them.
4. With tracing on, `trace_id`/`span_id` are added (§11).

### 7. Error ownership (no duplicate error lines)

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

### 8. Redaction and privacy

Layers, in order:
1. **Allow-listing at the source.** The access log reads only method, route template, status, duration, response
   size, the authenticated principal and the trusted-proxy client address. No headers, cookies, bodies or query
   strings. The exception filter logs the route **template** and the query-parameter **names** (`query_keys`),
   never the raw URL, a query value or a path parameter (LSA-06); a body's *shape* only (`[string:24]`,
   `[number]`, user-chosen keys as `[key:N]`, LSA-07), never its text. Business events log ids.
   **Structured fields are allow-listed** (`sanitizeLogFields`, LSA-04): a string survives only under an
   identifier/enum key (`*_id`, `status`, `code`, `provider`, …) or when it is itself a machine token
   (`meta_graph`, `RATE_LIMITED`, `msg_4fA9`); free text becomes `[string:N]`; 4–8 bare digits under a neutral
   key become `[digits:N]`; 7+ digit integers under a neutral key `[NUMBER]`. Caller fields can never replace
   the context's `request_id`/`user_id`/`tenant_id`/`trace_id` (LSA-10), and a record is capped at 32 KB (LSA-11).
   TypeORM never prints SQL or parameters: a failed/slow query is one `database.query.failed`/`.slow` line with
   verb, table, SQLSTATE and constraint only (`SafeTypeOrmLogger`, LSA-01).
2. **Never serialize objects.** Class instances (requests, sockets, ORM entities) become `[ClassName]`.
3. **Key-name redaction** (`sanitize.util.ts`): password, secret, token, authorization, api key, cookie, card/cvv/
   iban/account numbers, ssn, mfa/otp/totp, recovery/backup codes, session ids, signatures, private keys,
   credentials, and exact PII names (email, phone, names, national id, notes, diagnosis, symptoms, medications, …),
   in any naming style (`access_token`, `refreshToken`, `X-Api-Key`, nested objects, arrays).
4. **Value-shape scrubbing** (`log-scrubber.util.ts`) on every string, message and stack: emails, 9–19-digit runs
   (phones, national/Iqama ids, cards — incl. Arabic-Indic digits), bracketed/dotted phones, bare 7–8 digit local
   numbers, `%2B`-encoded `+`, JWTs, bearer/basic credentials, `Cookie:` headers, provider keys (`sk-…`,
   `sk_live_…`, `AKIA…`), OTPs next to the word that names them, public IPv4 (kept as /24), signed-URL and token
   query parameters, Postgres row values (including nested `Key (lower(x))=(…)`).
5. **Injection safety.** Output is JSON (control characters escaped); `message` additionally has CR/LF/control
   characters replaced, so a value can never forge a second line.
6. **Read-side backstop (CloudWatch only):** the log-group data-protection policy masks e-mails, Saudi mobile
   numbers, national ids, Egyptian ids, JWTs, signed-URL signatures and provider keys for principals without
   `logs:Unmask`. **As of 2026-10-14 it is NOT applied in production** — see Ziyarati-back/LOGGING.md (Part E).

**Verify:** `npx jest src/common/logging/redaction src/common/logging/structured-logger` (fake secrets/PII pushed
through the real logger; asserts none reaches the output).

**Limits — not claimed away:** the `message` text, error messages and stacks are shape-scrubbed only — a name or
clinical wording interpolated into a message (`` `send failed for ${patient.name}` ``, `${err.message}` of a
provider error that echoes patient text) is **not** caught; call sites must log ids and error codes instead. A
single machine-token-shaped value with a digit under `code`/`reason`/an id key survives. Key matching is
deliberately broad and can hide harmless fields (`signatureValid`). Client IPs are personal data: every log line
carries at most the /24 (/48) network (`LOG_ACCESS_CLIENT_IP=full` is an explicit operator opt-in for the access
log only); for browser traffic that network is Vercel's shared egress, not the user's (LSA-08).

**Tenant isolation:** `tenant_id` comes only from the authenticated principal (or a job whose tenant/actor was
re-authorized by `runInTenantContext`). Logs are operator-only (IAM on CloudWatch, Grafana login locally); there is
no tenant-facing log endpoint.

### 9. Environment variables

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | e.g. `http://tempo:4318` locally; **deployed: must be `https://`** |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — | overrides the base endpoint for traces (same rules) |
| `OTEL_ALLOWED_COLLECTOR_HOSTS` | — | comma-separated hostnames; deployed tracing refuses any other host (LSA-03) |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | e.g. `authorization=Bearer%20<token>` for an authenticated collector |
| `METRICS_TOKEN` | — | bearer token for `/api/v1/metrics` and the worker's `:9091/metrics` (fail-closed in production) |

### 10. Local stack

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

### 11. Searching

#### By request id
- **CloudWatch** → Logs Insights → *Saved queries* → `ZiyaraTech/<env>/request-id`, replace `REPLACE_ME`:
  ```
  fields @timestamp, service, level, event, message, route, status, duration_ms, user_id, tenant_id, job_id
  | filter request_id = "<id>" | sort @timestamp asc
  ```
- **Loki (Grafana)**: dashboard row *Investigate a request* (paste the id), or Explore:
  `{service=~"ziyaratech-.+"} | json | request_id="<id>"`

#### Saved queries (CloudWatch, `infra/terraform/modules/monitoring/logs.tf`) and LogQL equivalents

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

#### Tracing and data residency
Tracing is an **egress path**: with `OTEL_ENABLED=true` the app sends span data (route templates, SQL text without
parameters, Redis command names, provider hosts) to the OTLP endpoint. Every span is sanitized before export
(`SanitizingSpanProcessor`, LSA-03): route templates / `:param` paths only, no client address, user agent,
headers, exception message or stack, SQL string literals replaced, attributes outside the semantic-convention
allow-list dropped. In production/staging, `startTracing` **refuses to start** unless the endpoint is `https://`
and its host is in `OTEL_ALLOWED_COLLECTOR_HOSTS`. `tracing.ts` is registered in `subprocessor-egress.spec.ts` as
an internal (in-VPC collector) egress. `OTEL_ENABLED` stays unset in deployed environments until the conditions
in Ziyarati-back/LOGGING.md (Part E) §OpenTelemetry are met.

#### Correlating logs with traces
With `OTEL_ENABLED=true`, lines written inside a sampled span carry `trace_id`. In Grafana, a `trace_id` in a Loki
line links to the Tempo trace; from a Tempo span, *Logs for this span* runs
`{service=~"ziyaratech-.+"} | json | trace_id="<id>"`. Traces cover incoming HTTP, Express routing, `pg`, `ioredis`,
outbound `fetch`, and one span per BullMQ job. They do **not** cross the queue boundary: API → worker correlation is
by `request_id`.

### 12. Runbooks

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

### 13. Metrics

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

### 14. Alerts

#### CloudWatch (production) — `infra/terraform/modules/monitoring/logs.tf` (+ existing `main.tf`)

| Alarm | Expression | Threshold / window | Action |
|---|---|---|---|
| `critical-fatal-process-error` | count `{ $.level = "fatal" }` | ≥ 1 in 5 min | §12 Fatal crash |
| `warning-app-5xx-ratio` | `100 × Http5xx / HttpRequests` from access lines | > `http_5xx_ratio_percent` (2) with ≥ `http_5xx_min_requests` (50) per `http_5xx_period_seconds` (300 s); 2 of 3 periods | §12 5xx ratio |
| `warning-failed-login-burst` | count `auth.login.failed` | ≥ `failed_login_burst_threshold` (20) / 5 min | §12 Failed-login burst |
| `warning-failed-logins-single-ip` | Contributor Insights top `client_ip` (/24) | ≥ `failed_login_ip_threshold` (10) / 5 min | **off by default** (`enable_failed_login_ip_rule`, LSA-08): browser traffic shares Vercel's egress network |
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

#### Prometheus / Loki (self-hosted stack) — `observability/prometheus/rules/`, `observability/loki/rules/`
Same intents: 5xx ratio > 2 % (≥ 50 req/5 min, `for: 5m`), p95 > 1 s, error-line rate > 12/min, provider failures,
WhatsApp AI turn failures, job failures/retry storms, DB pool saturation, scrape target down, collector dropping
lines, Loki discarding lines; LogQL: failed logins from one source (≥ 10/5 min), API/worker heartbeat absent 10 min,
any fatal line.

#### Notification channels (manual setup)
- **CloudWatch:** alarms publish to the existing SNS topic `zt-<env>-alerts`. Each e-mail in `alert_emails` must
  click the confirmation link (the 2026-10-09 notes recorded it as *PendingConfirmation*). Slack/PagerDuty: add an SNS
  subscription (AWS Chatbot or HTTPS endpoint).
- **Alertmanager:** ships with a receiver that notifies nobody. Add a receiver in
  `observability/alertmanager/alertmanager.yml` with credentials from a secret file.

### 15. Retention

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

### 16. Pipeline failure modes

| Failure | What happens | Bound |
|---|---|---|
| CloudWatch slow/unreachable | `awslogs` non-blocking mode buffers in memory, then **drops** lines | 25 MB per container |
| Collector (Alloy) down | lines stay in Docker's json-file log; Alloy resumes from its saved position | `max-size 20m × max-file 5` per container — older lines rotate out (lost) |
| Loki down / rejecting | Alloy retries with backoff (≤ 10 tries, ≤ 5 min), then drops the batch → `loki_write_dropped_entries_total` alert | per batch |
| A line cannot be serialized | a `logger.write_failed` marker line instead; `logger_write_failures_total` | — |
| Tracing collector down | spans dropped from the bounded batch queue (2048) | the app is unaffected |

### 17. Credentials

- **CloudWatch:** no credentials in the app — the ECS task's execution role writes logs. Read access is IAM.
- **`METRICS_TOKEN`:** rotate by writing the new value to the app secret (AWS Secrets Manager `zt/<env>/app`) and the
  scraper's token file at the same time, then redeploy; scrapes 401 in between.
- **Grafana admin (local):** replace `observability/.secrets/grafana_admin_password`, then
  `docker compose -f observability/docker-compose.yml exec grafana grafana cli admin reset-admin-password "$(cat observability/.secrets/grafana_admin_password)"`.
- **Remote Loki / OTLP ingestion (if adopted):** put Loki behind a TLS reverse proxy that requires a per-sender
  token (or Loki multi-tenant auth); give Alloy `basic_auth`/`bearer_token_file` and the app
  `OTEL_EXPORTER_OTLP_HEADERS`. Rotate by adding the new token at the proxy, rolling the senders, then removing the
  old one. Never expose Loki's push API or Grafana without authentication.

### 18. Frontend (Vercel)

`Ziyarati-font/instrumentation.ts` → one `web.request.failed` JSON line per server error (route template, method,
Next's error `digest`, scrubbed message; never headers, cookies, the raw path or the stack). Vercel keeps runtime logs
for its plan's retention. Shipping them centrally needs a **Vercel Log Drain** (a paid-plan feature) pointed at an
authenticated endpoint — a decision for the owner, not configured here. Browser-side logging stays minimal.

### 19. Cost (estimates — check current AWS pricing for eu-central-1)

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

### 20. Verification

```bash
npx jest src/common/logging                  # schema, levels, redaction, context, HTTP pipeline, jobs (real Redis), providers, crash handling
npx jest src/common/filters src/worker       # error ownership in the filter, QueueMonitor and processors
node scripts/observability/verify-log-ingestion.mjs   # real app → Docker → Alloy → Loki, by request_id
```
The ingestion script exits 0 (VERIFIED), 1 (FAILED) or 2 (BLOCKED: stack not reachable).

### 21. Manual steps before production benefits

1. Merge, then deploy the image **and** `terraform apply` the monitoring/platform changes **in the same release**
   (the JSON filters do not match the old text logs; the "logs silent" alarms would fire against an old image).
2. Confirm the SNS e-mail subscription(s).
3. Optional, needs approval: a Prometheus scraper on AWS (§13), a tracing backend + `OTEL_ENABLED=true`, a Vercel
   Log Drain (§18).

---

## Part C: Phase-0 discovery audit (2026-10-14)

> **Former file:** `LOGGING-AUDIT.md`

**Date:** 2026-10-14 · **Scope:** `Ziyarati-back` @ `6e0d925` (clean tree), `Ziyarati-font` @ `3307196` (clean tree)
**Method:** read the code, the Dockerfile, the Terraform and the CI workflows; resolved live DNS. Earlier audits
and project notes were treated as leads, not facts — every claim below was re-checked against the current tree.

---

### 1. Verified deployment topology

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

### 2. Existing logging implementation

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

#### 2.1 Limitations found

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

### 3. Entry points and relevant modules

- `src/main.ts` — API bootstrap: logger, trust proxy (`TRUST_PROXY_HOPS`, 1 on AWS = the ALB), HTTP timing middleware (pre-guard), compression, `requestContext`, tenant ALS, global filter, CORS, prefix `api/v1`, raw `/api/v1/health`, Socket.IO Redis adapter, SIGTERM/SIGINT → `app.close()`.
- `src/cluster-bootstrap.ts` — optional in-task Node cluster (`API_CLUSTER_WORKERS`, 1 on AWS).
- `src/worker.ts` / `src/worker.module.ts` — worker context, metrics listener, graceful drain.
- `src/migrate.ts`, `src/retention-run.ts`, `src/tenant-offboard.ts`, `src/tap-preflight.ts` — one-shot CLIs (console output by design).
- Global guards (order): Throttler → JwtAuth → Csrf → Maintenance → SubscriptionAccess → Feature (+ per-route permission guards). Rejections surface as `AppError`/`HttpException` through `AllExceptionsFilter`.
- `@nestjs/bullmq` 11.0.4 creates every `Worker` through `ProcessorDecoratorService.decorate()` — a documented override point that wraps **all** processors from one place.
- Outbound HTTP: every provider (Meta Graph, Meta WhatsApp send, Tap, OpenAI SDK v6, Resend) uses Node's built-in `fetch` (undici), which publishes `diagnostics_channel` events — one central, non-invasive hook. AWS SDK v3 (S3, SES, SQS) uses `node:http` and is **not** covered by that hook.
- Domain events (`EventEmitter2`): `appointment.*`, `payment.*`, `refund.recorded`, … emitted after successful state transitions.

### 4. Request context and tenant isolation (as built)

- Tenant id in logs must come from the **authenticated principal** (`request.user.tenantId` set by `JwtAuthGuard`/`ApiKeyAuthGuard`) or, in jobs, from `runInTenantContext` **after** `WorkerAuthorizationService.assertAuthorized`. Never from headers/body. The current code already does this; the new logger must read the same ALS store and nothing else.
- Super admin = `tenantId === null` + `SUPER_ADMIN` role (`TenantContextService.isSuperAdmin`).
- `req.ip` honours `TRUST_PROXY_HOPS` (hop count, never `true`) — the access log must use `req.ip`, never `X-Forwarded-For` directly.
- Logs are operator-only (CloudWatch IAM). There is no tenant-facing log endpoint, and none will be added. `api_logs` is tenant-scoped product data and stays as it is.

### 5. Sensitive-data exposure risks

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

### 6. Recommended architecture

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

### 7. Planned file changes

Backend — add: `src/common/logging/{structured-logger,log-context,log-config,log-events,process-handlers,http-access-log,provider-instrumentation,job-instrumentation,observability-events.listener,tracing}.ts` (+ specs), `test/logging-*.e2e-spec.ts`, `scripts/observability/verify-log-ingestion.mjs`, `observability/**`, `LOGGING.md`.
Backend — modify: `main.ts`, `worker.ts`, `cluster-bootstrap.ts` (none if avoidable), `all-exceptions.filter.ts` (+spec), `queue-monitor.service.ts`, `metrics.service.ts`, `auth.service.ts` (success/logout/reset events only), `env.validation.ts`, `.env.example`, `Dockerfile` (`APP_REVISION` build arg), `deploy-aws.yml` (pass the SHA), Terraform `monitoring` + `platform` (JSON filters, saved queries, `APP_ENV`).
Frontend — add: `instrumentation.ts`.

### 8. Dependencies

| Package | Why | Notes |
|---|---|---|
| `pino@10.3.1` (prod) | Mature JSON logger, level filtering, safe stringify, sync destination. | 10.4.0 is < 2 weeks old → pinned to 10.3.1. `nestjs-pino`/`pino-http` **not** added: they would duplicate the existing request-id middleware, ALS and timing middleware. |
| OpenTelemetry (optional tracing) | `@opentelemetry/api`, `sdk-trace-node`, `exporter-trace-otlp-http`, `instrumentation-http/express/pg/ioredis/undici`. | Evaluated in Phase 7; loaded only when `OTEL_ENABLED=true`. |

### 9. Risks, compatibility, migration

- **Alarm continuity:** the `ERROR` text filter stops matching JSON (`"level":"error"`). The Terraform update must ship **in the same release** as the image. The `"failed job="` and payment phrases are preserved inside the JSON `message` so those filters keep matching either way.
- **Log volume/cost:** access logs add one line (~350–450 B) per request. CloudWatch ingestion in eu-central-1 is priced per GB; see `LOGGING.md §Cost`. Health checks are logged at `debug` (filtered in prod).
- **Tests:** `all-exceptions.filter.spec.ts` asserts the old JSON-string payload and must be updated with the new structured shape.
- **Shared working tree:** another session may edit this repo concurrently; check mtimes before attributing failures.
- **No DB migrations, no entity changes, no change to API responses, guards, job options or payment logic.**

### 10. Phased plan

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

---

## Part D: Patient-data leakage and OpenTelemetry security audit (2026-10-14)

> **Former file:** `LOGGING-SECURITY-AUDIT.md`

| | |
|---|---|
| Date | 2026-10-14 |
| Code audited | `Ziyarati-back` HEAD `44cbbc7` ("logging"), `Ziyarati-font` HEAD `0cea804` ("logging"); working trees clean |
| Production state observed (read-only) | ECS `zt-production-api:14` and `zt-production-worker:12` run image `backend:44cbbc7…` (registered 2026-10-14 16:37 UTC). **The audited code is live.** |
| Mode | Audit only. No code, configuration, infrastructure, retention or IAM change was made. No deploy, `terraform apply` or migration. OpenTelemetry was **not** enabled anywhere except one isolated in-process test against a receiver on `127.0.0.1`. |
| Test data | Synthetic canary values only (invented names, `.test` e-mail domain, made-up numbers). Production logs were queried **only with count/classification queries** that return numbers, table names and booleans, never log text. |
| Evidence harness | `D:\projects\Ziyarati-full\docs\logging-security-audit-2026-10-14\` (outside both product repos) |

---

### 1. Executive summary

#### Decision: **NOT SAFE TO DEPLOY (as-is)**

The application-level redaction added in `44cbbc7` works for what it was designed for: shaped identifiers (e-mail, Saudi/Gulf phone numbers, national/Iqama/Egyptian IDs, card numbers, JWTs, Bearer values, signed-URL signatures) and a list of exact field names. Bodies, headers, cookies, job payloads and ORM entities never reach the log. But the audit found three problems that together make the current logging posture unsafe for patient data. Because `44cbbc7` is already running in production, treat the P0 items in §9 as a hotfix, not as a pre-release task.

1. **Raw SQL with every bound parameter is written to production stdout, bypassing all redaction (LSA-01, High, confirmed).** TypeORM's console logger is always on for query errors. A canary run against real PostgreSQL showed it printing patient name, phone, clinical note and national ID verbatim. Production CloudWatch already holds **37** such lines in the last 30 days. They contain clinic data (WhatsApp template text in Arabic, tenant IDs), but **no patient data was observed** in them.
2. **No CloudWatch masking is active on any production log group (LSA-02, High, confirmed).** Terraform declares a data-protection policy (`enable_log_data_protection = true` by default), but it was never applied. `GetDataProtectionPolicy` returns an empty response for `/ziyaratech/production/{api,worker,migrate}`, and there is no account-level policy. The "backstop" described in `LOGGING.md` does not exist. The new metric filters and alarms (`logs.tf`) are not applied either.
3. **If tracing were enabled, OpenTelemetry would export patient-linked data (LSA-03, High, confirmed in isolation, not active).** In an isolated test, `startTracing()` exported 7 of 18 canaries: the client IP taken from `X-Forwarded-For`, the user agent, the raw URL path including payment/action capability tokens and path-borne phone numbers, and exception messages and stacks containing an Arabic name and a phone number. Nothing restricts the export destination: plain `http://` is accepted, there is no region allow-list, and task egress is open to `0.0.0.0/0:443`. **Keep `OTEL_ENABLED` unset in every deployed environment (§10).**

Free text is the systemic gap behind most Medium findings. Names (English and Arabic), clinical wording and anything under an unlisted field name pass through: 53 of 97 tested field-name variants were not redacted, including `patientPhone`, `mobile`, `name`, `medicalNotes`, `guardianName`, `dob`, `iqama` and `passportNumber`. Value-shape scrubbing cannot detect a name or a diagnosis.

#### Is there actual evidence of patient or clinic data in logs?

| Data class | Evidence | Status |
|---|---|---|
| **Patient** data (names, phones, clinical text, IDs) in production logs | None found. Count queries for e-mail, Saudi mobile, 10-digit ID and JWT shapes in the app log groups returned 0 matches outside the items below. Arabic text appears in 6 lines, all classified as WhatsApp-template content. | **Not observed**. Mechanism **proven** with canaries (LSA-01, LSA-04, LSA-06). This is not proof of absence: names and clinical text cannot be detected by count queries. |
| **Clinic** data (template text, tenant IDs, business identifiers) | 4 TypeORM `INSERT INTO whatsapp_templates … -- PARAMETERS:` lines with Arabic template text and 9+-digit IDs. 33 `SELECT … customer_segments` lines with a tenant UUID. 2 `ExceptionFilter` lines with Arabic template text. 4 RDS `DETAIL: Key ("tenantId", name, language)=(…)` lines. | **Confirmed**, unmasked, retained 30 days |
| **Staff** PII | 2 lines in `/ziyaratech/production/migrate` with the super-admin e-mail (seed output). 2 RDS `STATEMENT:` lines with an e-mail address in an ad-hoc, non-parameterized `select`. | **Confirmed** |

#### Must fix before any further deployment (detail in §9)

1. Stop TypeORM from printing query parameters (LSA-01).
2. Apply and verify the CloudWatch data-protection policy, and know its limits (LSA-02).
3. Make tracing refuse to start in deployed environments unless the endpoint is `https://` on an allow-listed in-region host, and fix the span attribute hooks (LSA-03). Until then, `OTEL_ENABLED` stays unset.
4. Stop logging the raw `originalUrl` in the exception filter (LSA-06). Its query-value and path-parameter leaks are the easiest patient-data path to trigger.

---

### 2. Architecture and data flow (as implemented, verified in code and live config)

```
Browser ──HTTPS──► Vercel (Next.js rewrite /api/*)  ──HTTPS──► AWS ALB (xff=append) ──► ECS Fargate API task
   │                  │  Vercel request logs (path+query)            │                        │
   │                  │  Next.js default error log + instrumentation │                        │ stdout/stderr
   │                  ▼  onRequestError → console.error(JSON)        │                        ▼
   │            Vercel runtime logs (region/retention NOT VERIFIED)  │        awslogs driver (non-blocking, 25 MB)
   │                                                                 │                        ▼
Meta/Tap/SES webhooks, WebSocket clients, API-key integrators ───────┘   CloudWatch Logs /ziyaratech/production/api
                                                                         (KMS CMK, 30 d, NO masking live, old metric filters)
ECS worker task ── stdout ──► /ziyaratech/production/worker (same)        migrate task ──► …/migrate
RDS PostgreSQL ── server log export ──► /aws/rds/instance/zt-production-pg/postgresql (KMS, 30 d)
ElastiCache ── slow log ──► /aws/elasticache/zt-production/slow-log (KMS, 30 d)
Prometheus /metrics: API route (bearer METRICS_TOKEN, fail-closed) and worker :9091 (no SG ingress). NOT scraped on AWS.
OpenTelemetry: code present (tracing.ts), OTEL_* absent from live task definitions → disabled.
DB table api_logs (IP per request): PLATFORM_API_LOG_ENABLED=false in production → not written.
Local only: Docker → Alloy (docker.sock) → Loki 30 d; OTLP → Tempo 7 d; Prometheus 30 d; Grafana (127.0.0.1).
```

**Writers to stdout/stderr in the API and worker processes:**

| Writer | Redaction applied | Notes |
|---|---|---|
| `StructuredLogger` (`src/common/logging/structured-logger.ts`), used by all 657 `Logger`/`console` call sites via Nest | Key deny-list (`sanitize.util.ts`) plus value-shape scrubbing (`log-scrubber.util.ts`) | Main path |
| `AllExceptionsFilter` → StructuredLogger | Same, plus `sanitizeUrlForLog` for `path` and `summarizeBodyForLog` for `body_shape` | One line per failed request |
| Access middleware (`http-access-log.ts`) | Allow-list (method, route template, status, ids, /24 IP) | Does not read query strings, headers or bodies |
| **TypeORM `AdvancedConsoleLogger`** (via `MetricsAwareTypeOrmLogger`) | **None.** `console.log`, plain text | **LSA-01** |
| `migrate.ts`, `seed/*` when run as a CLI | **None** (console) | LSA-12 |
| Nest internals, BullMQ, ioredis, Socket.IO | Go through the Nest logger, or nothing | No raw writes found |

---

### 3. Findings

Severity scale: Critical means patient data is confirmed exposed to unauthorized parties, or the exposure is trivially triggerable at scale. High means a proven mechanism for patient/credential data reaching a store without protection, or a confirmed live control gap. Medium means a proven leak that requires a specific code path or input. Low means limited data, a limited audience, or a hygiene issue.

**Totals: 0 Critical · 3 High · 5 Medium · 9 Low.**

#### HIGH

##### LSA-01 — TypeORM prints failing SQL and all bound parameters to stdout, bypassing redaction
- **Severity / confidence:** High / High
- **Where:** `src/config/typeorm.config.ts:40-71` (delegate `AdvancedConsoleLogger`), `:238-242` (the logger is always built with at least `['error']`, so `TYPEORM_LOGGING=false` does not turn this off). TypeORM 1.1.2 `logger/AbstractLogger.js:42-60` (`logQueryError` → "query failed" + `parameters`), `:240` (`-- PARAMETERS: ${JSON.stringify(parameters)}`). `platform/PlatformTools.js:192` (`console.log`).
- **Reproduce:** run `canary/http-db-canary.spec.ts` test S6 against a throwaway PostgreSQL. An `INSERT` that violates a unique index makes TypeORM print `query failed: INSERT INTO … -- PARAMETERS: ["<name>","<phone>","<clinical note>","<national id>"]`.
- **Data at risk:** every value bound to a failing statement: patient names, phones, national IDs, notes, appointment fields, e-mails; tokens or hashes if an auth query fails.
- **Leak status:** **Confirmed** (canaries `nameEn`, `nameAr`, `phoneAscii`, `clinicalNote`, `nationalId` and an e-mail all leaked). **Confirmed in production:** 37 lines from 2026-10-09 21:39 to 2026-10-11 19:19 (33 × `customer_segments` SELECT whose only parameter is a tenant UUID, 4 × `whatsapp_templates` INSERT with Arabic template text). No patient-data parameter was observed in production.
- **Impact:** the moment a query touching patient tables fails (unique violation, an exclusion-constraint booking race, a type error, schema drift), the patient row values land in CloudWatch in plain text. There is no JSON structure, no masking, and readers can see every clinic's data. This defeats the whole redaction design.
- **Fix (minimal):** in `MetricsAwareTypeOrmLogger.logQueryError` (and `logQuerySlow`), stop delegating. Emit one structured `db.query.failed` line with the SQL verb, the table, `driverError.code` and `constraint`, and **never** `parameters`. Do not pass the full SQL text either, because ad-hoc literals are possible. Alternatively pass `logging: false`; the exception filter already logs the mapped error.
- **Verifying test:** the S6 "RAW console" cases must report `clean` for all canaries, with an added assertion that no console output contains `PARAMETERS`.

##### LSA-02 — No CloudWatch Logs data-protection (masking) is live in production; monitoring Terraform not applied
- **Severity / confidence:** High / High
- **Where:** `infra/terraform/modules/log-protection/main.tf` (policy), `modules/platform/main.tf:327-335` (attached to the ecs/rds/elasticache/waf groups), `environments/production/variables.tf:158-162` (`default = true`). Live account checked with read-only calls.
- **Reproduce:**
  - `aws logs describe-log-groups` → `dataProtectionStatus: null` for every `/ziyaratech/production/*` group.
  - `aws logs get-data-protection-policy --log-group-identifier /ziyaratech/production/api` → empty response.
  - `aws logs describe-account-policies --policy-type DATA_PROTECTION_POLICY` → `[]`.
  - `aws logs describe-metric-filters` on the api group returns only the 8 pre-existing filters (`zt-production-api-errors`, `…pay-api-*`), none from `logs.tf`.
- **Data at risk:** everything in LSA-01, LSA-04 to LSA-08 and LSA-12, shown unmasked to anyone who can read the groups or run Insights queries.
- **Leak status:** **Confirmed** (control absent).
- **Impact:** the documented second line of defence does not exist. The live infrastructure has also drifted from Terraform, so any document or alarm that assumes `logs.tf` or `log-protection` is applied is wrong. Even once applied, the policy only covers e-mail, Saudi mobile, 10-digit IDs starting 1/2, JWTs and S3 signatures (`log-protection/main.tf:19-33`). It cannot detect names, clinical text, Egyptian 14-digit IDs, Arabic-Indic digits, IP addresses, card numbers or provider API keys. Principals with `logs:Unmask` still see originals, and masking applies only to data ingested after the policy exists.
- **Fix:** run `terraform plan` and then apply `module.log_protection` for production. Decide explicitly who, if anyone, holds `logs:Unmask`. Ship `logs.tf` in the same change as the image it was written for (this has already drifted).
- **Verifying test:** `get-data-protection-policy` returns the document for each group. Then send one synthetic canary event to a non-production group that has the same policy, and confirm that `FilterLogEvents` and Insights return it masked, while the `LogEventsWithFindings` metric increments.

##### LSA-03 — OpenTelemetry would export client IP, user agent, capability tokens, path PII and exception text; nothing restricts the export destination
- **Severity / confidence:** High if enabled / High. **Currently inactive** (`OTEL_ENABLED` is absent from both live task definitions).
- **Where:**
  - `src/common/logging/tracing.ts:119-170`. The hooks strip only the query string. `http.target`/`url.path` keep the raw path; `client.address` and `user_agent.original` are left as instrumented.
  - `tracing.ts:109`: `new OTLPTraceExporter()` with no options, so it takes `OTEL_EXPORTER_OTLP_*` from the environment unchecked.
  - `src/config/env.validation.ts:1002-1004` allows `http`.
  - `infra/terraform/modules/network/security_groups.tf:65-72`: task egress `0.0.0.0/0:443`.
- **Reproduce:** `node otel-canary.cjs <repo> <pgPort> <redisPort>` runs the repo's own `startTracing('api')` against a local receiver and searches the exported OTLP JSON.

| Canary | Exported in |
|---|---|
| `/public/pay/<capability token>` | `http.target`, `url.path` (incoming); `url.full`/`url.path`/`http.url` (outgoing) |
| Patient phone in an outgoing path | `url.full`, `url.path`, `http.target` |
| `X-Forwarded-For` value | `client.address` (the left-most entry: client-controlled, and the real end-user IP behind Vercel) |
| User-Agent | `user_agent.original` |
| Arabic name and phone in a thrown error | Express span `status.message`, `exception.message`, `exception.stacktrace` (not scrubbed) |
| Literal value inside SQL text | `db.query.text` (no such literal found in app code; see below) |
| **Not** exported | Cookie, Authorization, query-string tokens, `X-Tenant-ID`, SQL parameters, Redis keys and values, request body |

- **Data at risk:** IPs and device fingerprints linked to `trace_id` (which is also written on every log line when tracing is on, with `user_id`/`tenant_id`); payment-link and appointment-action tokens (usable to act on a patient's booking or payment); path-borne identifiers; error text.
- **Leak status:** **Confirmed** in the isolated test. **Not active** in production.
- **Impact:** turning on one environment variable would send this data to whatever endpoint the variable names, over plaintext if it says `http://`, and anywhere on the internet. That would also break the Saudi data-residency plan; the egress scan does not see the OTLP exporter.
- **Fix:**
  1. Refuse to start when deployed (`isDeployedEnv`) unless the endpoint is `https://` and its host is on an explicit allow-list (an in-VPC collector).
  2. In the HTTP `requestHook`, set `http.target`/`url.path` to the redacted path (`sanitizeUrlForLog`'s `redactPathTokens`) and overwrite `client.address` and `user_agent.original`.
  3. Use a span processor that drops `exception.*` events and replaces `status.message` with the error type, or scrubs both with `scrubText`.
  4. Set `requireParentSpan` on undici and redact its path the same way.
  5. Never set `OTEL_EXPORTER_OTLP_HEADERS` from plain environment variables; use Secrets Manager.
- **Verifying test:** `otel-canary.cjs` must report `0 of 18 canaries`, and a new unit test asserts that `startTracing` refuses `http://` or a non-allow-listed host when `NODE_ENV=production`.

#### MEDIUM

##### LSA-04 — Names, clinical free text and unlisted field names bypass redaction (deny-list design limit)
- **Where:** `src/common/utils/sanitize.util.ts:59-99` (exact-match list), `:116-122`. `structured-logger.ts:241-249`: the message is scrubbed by shape only. Existing call sites interpolate `${err.message}` or `${res.error}` into messages (about 100 sites, for example `whatsapp-inbound-ai.service.ts:943`, `agent-whatsapp-dispatcher.service.ts:80`, `campaign-dispatch.service.ts:260`).
- **Reproduce:** `logger-canary.spec.ts` S1–S4, S7 and S13.
  - **Not redacted** (non-shape values leaked under 53 of 97 keys): `phoneNumber, patientPhone, mobile, mobileNumber, whatsapp, whatsappNumber, wa_id, msisdn, to, emailAddress, patientEmail, name, doctorName, staffName, guardianName, parentName, guardian, medicalNotes, medical_notes, clinicalNotes, diagnoses, icd10, symptom, chiefComplaint, prescription, medicalHistory, iqama, iqamaNumber, passportNumber, idNumber, dob, birthDate, gender, policyNumber, code, verificationCode, message, payload, data, details, description, reason, query, search, q, url, comment, caption, transcript, subject, title, answer, visitReason`.
  - Phone or e-mail values under those keys **were** caught by shape scrubbing (0 phone leaks across all 97 keys).
  - Names (English and Arabic), guardian, doctor, clinic, diagnosis, symptom, medication, history, address and visit reason leaked inline in messages, in error messages and one-level `cause`, in the fatal-handler line, in JSON strings and in nested neutral keys.
- **Leak status:** **Confirmed** (canary). In production: 2 `ExceptionFilter` lines with Arabic template text (clinic data). Patient free text not observed.
- **Impact:** any current or future call site that logs a provider message, an exception message or a neutral-keyed object containing patient text writes it unmasked. CloudWatch masking would not help either: names and clinical text are not detectable by pattern.
- **Fix:** move from deny-list to allow-list for structured fields: only known-safe keys (`*_id`, `status`, `count`, `duration_ms`, …) pass, and everything else is replaced with `[type:len]`. Extend the exact list now (the leaked keys above) as a stop-gap. For messages, have high-risk call sites log `error.type` and a provider error **code** rather than the provider's message text. Add a lint rule against interpolating `err.message` or `res.error` into log templates in modules handling patient data.
- **Verifying test:** S1 must show 0 leaks for the 53 keys (with the allow-list, any unknown key). S3 and S7 must leak no non-shape canary.

##### LSA-05 — Value-shape scrubber gaps
- **Where:** `src/common/utils/log-scrubber.util.ts:31-46` (patterns), `:53` (`PG_KEY_DETAIL_RE`).
- **Reproduce:** direct `scrubText` probes and S3/S5/S9. Leaked:
  - `(059) 900-0113` and `059.900.0114` (separators other than space or dash)
  - 7–8 digit local numbers
  - `%2B966…` (a URL-encoded `+`; the `B` defeats the `(?<![\w-])` look-behind)
  - `sk-proj-…` (OpenAI), `sk_live_…` (Tap), `AKIA…` (AWS)
  - `Cookie: name=value`
  - a 6-digit OTP in text
  - IPv4 addresses in text
  - `Key (lower(full_name::text))=(<name>)` (nested parentheses defeat the PG detail regex)

  Caught: JWT, `Bearer …`, `X-Amz-Signature`, e-mail, 9–19 digit runs including Arabic-Indic, card and IBAN digit groups.
- **Leak status:** **Confirmed** (canary). The expression-index variant is **Potential**: no expression unique index on a patient column exists in the current migrations.
- **Fix:** add patterns for `sk-[A-Za-z0-9_-]{20,}`, `sk_(live|test)_\w+`, `(AKIA|ASIA)[A-Z0-9]{16}`, `Cookie:`/`Set-Cookie:` header values, and `(\d{2,4}[ .()-]){2,}\d{3,}`. Decode `%2B` before the digit pass. Make `PG_KEY_DETAIL_RE` tolerate nested parentheses, or redact everything after `Key (` up to ` already exists`/` conflicts`.
- **Verifying test:** S3/S5 canaries `phoneParen`, `phoneDots`, `openaiKey`, `tapKey`, `awsKey`, `cookieVal` come back `clean`, plus a probe for the expression-index detail.

##### LSA-06 — Exception filter logs the raw `originalUrl` (path parameters and non-listed query values)
- **Where:** `src/common/filters/all-exceptions.filter.ts:177` (`path: sanitizeUrlForLog(request.originalUrl)`); `sanitize.util.ts:106` (only `q`/`search` plus key-sensitive names are redacted); `:135-150` (path tokens only).
- **Reproduce:** S9.
  - `GET /api/v1/customers?name=<ar>&guardian=…&reason=…&mobile=%2B966…` → 404 line `path` contains the Arabic name, guardian, visit reason and phone.
  - `/customers/by-phone/%2B966…` and `/by-phone/<name>` leak through the path.
  - Unmatched routes (`/no-such-route/<name>?q=<ar>`) leak too.
- **Data at risk:** every patient identifier or search term carried in a URL of a request that fails (any 4xx/5xx), plus the patient or record UUIDs in paths. The access log is not affected: it uses the route template.
- **Leak status:** **Confirmed** (canary).
- **Impact:** the most easily triggered patient-data path. A typo search, an expired session (401) or a validation error on a search screen is enough. Unmatched 404 paths also let anyone write up to about 10 KB of arbitrary text per request into the logs (log poisoning and cost).
- **Fix:** log `route` (already present) and **only** the query parameter **names** (`query_keys: ['page','search']`), never values. Drop `path` for `route === 'unmatched'`, or cap it at about 200 characters after scrubbing.
- **Verifying test:** the S9 "query string" and "path param" cases must be `clean` for all canaries.

##### LSA-07 — `body_shape` keeps numeric values and object keys
- **Where:** `src/common/utils/log-scrubber.util.ts:164-189` (`typeof value === 'number'` → returned as-is; keys are copied verbatim).
- **Reproduce:** S9 "body numeric" and "dynamic KEY". `mobile: 966599000119` (a number) was logged, vitals `83.4`/`151` were logged, and a user-defined key (a symptom text used as a property name) was logged.
- **Leak status:** **Confirmed** (canary).
- **Fix:** log numbers as `number` (keep booleans). Replace keys that do not match `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`, or that are not on the DTO, with `[key]`.
- **Verifying test:** the same S9 cases must be `clean`.

##### LSA-08 — Full client IP linked to user and tenant on security events; the IP is the wrong address for browser traffic
- **Where:** `all-exceptions.filter.ts:209-212` (`formatClientIp(request.ip, 'full')` on every 401/403/429/failed login). `auth.service.ts:394` (login success) and `:895` (refresh-token reuse), both with `user_id` and `tenant_id`. `src/config/trust-proxy.ts:69-84`. `TRUST_PROXY_HOPS=1` is live.
- **Reproduce:** S9-IP. With hops=1 and `X-Forwarded-For: 203.0.113.9, 198.51.100.77`, the security line logged `198.51.100.77` (the last, ALB-appended entry) and the access line logged `198.51.100.0`.
- **Data at risk:** personal data (an IP address) joined to a staff identity and a clinic, retained 30 days, unmasked (IPs are not in the masking set).
- **Leak status:** **Confirmed** by code and test. In production: no `auth.*` event had a full IP in the window (low traffic).
- **Impact:**
  - **Privacy:** an IP plus user plus tenant on every login is more than operations need. The /24 used by the access log would serve brute-force correlation.
  - **Correctness:** browser REST traffic arrives through the Vercel rewrite, so `req.ip` is **Vercel's egress address**, shared by every user (the code says so itself, `trust-proxy.ts:72-74`). The failed-logins-per-IP alarm (`logs.tf:206-235`, not applied) would therefore aggregate unrelated users, and a WAF block on that IP would block everyone. For direct callers (WebSocket, webhooks, API keys) the IP is the real one.
- **Fix:** log a keyed HMAC of the IP (stable for burst detection, not reversible without the key), or the /24, on security events. Keep the full IP only on `auth.refresh.reuse_detected`, if anywhere. Do not apply the IP-keyed alarm until the Vercel edge-token path (`EDGE_PROXY_TOKEN`) supplies the real client address.
- **Verifying test:** S9-IP must show a non-IP value or a /24.

#### LOW

##### LSA-09 — Client-chosen `X-Request-ID` is accepted, echoed and logged verbatim, bypassing the digit scrubber
- **Where:** `src/common/middleware/request-context.middleware.ts:10,31-35`; `structured-logger.ts:79-80,333-339` (`ID_KEYS` exemption); `log-context.ts:221` (the context is not sanitized).
- **Reproduce:** S9-RID. `X-Request-ID: 0599000111` and `Zqxcanary.Patientname` were both echoed and logged unchanged. Values over 128 characters were replaced, and CR/LF cannot be sent at all.
- **Impact:** no security decision uses the ID (verified: correlation only). A client can make its own lines carry a chosen string, or reuse another request's ID so that unrelated events correlate during an investigation. The value also flows into job `correlationId`.
- **Leak status:** **Confirmed** (canary). Low impact.
- **Fix:** accept a client ID only from trusted callers (edge token), or always generate one and log the client value separately as `client_request_id` after `scrubText`.
- **Test:** S9-RID must log a server-generated UUID as `request_id`.

##### LSA-10 — Structured fields can overwrite context identity fields
- **Where:** `structured-logger.ts:267-272` (`...currentLogContext(), ...fields`).
- **Reproduce:** S11. `{tenant_id:'spoofed-tenant', user_id:…, request_id:…}` won over the ALS values.
- **Leak status:** **Confirmed**. No user-input path found; risk comes only from internal code. Low.
- **Fix:** add `request_id`/`user_id`/`tenant_id`/`trace_id`/`span_id` to `RESERVED_KEYS` (renamed `data_*`), or spread the context last.
- **Test:** S11 must report the ALS values.

##### LSA-11 — No size cap per record
- **Where:** `structured-logger.ts:326-347` (each string is capped at 10 KB, but the record is not).
- **Reproduce:** S12. A 2,000-element array produced a 225 KB line, close to the 256 KB CloudWatch event limit.
- **Fix:** cap the serialized record (for example 32 KB) and arrays (for example 50 items).
- **Test:** S12 line length ≤ the cap.

##### LSA-12 — CLI processes (migrate/seed) print raw text; production migrate log holds the super-admin e-mail
- **Where:** `src/seed/seed.logger.ts:13-17` (falls back to `console` when no root logger exists, as in the migrate CLI); `src/seed/admin.seed.ts:87`; `src/migrate.ts`.
- **Evidence:** production `/ziyaratech/production/migrate`: 2 lines containing an e-mail address, classified as admin-seed output.
- **Leak status:** **Confirmed** (staff PII).
- **Fix:** in seed and migrate output, log `admin user present` without the address, or call `scrubText`.
- **Test:** grep the migrate container output for `@`.

##### LSA-13 — RDS PostgreSQL server log contains row values and ad-hoc statements
- **Where:** RDS log export (`modules/rds/main.tf:152`). `log_parameter_max_length{,_on_error}=0` correctly suppresses bind parameters, but `DETAIL: Key (…)=(…)` lines and the text of non-parameterized statements are still logged.
- **Evidence (count-only):** 4 `DETAIL: Key ("tenantId", name, language)=(…)` lines (template names, clinic data); 2 `STATEMENT:` lines of an ad-hoc `select` containing an e-mail address; 0 `Failing row contains`.
- **Leak status:** **Confirmed** (clinic and staff data). A patient-table unique violation would put patient values here as well (**Potential**).
- **Fix:** apply the same data-protection policy (LSA-02). Consider `log_error_verbosity = terse` (drops `DETAIL`). Run operator queries parameterized or through a bastion that does not log.
- **Test:** count query `DETAIL:\s+Key \(` returns 0 after a forced unique violation in staging.

##### LSA-14 — Frontend and Vercel logs: weaker scrubber, plus logs outside the backend's control
- **Where:** `Ziyarati-font/app/lib/server-error-log.ts:43-60` (ASCII digits only, no names, no Arabic-Indic digits); no `vercel.json` (default function region). Next.js's own error logging and Vercel request logs (paths and **query strings** of every proxied `/api/*` call) are outside this code.
- **Leak status:** scrubber gaps **Confirmed** by reading the code. Vercel log contents, region and retention are **Not Verified**.
- **Fix:** reuse the backend scrubber patterns. Confirm the Vercel plan's log retention and region. Avoid PII in GET query strings (move searches to POST bodies), which also fixes LSA-06 at the source.

##### LSA-15 — Local observability stack: Loki has no authentication; Alloy mounts the Docker socket; local tracing is fully on
- **Where:**
  - `observability/loki/loki.yaml:4` (`auth_enabled: false`).
  - `observability/docker-compose.yml:66` (`/var/run/docker.sock:ro`; `:ro` does not restrict the Docker API, which is root-equivalent).
  - `observability/docker-compose.app.yml:28-30` (`OTEL_ENABLED: 'true'`, sampler 1 → the LSA-03 data reaches local Tempo for 7 days).
  - Verified safe: all ports bind `127.0.0.1`, Grafana anonymous access and sign-up are off, the password comes from a git-ignored secret file (`.gitignore:108`).
- **Impact:** acceptable on a single developer machine with synthetic data. Unsafe on any shared host, or with a copy of production data.
- **Fix:** document "synthetic data only". If the stack is ever shared: enable Loki multi-tenancy or an authenticating proxy, and use a Docker socket proxy that allows only read endpoints.

##### LSA-16 — Every clinic's logs sit in one log group; reader access cannot be verified
- **Where:** `modules/ecs/main.tf:89-94` (one group per role); `modules/kms/main.tf:24-30` (the root statement delegates to IAM); `modules/github-deploy/main.tf:120-124` (the deploy role reads **migrate** logs only, which is good). No human or ops roles are defined in Terraform.
- **Impact:** anyone with `logs:FilterLogEvents`/`StartQuery` on the group, plus `kms:Decrypt` through IAM, sees all tenants. Tenant isolation in logs depends entirely on IAM, which lives outside Terraform.
- **Leak status:** **Not Verified** (`iam` read access was not attempted; STS from this workstation timed out).
- **Fix:** keep human log access to a small break-glass role, deny `logs:Unmask` to everyone except an audited role, and put both in Terraform.

##### LSA-17 — Git history: no production secrets found by pattern; committed expired session cookies and test keys
- **Evidence:** `history-scan.mjs` over all 470 back-end and 209 front-end commits reports pattern, file and commit only.
  - `scripts/perf/load/session-cookie.txt` (tracked since 2026-08-09) holds JWT access and refresh cookies for a local perf run (claims `sub, tenantId, type, iat, exp`; expired 2026-08-09 and 2026-08-16).
  - `test/fixtures/zt012-tls/*.key` are test TLS keys.
  - `scripts/tap-sandbox/pay.js` holds a placeholder-style `sk_test_` value.
  - Postgres URLs in docs and helpers point to placeholders or `127.0.0.1`.
  - **Correction to the previous implementation report:** `.env.strix` and `app.json` exist only as git-ignored local files and have **no** history in either repo. The earlier statement that `.env.strix` "was committed" is not supported. The files still contain plaintext credentials on disk, so rotating them remains advisable.
- **Fix:** delete `session-cookie.txt` and add `scripts/perf/load/*.txt` to `.gitignore`. Confirm the JWT secret used for that perf run was never a production secret.
- **Limit:** pattern-based. A secret with no recognizable shape would not be found.

---

### 4. Verified-clean (tested; not "secure", only "no leak found by this test")

| Path | Test | Result |
|---|---|---|
| `Authorization`, `Cookie`, `X-Tenant-ID` headers | S9, OTel | Never read by the logger; not in spans |
| Request body text values (incl. login e-mail and password, tenant slug) | S9 | Not logged (shape only, but see LSA-07) |
| Malformed JSON body | S9 | Parser error text did not echo the body |
| `job.data` (phone, name, body), job `correlationId` with `+` | S8 | Not logged; unsafe correlation ID rejected |
| ORM entity / class instance as field or extra arg | S2 | Rendered as `[Customer]` |
| Error `cause.cause`, `AggregateError` inner errors, extra error props (`response.data`, `config.headers`) | S2 | Not serialized |
| JWT, Bearer, e-mail, ASCII and Arabic-Indic phone, national ID, Egyptian ID, card, `X-Amz-Signature` in text | S3, S5 | Scrubbed |
| Capability token in path (`/public/pay/:token`) in the filter `path` | S9 | Replaced with `:token` (but exported by OTel, LSA-03) |
| CR/LF / U+2028 in message, field, key, context | S10 | No forged line; JSON-escaped |
| SQL parameters, Redis keys and values, query-string tokens in spans | OTel | Not exported |
| Prometheus labels | code review | Closed label sets, no tenant or user labels |
| `/metrics` auth | code review + live config | `METRICS_TOKEN` is in the production secret list; fail-closed when unset; constant-time compare; worker `:9091` has no SG ingress |
| ElastiCache slow log | count-only | 149 entries, command names only classified, 0 with ID or e-mail shapes |

---

### 5. Sensitive-field placement matrix

Legend: **L** = proven leak · **p** = potential (path exists, not observed) · **–** = not present (tested or by construction) · ? = not verified.

| Field | App structured log | Raw console (TypeORM/CLI) | RDS log | Spans (if enabled) | Metrics | Alarm / SNS text | Insights / Contributor Insights | Vercel |
|---|---|---|---|---|---|---|---|---|
| Patient name (EN/AR) | **L** (LSA-04/06, inline, neutral keys, URL) | **L** (LSA-01) | p | **L** (exception text) | – | – | **L** (shown unmasked; LSA-02) | ? |
| Phone (ASCII / intl) | – by shape · **L** via `%2B`, `( )`, `.` formats, X-Request-ID | **L** | p | **L** (path) | – | – | as log | ? |
| E-mail | – | **L** | **L** (ad-hoc statement) | p | – | – | as log | ? |
| National / Iqama ID | – | **L** | p | p | – | – | as log | ? |
| Diagnosis / notes / symptoms | **L** (unlisted keys, inline) | **L** | p | **L** (exception text) | – | – | as log | ? |
| Visit reason / appointment detail | **L** | **L** | p | p | – | – | as log | ? |
| Guardian / parent | **L** | **L** | p | p | – | – | as log | ? |
| Numeric clinical values | **L** (body_shape) | **L** | p | – | – | – | as log | ? |
| Clinic data (template text, slug, names) | **L** (production, 2 lines) | **L** (production, 4 lines) | **L** (production, 4 lines) | p | – | – | as log | ? |
| `tenant_id` | by design on most lines | **L** (production, 33 lines) | p | – (no attribute) | – | – | by design | – |
| Client IP | /24 (access) · **full** (security events) | – | connection logs ? | **L** (`client.address`) | – | – | Contributor rule keys on IP (not applied) | ? |
| User agent | – | – | – | **L** | – | – | – | ? |
| Capability tokens (pay / action links) | – (filter) | **L** if bound to a failing query | p | **L** | – | – | – | ? (Vercel request log path) |
| JWT / Bearer / cookies | – | **L** if bound | – | – | – | – | – | ? |
| Provider API keys (`sk-…`, `sk_live_…`, `AKIA…`) in error text | **L** (shape gap) | p | – | p | – | – | as log | – |
| OTP (6-digit) in text | **L** | p | – | – | – | – | as log | – |

Alarm and SNS bodies (`logs.tf` alarm descriptions) contain only alarm names, thresholds and query names, with no log content. CloudWatch alarm notifications carry metric values, not log lines. **Not Verified:** the SNS subscription itself.

---

### 6. Test results

| Suite | Where | Result |
|---|---|---|
| Logger canaries (S1–S5, S7, S8, S10–S13) | `canary/logger-canary.spec.ts` → `results-logger.json`, `field-key-results.json` | 67 checks: **38 LEAK**, 29 clean (S10/S11/S12 "LEAK" rows are hygiene findings, not data); 97 field names: **53 leak** non-shape values, 0 leak phone values |
| HTTP + DB canaries (S6, S9) | `canary/http-db-canary.spec.ts` (real Nest pipeline in `main.ts` order, real PostgreSQL 18, TypeORM logger as in production) → `results-http.json` | 49 checks: **24 LEAK**, 25 clean. Note: the S6 "structured log: unique violation detail" row reads `clean` only because the check was case-sensitive and PostgreSQL lowercases `lower(full_name)` key values. The direct `scrubText` probe shows it **leaks** (LSA-05). |
| OpenTelemetry export | `otel-canary.cjs` (repo `startTracing`, receiver on 127.0.0.1:54318, sampler 1.0) | 26 spans exported; **7 of 18** canaries present (§3 LSA-03) |
| Request ID | S9-RID | client value accepted verbatim (pattern-valid); >128 chars replaced; CR/LF unsendable |
| Client IP | S9-IP, live config | `TRUST_PROXY_HOPS=1` live; last XFF entry used; security lines full IP, access lines /24 |
| Production log counts (30 days, count-only) | `cw-counts.sh`, `cw-classify.sh` | 107,215 lines; TypeORM `-- PARAMETERS:` 37; e-mail-shaped 2 (migrate); Saudi-mobile 0; 10-digit ID 0; JWT 0; noop-provider lines 0; raw `Failing row` / `Key ()=()` 0 (app groups); Arabic text 6 |
| RDS / ElastiCache log counts | count-only | RDS: 3,671 lines, `DETAIL: Key` 4, `STATEMENT` 41, e-mail-shaped 2, bind parameters 0. ElastiCache: 149, ID-shaped 0 |
| Masking | AWS read-only | no policy on any group; no account policy |

Reproduce:
```bash
docker run -d --name zt-logaudit-pg -e POSTGRES_PASSWORD=audit_local_only -e POSTGRES_DB=audit -p 127.0.0.1:55439:5432 postgres:18
docker run -d --name zt-logaudit-redis -p 127.0.0.1:56389:6379 redis:7-alpine
cd Ziyarati-back && npx jest --config ../docs/logging-security-audit-2026-10-14/jest.audit.config.js --runInBand --forceExit
node ../docs/logging-security-audit-2026-10-14/otel-canary.cjs "$PWD" 55439 56389
docker rm -f zt-logaudit-pg zt-logaudit-redis
```
(`jest.audit.config.js` and the specs hold absolute paths to this workstation's checkout. Adjust `REPO` if the folder moves.)

---

### 7. Secrets in git history (values never shown)

See LSA-17. Summary: no production credential pattern found (OpenAI, Tap live, AWS, Meta, Resend, GitHub, Slack, private keys outside test fixtures, credentialed non-local Postgres URLs, or `JWT_*`/`*_SECRET` assignments with real-looking values) in either repo's full history. Present: expired perf-run JWT cookies (`scripts/perf/load/session-cookie.txt`), three test TLS private keys under `test/fixtures/zt012-tls/`, and test-only `sk_test_`/`sk_live_` strings in specs. `.env`, `.env.strix`, `.env.production.local`, `app.json` and `Ziyarati-font/.env.local` are untracked and git-ignored, with no history. The Docker build context excludes `.env*` (`.dockerignore`) and the image copies only `src`, `scripts` and the manifests.

---

### 8. Not verified (needs access this audit did not have, or chose not to use)

| Item | Why not verified |
|---|---|
| Which IAM principals can read the production log groups, run Insights, or hold `logs:Unmask`; human access paths | IAM reads not attempted; STS endpoint timed out from this workstation; human roles are not in Terraform |
| Masking behaviour once applied (which patterns fire on real lines, false positives such as `request_id` fragments) | Policy has never been applied |
| Whether metric filters and subscription filters see masked or unmasked text | Requires the policy to be live |
| SNS topic subscriptions and recipients | Not queried |
| Vercel runtime and request log contents, region, retention, drains, team access | No Vercel access |
| Contents of the 2 `ExceptionFilter` Arabic lines and the 4 template parameter lines beyond classification | Deliberately not read, to avoid exposing data |
| Absence of patient names or clinical text in production logs | Not detectable with count queries; only shaped identifiers were counted |
| Behaviour of a real Meta, Tap, OpenAI or Resend error body in logs | Only synthetic provider errors were used |
| Staging environment | Not inspected |

---

### 9. Prioritized remediation plan (smallest safe change first)

| Priority | Item | Change | Size |
|---|---|---|---|
| **P0** | LSA-01 | `MetricsAwareTypeOrmLogger.logQueryError`/`logQuerySlow`: structured line with verb, table, SQLSTATE and constraint only; never `parameters` or SQL literals | ~30 lines + S6 test |
| **P0** | LSA-02 | `terraform plan` → apply `module.log_protection` (production and staging); decide `logs:Unmask` holders; verify with a synthetic canary in a non-production group | Terraform apply (needs approval) |
| **P0** | LSA-03 | Keep `OTEL_ENABLED` unset. Add a production guard in `startTracing` (https + allow-listed host, else refuse) before anyone can flip it | ~15 lines + test |
| **P0** | LSA-06 | Filter: replace `path` with `query_keys` (names only); drop or cap `path` for unmatched routes | ~10 lines + S9 test |
| P1 | LSA-04 | Extend the exact key list with the 53 leaked names now; then move structured fields to an allow-list | small / medium |
| P1 | LSA-05 | Add provider-key, cookie, formatted-phone and `%2B` patterns; nested-parentheses PG detail | small |
| P1 | LSA-07 | `body_shape`: numbers → `number`; sanitize keys | small |
| P1 | LSA-08 | HMAC or /24 the IP on security events; do not apply the IP-keyed alarm until edge-token IPs exist | small |
| P1 | LSA-12, LSA-13 | Drop the e-mail from seed output; `log_error_verbosity=terse` (RDS) | small |
| P2 | LSA-09/10/11 | Request-ID trust, reserved context keys, record size cap | small |
| P2 | LSA-14/15/16/17 | Frontend scrubber parity, Vercel log review, local-stack note, IAM in Terraform, delete committed cookies | small / organizational |
| Process | — | Ship `logs.tf` with the image it was written for (currently drifted); re-run this audit's harness in CI as a regression gate | — |

Each fix's verifying test is the corresponding canary case in §6, flipped from `LEAK` to `clean`.

---

### 10. OpenTelemetry decision

**OpenTelemetry stays disabled (`OTEL_ENABLED` unset) in production and staging** until all of the following hold:
1. LSA-03 fixes 1–5 are implemented, and `otel-canary.cjs` reports **0 of 18** canaries.
2. A collector exists inside the VPC in `eu-central-1` (or the approved residency region), reachable over TLS, and `startTracing` refuses any other endpoint.
3. The subprocessor/egress register lists the trace store, and its retention and access are defined like the log groups'.
4. LSA-01 is fixed, because `trace_id` on log lines would otherwise join raw-parameter lines to spans.

Verified today: no live task definition sets any `OTEL_*` variable; tracing is off.

---

## Part E: Privacy remediation report (2026-10-14)

> **Former file:** `LOGGING-PRIVACY-REMEDIATION.md` — written before commit `daf8b95`; see A.3 D1

| | |
|---|---|
| Date | 2026-10-14 |
| Remediates | `Ziyarati-back/LOGGING.md (Part D)` (2026-10-14): LSA-01 … LSA-17 (0 Critical · 3 High · 5 Medium · 9 Low) |
| Code base | `Ziyarati-back` HEAD `44cbbc7` + this working-tree change set (uncommitted); `Ziyarati-font` HEAD `0cea804` + 2 files |
| Production state | **Unchanged.** Image `backend:44cbbc7` still runs (`zt-production-api:14`, `zt-production-worker:12`). No deploy, no `terraform apply`, no IAM/retention/log change, no OTel activation, no commit. |
| Location | `docs/` — the established home of this repo's security reports (`SECURITY-*.md`, `Ziyarati-back/docs/PAYMENTS.md (Part B)`); the requested `docs/security/` folder does not exist, so the convention was reused. |
| Evidence | Regression specs in the repo (listed in §4); the audit harness re-run, with its fixes, in `D:\projects\Ziyarati-full\docs\logging-privacy-remediation-2026-10-14\` (outside both repos; synthetic data only) |

---

### 1. Executive summary and residual risk

**Local status: the three High findings and four of five Medium findings are fixed in code and proven by regression tests on the final serialized output. Production status: nothing is fixed yet** — the remediated code is not deployed and the masking policy is not applied. Treat the rollout in §8 as the hotfix.

What changed, in one line each:

- **LSA-01 (High):** TypeORM can no longer print SQL or bound parameters. Every DataSource (API, worker, migration runner, migrate CLI, seed CLI) uses `SafeTypeOrmLogger`, which writes one `database.query.failed` line with verb, table, SQLSTATE and constraint. Canary: raw-console parameter leaks **6 → 0**.
- **LSA-02 (High):** Root cause found. The production root had never been applied with `module.log_protection` (it is absent from remote state), **and the current production plan failed outright** (`logs.tf` used the invalid operator `GreaterThan`), so no plan or apply of this stack could have succeeded. The plan error is fixed; a **targeted plan (8 to add, 0 to change, 0 to destroy)** is ready. **Not applied — BLOCKED on approval.**
- **LSA-03 (High):** In production and staging, tracing now refuses to start unless the endpoint is `https://` and its host is allow-listed. Every span is sanitized before export. Canary: **7 → 0 of 18**; production mode with an `http://` endpoint refuses to start. `OTEL_*` was re-verified absent from live task definitions, deploy workflows and Terraform.
- **LSA-06 (Medium):** The exception filter logs the route template and `query_keys` (names only), never the URL. Nest's `Cannot GET <raw url>` message is rewritten. Canary: URL leaks **8 → 0**.
- **LSA-04/05/07/08/09/10/11/12/14/17:** fixed locally (details in §2). LSA-13 and LSA-16 need production decisions (§8).

**Residual risk (honest):**

1. **Free text in the *message* channel is still only shape-scrubbed (LSA-04, partial).** A name or clinical wording interpolated into a log message, an exception message or a stack — `` `send failed for ${name}` ``, `${err.message}` of a provider error that echoes patient text — is still written. Canary after remediation: 21/67 logger checks and 3/49 HTTP checks still LEAK, **every one of them in message / error-message / stack text**; structured fields are clean. CloudWatch masking cannot catch names either. Fixing this means changing the ~100 call sites that interpolate `err.message`. That is a broad refactor this task excludes, so it is listed as the first follow-up.
2. **Production still holds what was already written:** 37 TypeORM parameter lines, 2 migrate lines with the admin e-mail, and 6 lines with Arabic template text, retained 30 days (expire by about 2026-11-11). Nothing was deleted, as instructed. Masking, once applied, does **not** apply retroactively.
3. **Masking is not live** until the targeted apply is approved and verified.
4. Two IAM principals can unmask today (§2 LSA-16). One of them is a long-lived IAM user outside Terraform.

---

### 2. Findings: verified status and remediation

Each finding was re-verified against the code at `44cbbc7` before changing it. The code was identical to what the audit described, except that **LSA-01 was broader than reported**: `run-migrations-with-lock.ts` (`logging: ['error']`) and `seed/data-source.ts` also used TypeORM's parameter-printing default.

Status vocabulary: **FIXED AND VERIFIED** (in production) · **FIXED LOCALLY ONLY** · **BLOCKED** · **NOT FIXED**. Because nothing was deployed or applied, no finding is FIXED AND VERIFIED.

| ID | Sev | Verified current state (before change) | Remediation | Status |
|---|---|---|---|---|
| LSA-01 | High | Confirmed. `MetricsAwareTypeOrmLogger` delegated to `AdvancedConsoleLogger` (`query failed: … -- PARAMETERS: [...]` via `console.log`); same default in the migration runner and the seed DataSource; `typeOrmFactory` without metrics fell back to `logging: ['error']`. | New `src/common/logging/typeorm-safe-logger.ts`. Failed query → `database.query.failed` (warn) with `operation`, `table`, `sqlstate`, `constraint`, `db_table`, `db_column`, `error_type`: an explicit allow-list, identifier-shaped values only. Never the SQL text, parameters, driver `message`/`detail`/`where`, or the error object. Slow query → `database.query.slow` with `duration_ms`. The dev-only per-statement echo (refused in production) drops parameters too. Wired into `typeorm.config.ts` (always, even without metrics), `run-migrations-with-lock.ts`, `config/data-source.ts` (migrate CLI) and `seed/data-source.ts`. `migrate.ts` scrubs its failure message and stack. The exception still propagates, so the filter or job wrapper keeps logging the failure once. | FIXED LOCALLY ONLY |
| LSA-02 | High | Confirmed live (read-only): `dataProtectionStatus=None` on all four `/ziyaratech/production/*` groups (**including `ops`, missing from the audit**); no account policy. Remote state has **no** `module.log_protection` resources. `terraform plan` **failed** on `logs.tf:118/124` (`comparison_operator = "GreaterThan"`). | Fixed the operator (`GreaterThanThreshold`). Extended the policy with `OpenAiApiKey`, `TapSecretKey`, `AwsAccessKeyId` and `EgyptianNationalId` (module tests pass). Produced a targeted plan for all 8 production groups (§6). `logs:Unmask` review in LSA-16. | **BLOCKED** (apply needs approval) |
| LSA-03 | High | Confirmed in code (`new OTLPTraceExporter()` read any endpoint; hooks stripped only the query). Re-verified: `OTEL_*` count = 0 in `zt-production-api:14` and `zt-production-worker:12`; none in `.github/workflows/*` or Terraform. | `tracing.ts`: (1) `resolveTraceExporterUrl` — deployed ⇒ `https://` + host in `OTEL_ALLOWED_COLLECTOR_HOSTS`, otherwise refuse (`tracing.start_refused`, app keeps running); credentials in the URL are always refused; the exporter gets the validated URL explicitly. (2) `SanitizingSpanProcessor` — URL attributes become the route template or `:param` path; `client.address`, user agent, `url.query` and header attributes are dropped; attributes outside the semantic-convention allow-list are dropped; exception events keep `exception.type` only; `status.message` = error type; SQL string literals become `'?'`; all strings are shape-scrubbed. (3) undici `requireParentSpan`. New env keys in `env.validation.ts`. `tracing.ts` registered in the subprocessor egress register. | FIXED LOCALLY ONLY (OTel remains **disabled**) |
| LSA-04 | Med | Confirmed: deny-list design; 53 of 97 field names leaked non-shape values. | `sanitizeLogFields` **allow-list** used by `StructuredLogger` for every structured field, extra argument and non-string message (rules in `LOGGING.md` §8). Error objects inside fields keep type and scrubbed message. The exact PII deny-list was extended with the audit's leaked names (stop-gap for other `sanitizeForLog` callers). Field matrix: **53 → 1** key (`message`, the message channel). | FIXED LOCALLY ONLY — **partial**: free text in messages, error messages and stacks NOT FIXED (§1 residual 1) |
| LSA-05 | Med | Confirmed by direct `scrubText` probes. | `log-scrubber.util.ts`: `%2B` decoding, nested-parenthesis `Key (…)=(…)` plus a fallback, provider keys (`sk-`, `sk_live_`, `rk_`, `whsec_`, `AKIA`/`ASIA`, `gh*_`, `xox*-`), `Cookie:`/`Set-Cookie:`, OTP next to its keyword (EN/AR), bracketed/dotted phones, bare 7–8 digit numbers, public IPv4 kept as /24 (private ranges kept). Provider error codes, timestamps, durations, versions and private IPs are preserved (tested). | FIXED LOCALLY ONLY |
| LSA-06 | Med | Confirmed: `path: sanitizeUrlForLog(originalUrl)`; also Nest's 404 message `Cannot GET <raw url>`. | `path` removed. `query_keys` holds names only (sorted, identifier-shaped, else `[key]`, max 20), plus `route` (template or `unmatched`). The `Cannot <METHOD> <url>` message is rewritten to `Cannot <METHOD> <route>`. The client error body still returns the caller's own URL to that caller (not a log). | FIXED LOCALLY ONLY |
| LSA-07 | Med | Confirmed. | `summarizeBodyForLog`: numbers become `[number]`; non-identifier keys become `[key:N]`. | FIXED LOCALLY ONLY |
| LSA-08 | Med | Confirmed: full IP on security events (filter), on `auth.login.succeeded` and on `auth.refresh.reuse_detected`. | All three now log the /24 (/48) network. The full address of a refresh-token reuse stays in the access-controlled audit table. `enable_failed_login_ip_rule` now defaults to **false**: browser traffic shares Vercel's egress network, and the alarm text warns against WAF-blocking it. | FIXED LOCALLY ONLY (Terraform default not applied) |
| LSA-09 | Low | Confirmed. | A caller ID is honoured only if pattern-valid **and** machine-generated (contains a UUID or a 16+ alphanumeric run with a letter and a digit) **and** unchanged by `scrubText`; otherwise a server UUID is used. Keeps the upstream-correlation feature that `test/security/ai-w10-correlation-id.spec.ts` relies on (its `w10-cid-<uuid>` marker still passes). | FIXED LOCALLY ONLY. Residual: a deliberately token-shaped ID (letters glued to digits) is still accepted; it affects only that caller's own request lines, and no security decision uses the ID. |
| LSA-10 | Low | Confirmed. | The context keys (`request_id`, `user_id`, `tenant_id`, `platform_admin`, `trace_id`, `span_id`, `queue`, `job_name`, `job_id`, `attempt`) win when present. A differing caller value is kept as `data_<key>`. Outside a context, explicit IDs still log (filter, bootstrap). | FIXED LOCALLY ONLY |
| LSA-11 | Low | Confirmed. | Record cap of 32 KB. Over it, the line keeps context, event, message (2 KB), error (type, message, code, stack ≤ 8 KB), `truncated: true` and `original_bytes`. Arrays are capped at 50 and objects at 50 keys, depth 5. | FIXED LOCALLY ONLY |
| LSA-12 | Low | Confirmed: `admin.seed.ts` printed the e-mail; the console fallback printed raw text and dumped raw error objects. | The admin seed no longer prints the address. The seed console fallback is shape-scrubbed and prints only the type of a non-Error object. `migrate.ts` failure output is scrubbed. The 2 existing production lines remain until retention expiry. | FIXED LOCALLY ONLY |
| LSA-13 | Low | Confirmed in Terraform: `log_parameter_max_length{,_on_error}=0` (good); default `log_error_verbosity` (DETAIL logged) and `log_min_error_statement` (failing statement text logged); `log_min_duration_statement` logs slow statement text. | **Proposal only** (production parameter change), see §8 step 5. No Terraform edited. | **BLOCKED** (needs an operational decision and approval) |
| LSA-14 | Low | Confirmed: `server-error-log.ts` lacked Arabic-Indic digits, formatted phones, keys, cookies and path tokens. | Brought to parity with the backend patterns (`Ziyarati-font/app/lib/server-error-log.ts`, plus 11 tests). Vercel request and runtime log contents, region, retention and drains are **Not Verified** (no Vercel access). | FIXED LOCALLY ONLY (code) · Vercel platform NOT VERIFIED |
| LSA-15 | Low | Confirmed. | Documentation in `observability/docker-compose.yml`: synthetic data only; the risks of unauthenticated Loki, `docker.sock` and Tempo; what to do on a shared host. No technical change (single-developer, loopback-bound stack). | FIXED LOCALLY ONLY (documented) |
| LSA-16 | Low | **Now verified** with read-only `iam simulate-principal-policy` against `/ziyaratech/production/api`: `logs:Unmask` is **allowed** for IAM user `ziyarati-terraform` (this workstation's long-lived key; not in Terraform) and role `zt-production-tf-apply` (AdministratorAccess). Implicitly denied for all task, execution and deploy roles; the plan role cannot read logs (explicit deny). | Terraform (bootstrap root): explicit `Deny logs:Unmask` on `tf-plan` and a new inline `deny-log-unmask` policy on `tf-apply`. `ziyarati-terraform` is outside Terraform and needs a manual decision (§8). | **BLOCKED** (IAM change needs approval) |
| LSA-17 | Low | Confirmed: `scripts/perf/load/session-cookie.txt` tracked. Both JWTs inside are expired (2026-08-09 and 2026-08-16) and **verify against the local `.env` `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`** (checked by boolean only; no value printed). | File removed from the working tree; `scripts/perf/load/*.txt` added to `.gitignore`. It remains in git history (no history rewrite). Rotation: only needed if those local secret values were ever used in production — check with §8 step 7. | FIXED LOCALLY ONLY |

---

### 3. Files changed and why

**Backend (`Ziyarati-back`):**

| File | Why |
|---|---|
| `src/common/logging/typeorm-safe-logger.ts` (new) | LSA-01 value-free TypeORM logger |
| `src/config/typeorm.config.ts` | LSA-01: always the safe logger; metrics optional |
| `src/config/run-migrations-with-lock.ts`, `src/config/data-source.ts`, `src/seed/data-source.ts` | LSA-01: no parameter-printing default logger anywhere |
| `src/migrate.ts` | LSA-01/12: scrubbed CLI failure output |
| `src/common/logging/log-events.ts` | `database.query.failed` / `database.query.slow` |
| `src/common/filters/all-exceptions.filter.ts` | LSA-06 (`query_keys`, raw-URL message), LSA-08 (/24) |
| `src/common/utils/sanitize.util.ts` | LSA-04 allow-list `sanitizeLogFields`, extended exact list; LSA-06 `queryKeysForLog`; shared `redactUrlForLog` |
| `src/common/utils/log-scrubber.util.ts` | LSA-05 patterns; LSA-07 body shape |
| `src/common/logging/structured-logger.ts` | LSA-04 (allow-list wiring), LSA-10 (context precedence), LSA-11 (size cap) |
| `src/common/logging/tracing.ts` | LSA-03 guard and span sanitizer |
| `src/config/env.validation.ts` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_ALLOWED_COLLECTOR_HOSTS` |
| `src/common/middleware/request-context.middleware.ts` | LSA-09 |
| `src/modules/auth/auth.service.ts` | LSA-08 (/24 on login success and refresh reuse) |
| `src/seed/admin.seed.ts`, `src/seed/seed.logger.ts` | LSA-12 |
| `src/modules/crm/customer.service.ts` | Comment now matches the filter behaviour |
| `infra/terraform/modules/monitoring/logs.tf` | LSA-02 plan blocker (`GreaterThan` → `GreaterThanThreshold`); LSA-08 alarm text |
| `infra/terraform/modules/monitoring/variables.tf` | LSA-08: `enable_failed_login_ip_rule` default `false` |
| `infra/terraform/modules/log-protection/main.tf` + `tests/` | LSA-02/05: 4 extra masking identifiers + tests |
| `infra/terraform/bootstrap/main.tf` | LSA-16: deny `logs:Unmask` on tf-plan / tf-apply |
| `observability/docker-compose.yml` | LSA-15 documentation |
| `scripts/perf/load/session-cookie.txt` (deleted), `.gitignore` | LSA-17 |
| `LOGGING.md` | Request-ID, redaction, OTel and alarm sections match the new behaviour |
| Tests: `typeorm-safe-logger.spec.ts`, `tracing.spec.ts`, `logger-privacy.spec.ts`, `all-exceptions.filter.privacy.spec.ts`, `admin-seed-logging.spec.ts` (new); `test/utils/log-canaries.ts` (shared synthetic canaries, case-insensitive matcher); updated `typeorm.config.spec.ts`, `run-migrations-with-lock.spec.ts`, `all-exceptions.filter.spec.ts`, `http-logging.integration.spec.ts`, `request-context.middleware.spec.ts`, `sanitize.util.spec.ts`, `log-scrubber.util.spec.ts`, `subprocessor-egress.spec.ts` | Regression coverage; old tests updated only where they asserted the behaviour each finding removes |

**Frontend (`Ziyarati-font`):** `app/lib/server-error-log.ts`, `app/lib/server-error-log.test.ts` (LSA-14).

No migrations. No API contract change, except two intentional ones:
- a non-generated caller `X-Request-Id` is replaced with a server UUID (LSA-09);
- error-log lines no longer contain `path` (logs only; the response body is unchanged).

---

### 4. Tests executed (actual results)

| Check | Result |
|---|---|
| Backend full unit suite (`npx jest`), **before** the last fixes | 628 suites: 622 pass, 6 fail. The 3 failures caused by this change (request-ID expectation, egress register, `reason` enum) were fixed. |
| Backend: affected suites after fixes (`src/common`, `src/config`, `src/modules/auth`, `subprocessor-egress`, `src/seed`) | **53/53 suites, 1005/1005 tests pass** |
| Backend full unit suite, **final run** | **625 suites pass**, 2 skipped, 3 fail (42 tests): exactly the 3 environmental database suites below; 10,575 tests pass |
| Pre-existing, environmental failures | `advanced-analytics.service.spec`, `journey-aggregation.service.spec`, `journey-real-data.spec`: `connect ECONNREFUSED 127.0.0.1:5433` (need a local test Postgres; unrelated) |
| New regression specs | `typeorm-safe-logger` 20 · `tracing` 17 · `logger-privacy` 23 · `all-exceptions.filter.privacy` 7 · `admin-seed-logging` 3 = **70/70 pass** |
| Frontend `vitest app/lib/server-error-log.test.ts` | **14/14 pass** |
| Typecheck: backend `tsc -p tsconfig.build.json` | 0 errors in `src/`. `npm run build` reports 4 errors, all in `tests/load/lab/run/build-head/**`, a **git-ignored stray copy from 2026-10-05** that is absent from clean checkouts and the Docker build. With that directory excluded: **0 errors**. |
| Typecheck: frontend `tsc --noEmit` | 0 errors in changed files |
| Lint | New files clean. Modified files: no new errors relative to HEAD (`all-exceptions.filter.ts` 16, `auth.service.ts` 4 and `env.validation.ts` 4 Prettier errors are pre-existing). Frontend: 0 errors, 1 pre-existing warning. |
| Terraform | `fmt -check -recursive` clean; `validate` OK for `environments/production` and `bootstrap`; `log-protection` module tests **3/3 pass** (mocked provider) |
| Static sweep of changed paths | No `originalUrl` in any log payload (only `queryKeysForLog`); no `formatClientIp(…, 'full')`; no `AdvancedConsoleLogger` outside the safe logger's dev echo; no logger call with `parameters`; no bare `new OTLPTraceExporter()` |

**Harness validation (as required):**
- The audit's `leaked()` was case-sensitive, so a PostgreSQL lower-cased key value read as `clean`. It is now case-insensitive in both the repo canary utility and the re-run harness.
- The OTel harness search is now case-insensitive too, and it was taught to run in production mode (expect refusal) and development mode (exercise the sanitizer).
- Every capture-based spec asserts that a record was actually written before asserting "no leak", so an empty capture cannot pass.
- The OTel run exported **26 spans** (non-empty), so its "0 of 18" is meaningful.

---

### 5. Canary results: before → after

Same harness, same synthetic canaries, real Nest pipeline, real PostgreSQL 18 and Redis 7 in throwaway loopback containers (removed afterwards).

| Suite | Before (audit) | After |
|---|---|---|
| Logger canaries (S1–S5, S7, S8, S10–S13) | 38 LEAK / 67 | **21 LEAK / 67**, all message, error-message or stack text (S2 error message/cause/stack, S3 inline message, S4/S7 message half, S8 failure reason, S13 fatal line) |
| Field-name matrix (97 keys × non-shape value) | 53 keys leak | **1 key** (`message`, which is the message channel) |
| HTTP + DB canaries (S6, S9) | 24 LEAK / 49 | **3 LEAK / 49**: `AppError.cause` message, `HttpException` message, provider text interpolated into a message |
| — S6 raw-console TypeORM parameters | 6 LEAK | **0** (raw console capture: 0 lines, 0 `PARAMETERS`) |
| — S9 URL query, path params, unmatched route | 8 LEAK | **0** |
| — S9 body numeric values and dynamic keys | 3 LEAK | **0** |
| — S9 request ID (phone- or name-shaped) | 2 LEAK | **0** |
| OpenTelemetry export (18 canaries) | 7 / 18 | **0 / 18** (development mode, 26 spans); production mode with an `http://` endpoint: **tracing refused to start, 0 spans** |

**Remaining leaks:** only free text in message, exception and stack text (LSA-04 residual).

---

### 6. Terraform plan summary and unverified AWS state

All plans were **read-only** (`terraform plan -lock=false`, credentials of IAM user `ziyarati-terraform`). The plan files are kept outside the repo, in the session scratchpad.

| Plan | Result |
|---|---|
| Production, unmodified code | **FAILED**: `expected comparison_operator to be one of [...], got GreaterThan` (`logs.tf`). No plan or apply of this root could succeed. |
| Production, targeted `-target=module.platform.module.log_protection` | **Plan: 8 to add, 0 to change, 0 to destroy.** One `aws_cloudwatch_log_data_protection_policy` each for `/ziyaratech/production/{api,worker,migrate,ops}`, `/aws/rds/instance/zt-production-pg/{postgresql,upgrade}`, `/aws/elasticache/zt-production/slow-log` and `aws-waf-logs-zt-production`. Identifiers: managed EmailAddress plus custom SaudiMobileNumber, SaudiNationalIdOrIqama, JwtToken, PresignedUrlSignature, OpenAiApiKey, TapSecretKey, AwsAccessKeyId, EgyptianNationalId; audit and mask statements. |
| Production, full | **Plan: 50 to add, 4 to change, 3 to destroy.** Includes the 8 policies, `logs.tf` metric filters, alarms and saved queries, **3 SNS e-mail subscriptions** (send confirmation e-mails), **replacement of the 3 ECS task definitions** (Terraform tracks revision 1; the deploy pipeline registered up to api:14 and worker:12, and the definitions also differ in `APP_ENV`/`hostPort`), and an in-place RDS parameter-group update (`rds.force_ssl` `apply_method` drift). **Do not run a full apply as part of this hotfix.** |
| Bootstrap root (LSA-16 denies) | `validate` OK; **not planned** (different state and role, by design) |

**Unverified AWS state:**
- Masking behaviour once applied: which patterns fire, false positives, and whether metric filters see masked text.
- SNS subscribers.
- Human/SSO access paths and the root account.
- Whether the local `.env` JWT secrets equal production's.
- Staging: no staging stack exists (`terraform.yml` says so).
- Vercel log settings.

---

### 7. Local vs production verification

| | Local (done) | Production (not done) |
|---|---|---|
| LSA-01/04/05/06/07/08/09/10/11/12 code | Unit, integration and canary verified | Requires deploying a new image; then the §8 step 2 checks |
| LSA-02 masking | Module tests and targeted plan | Requires approved targeted apply plus a synthetic canary in a throwaway group |
| LSA-03 OTel | Guard and sanitizer verified; 0/18 | Verified **off** (no `OTEL_*` live); stays off |
| LSA-13 RDS | — | Proposal only |
| LSA-16 IAM | `simulate-principal-policy` (read-only) | Requires approved bootstrap apply plus a manual IAM-user decision |
| LSA-14 Vercel | Scrubber parity tests | Vercel log settings not verified |

Production remediation is **not** complete. Local tests passing does not change what production currently logs.

---

### 8. Blockers, risks, and recommended rollout order

Each step below is **awaiting explicit approval**; none was executed.

1. **Ship the application fix** (highest value: stops new leaks at the source). Commit, then run the normal pipeline (`deploy-aws.yml`: build → ECR scan → ECS rolling update of api/worker/migrate).
   - *Impact:* log shape changes: `path` → `query_keys`; free-text fields → `[string:N]`; `client_ip` becomes /24; non-generated caller request IDs are replaced; new `database.query.failed` events. No API or DB change.
   - *Check first:* any dashboard or query that reads `path`, the full `client_ip`, or free-text fields. `logs.tf` queries use `client_ip`/`reason`, which are still present.
2. **Verify after the deploy** (count-only, as in the audit):
   - TypeORM `-- PARAMETERS:` lines in `/ziyaratech/production/{api,worker,migrate}` since the deploy time = 0;
   - `database.query.failed` lines carry `sqlstate`;
   - filter lines have no `path` field;
   - `auth.*` `client_ip` ends in `.0` (or `::/48`).
3. **Apply masking, targeted:**
   ```bash
   cd infra/terraform/environments/production
   terraform plan -target=module.platform.module.log_protection -out=logprot.tfplan
   terraform apply logprot.tfplan
   ```
   Run this via the `infra-production` workflow, or locally after review.
   - *Expected:* 8 policies created, nothing else.
   - *Verify:* `aws logs get-data-protection-policy --log-group-identifier <group>` returns the document for all 8 groups. Then, with approval, create a throwaway group with the same policy, put one synthetic event (`canary.patient@example.test`, `0599000111`), confirm `filter-log-events` shows it masked, and delete the group.
   - *Cost:* CloudWatch data-protection scanning is charged per GB scanned.
   - *Know its limits:* no names or clinical text, not retroactive, and `logs:Unmask` holders still see originals.
4. **Restrict unmasking (LSA-16):**
   - Apply the bootstrap change (deny `logs:Unmask` on tf-plan and tf-apply) through the bootstrap's own reviewed procedure.
   - Decide on IAM user `ziyarati-terraform`. It has full log read **and** `logs:Unmask`; it is a long-lived key on a workstation and is not in Terraform. Recommended: attach an explicit `Deny logs:Unmask` (and ideally log-read) policy to it, or retire it in favour of role assumption.
   - Name a break-glass role (MFA, CloudTrail-alerted) if anyone must unmask; until then, nobody except root can.
5. **RDS server log (LSA-13), proposal:**
   - `log_error_verbosity = terse` removes `DETAIL: Key (…)=(…)` row values. Cost: DETAIL/HINT/CONTEXT are lost for every server error; the app's `database.query.failed` line still carries SQLSTATE and constraint.
   - `log_min_error_statement = panic` stops logging the failing statement text, which is where ad-hoc literals (the 2 e-mail lines) come from. Cost: operators lose the failing SQL in RDS logs.
   - `log_min_duration_statement` currently logs slow statement text: parameterized for app queries, but literal for ad-hoc `psql` queries. Keep it, and run ad-hoc queries parameterized or through a non-logging session (`SET log_min_duration_statement = -1` requires a privileged role).
   - Both settings are dynamic (no reboot). Apply through Terraform `modules/rds/main.tf` in a separate reviewed change.
6. **Monitoring (`logs.tf`):** apply separately, after deciding about the SNS e-mail subscriptions (they send external confirmation mails) and resolving the task-definition drift. The IP-keyed Contributor Insights rule is now off by default.
7. **LSA-17 secret check (boolean only, no value printed):** compare the SHA-256 of the local `.env` `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` with that of the production secret in Secrets Manager. Rotate production JWT secrets only if they match. Separately, rotate the plaintext credentials in the git-ignored local `.env.strix` and `app.json` (audit note).
8. **Follow-up for the residual (LSA-04 messages):**
   - Replace `${err.message}` / `${res.error}` interpolation at the ~100 call sites with `error_type` plus provider error **code** fields.
   - Add a lint rule for modules that handle patient data.
   - Re-run `logger-privacy.spec.ts` and the harness until S2/S3/S8/S13 are clean.

**OpenTelemetry:** stays disabled (`OTEL_ENABLED` unset) in production and staging. Code-side conditions are now met (guard, sanitizer, 0/18, LSA-01). Still open before it may be enabled:
- an in-VPC, in-region collector reachable over TLS whose host goes into `OTEL_ALLOWED_COLLECTOR_HOSTS`;
- the trace store's retention and access defined, and the subprocessor register updated;
- task egress for OTLP restricted to that collector (today `0.0.0.0/0:443`).

---

### 9. Rollback

| Change | Rollback |
|---|---|
| Application code (after deploy) | Redeploy the previous image: `aws ecs update-service --cluster zt-production --service zt-production-api --task-definition zt-production-api:14` (worker `:12`), or revert the commit and redeploy. No schema or data migration to undo. |
| Masking policies | `terraform destroy -target=module.platform.module.log_protection` or `aws logs delete-data-protection-policy --log-group-identifier <group>` per group. Reads become unmasked again; no log data is lost. |
| IAM unmask denies | Remove `deny-log-unmask` (tf-apply) / the `logs:Unmask` line (tf-plan deny) and re-apply bootstrap. |
| `enable_failed_login_ip_rule=false` | Set `true` in the environment's monitoring inputs. |
| `logs.tf` operator fix | No functional rollback needed (it only makes the plan valid). |
| `session-cookie.txt` removal | `git checkout HEAD -- scripts/perf/load/session-cookie.txt` (not recommended). |
| Frontend scrubber | `git checkout HEAD -- app/lib/server-error-log.ts app/lib/server-error-log.test.ts` |

---

### 10. Status of every finding

| ID | Status |
|---|---|
| LSA-01 | FIXED LOCALLY ONLY |
| LSA-02 | BLOCKED (targeted apply awaiting approval; plan blocker fixed) |
| LSA-03 | FIXED LOCALLY ONLY (OTel verified disabled in production) |
| LSA-04 | FIXED LOCALLY ONLY (partial: free text in messages, error messages and stacks NOT FIXED) |
| LSA-05 | FIXED LOCALLY ONLY |
| LSA-06 | FIXED LOCALLY ONLY |
| LSA-07 | FIXED LOCALLY ONLY |
| LSA-08 | FIXED LOCALLY ONLY |
| LSA-09 | FIXED LOCALLY ONLY |
| LSA-10 | FIXED LOCALLY ONLY |
| LSA-11 | FIXED LOCALLY ONLY |
| LSA-12 | FIXED LOCALLY ONLY |
| LSA-13 | BLOCKED (proposal; production parameter change needs approval) |
| LSA-14 | FIXED LOCALLY ONLY (Vercel platform settings NOT VERIFIED) |
| LSA-15 | FIXED LOCALLY ONLY (documentation) |
| LSA-16 | BLOCKED (IAM changes need approval; IAM user outside Terraform) |
| LSA-17 | FIXED LOCALLY ONLY (history unchanged; production-secret comparison pending) |

---

## Part F: Degraded-mode alert handoff (ZT-H06 / D7)

> **Former file:** `SECURITY_ALERTING_HANDOFF.md`

**Status**: operational handoff. **The alert rule itself lives outside both repositories** —
neither repo contains a Prometheus rule file, a Grafana alert definition, or any
Sentry/PagerDuty/Opsgenie/CloudWatch/Datadog configuration (confirmed by search; 010 introduces
none — see "no dependency" confirmation below). This document delivers the **condition**,
precisely enough to implement without re-deriving it. **010 delivers the condition; activation
is an external, operational action** (D7) — see §3.

---

### 1. The signal

**Metric** (verified directly in `Ziyarati-back/src/metrics/metrics.service.ts:64-69`, a
`prom-client` `Counter`, scraped at the existing, already-public `GET /metrics` endpoint):

```
auth_login_protection_events_total{event="store_unavailable"}
```

| Field | Value |
|---|---|
| Metric name | `auth_login_protection_events_total` |
| Type | Counter (monotonically increasing) |
| Label | `event`, a **closed union of exactly four literals**: `'engaged' \| 'blocked' \| 'cleared' \| 'store_unavailable'` (`metrics.service.ts:168`) |
| The alert-worthy value | `event="store_unavailable"` |
| Emitted from | `LoginProtectionService` (`login-protection.service.ts:266`), 009's account-aware brute-force protection |

**What it means.** `LoginProtectionService` normally tracks failed-login attempts per account
in Redis to enforce a brute-force lockout. `store_unavailable` fires when that Redis-backed
store cannot be reached — 009's documented, deliberate **fail-open** behaviour: rather than
blocking all logins when Redis is down, the system lets logins through *without* brute-force
protection, logging this event so the gap is observable rather than silent. **This metric is
the only thing that makes that fail-open condition externally visible.** Its absence — no alert
rule anywhere in either repository — is exactly the ZT-H06 finding.

**Why it is safe to alert on.** The label set is a closed, compile-time-checked union of four
literal strings — no user, tenant, email, IP address or other high-cardinality value is ever
attached to this metric (confirmed by reading the type signature directly, not inferred).
Cardinality is bounded at exactly 4 label-value combinations, permanently.

### 2. The recommended alert condition

The application already exposes Prometheus-format metrics at `GET /metrics`
(`MetricsController`, bearer-token protected, `MetricsAuthGuard`), so a Prometheus-compatible
rule is the natural fit — adapt the PromQL below to whatever monitoring platform actually
scrapes this endpoint in production (Prometheus/Alertmanager, Grafana Cloud, Datadog's
Prometheus integration, etc.):

```yaml
# Example Prometheus alerting rule — adapt to the actual monitoring platform.
- alert: LoginProtectionStoreUnavailable
  expr: increase(auth_login_protection_events_total{event="store_unavailable"}[5m]) > 0
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "Login brute-force protection is running fail-open (Redis unavailable)"
    description: >
      auth_login_protection_events_total{event="store_unavailable"} has incremented in the
      last 5 minutes. LoginProtectionService cannot reach its Redis-backed store and is
      failing OPEN (009, by design) — logins are being accepted WITHOUT the account-aware
      brute-force lockout. Investigate Redis reachability for the API immediately.
```

| Field | Recommended value | Rationale |
|---|---|---|
| **Metric** | `auth_login_protection_events_total` | The only metric this condition exists for |
| **Label** | `event="store_unavailable"` | The one alert-worthy value of the four possible |
| **Threshold** | Any occurrence (`> 0`) over a 5-minute window | A degraded brute-force control is significant even as a single event — this is a security control failing open, not a performance metric where a single blip is noise |
| **Duration (`for`)** | 1 minute | Short enough that a real, ongoing Redis outage pages promptly; long enough to avoid firing on a single-scrape artifact |
| **Base severity** | Warning, escalate to Critical if sustained (e.g., still firing after 15 minutes, or recurring across multiple 5-minute windows within an hour) | A brief Redis blip that self-recovers is lower urgency than a sustained outage leaving brute-force protection off for an extended period — the exact escalation policy is an operational judgment call for whoever owns paging, not re-derived here |

**Whoever implements this does not need to re-derive anything above** — the metric name,
label, exact value, a working example expression, and a reasoned starting threshold/duration
are all stated explicitly.

### 3. D7 — this is an operational handoff, not a code blocker

**The alert rule lives outside both repositories.** Neither `Ziyarati-back` nor `Ziyarati-font`
contains any alerting-platform configuration (no Prometheus rule files, no Grafana provisioning,
no Alertmanager config) — there is nowhere in-repository for this feature to add one.

**010 delivers the condition documented above; activating it (creating the actual rule in
whatever monitoring platform is deployed) is an external, operational action**, owned by
whoever administers that platform. This is the same pattern 008 established when it reported
ZT-005 and ZT-012 as implementation-complete-but-deployment-verification-pending: **implementation
completion (this document existing, naming the exact metric/label/threshold) and alert
activation (a rule actually configured and paging someone) are distinct states, reported
separately** — see `evidence/closure-report.md`.

### 4. No alert provider or dependency introduced

`login-protection.service.ts` and `metrics.service.ts` are read here, never modified — the
metric itself is untouched by this feature. No package was added: `package.json` and
`package-lock.json` are unchanged outside the two approved `"scripts"` entries this feature
adds elsewhere (`test:security`; see `evidence/closure-report.md` for the full dependency
confirmation). No provider reference (Sentry, PagerDuty, Grafana, CloudWatch, Datadog,
Opsgenie) exists anywhere in `Ziyarati-back/src` or its manifest.
