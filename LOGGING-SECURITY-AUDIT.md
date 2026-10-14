# Logging, Patient-Data Leakage & OpenTelemetry — Security Audit

| | |
|---|---|
| Date | 2026-10-14 |
| Code audited | `Ziyarati-back` HEAD `44cbbc7` ("logging"), `Ziyarati-font` HEAD `0cea804` ("logging"); working trees clean |
| Production state observed (read-only) | ECS `zt-production-api:14` and `zt-production-worker:12` run image `backend:44cbbc7…` (registered 2026-10-14 16:37 UTC). **The audited code is live.** |
| Mode | Audit only. No code, configuration, infrastructure, retention or IAM change was made. No deploy, `terraform apply` or migration. OpenTelemetry was **not** enabled anywhere except one isolated in-process test against a receiver on `127.0.0.1`. |
| Test data | Synthetic canary values only (invented names, `.test` e-mail domain, made-up numbers). Production logs were queried **only with count/classification queries** that return numbers, table names and booleans, never log text. |
| Evidence harness | `D:\projects\Ziyarati-full\docs\logging-security-audit-2026-10-14\` (outside both product repos) |

---

## 1. Executive summary

### Decision: **NOT SAFE TO DEPLOY (as-is)**

The application-level redaction added in `44cbbc7` works for what it was designed for: shaped identifiers (e-mail, Saudi/Gulf phone numbers, national/Iqama/Egyptian IDs, card numbers, JWTs, Bearer values, signed-URL signatures) and a list of exact field names. Bodies, headers, cookies, job payloads and ORM entities never reach the log. But the audit found three problems that together make the current logging posture unsafe for patient data. Because `44cbbc7` is already running in production, treat the P0 items in §9 as a hotfix, not as a pre-release task.

1. **Raw SQL with every bound parameter is written to production stdout, bypassing all redaction (LSA-01, High, confirmed).** TypeORM's console logger is always on for query errors. A canary run against real PostgreSQL showed it printing patient name, phone, clinical note and national ID verbatim. Production CloudWatch already holds **37** such lines in the last 30 days. They contain clinic data (WhatsApp template text in Arabic, tenant IDs), but **no patient data was observed** in them.
2. **No CloudWatch masking is active on any production log group (LSA-02, High, confirmed).** Terraform declares a data-protection policy (`enable_log_data_protection = true` by default), but it was never applied. `GetDataProtectionPolicy` returns an empty response for `/ziyaratech/production/{api,worker,migrate}`, and there is no account-level policy. The "backstop" described in `LOGGING.md` does not exist. The new metric filters and alarms (`logs.tf`) are not applied either.
3. **If tracing were enabled, OpenTelemetry would export patient-linked data (LSA-03, High, confirmed in isolation, not active).** In an isolated test, `startTracing()` exported 7 of 18 canaries: the client IP taken from `X-Forwarded-For`, the user agent, the raw URL path including payment/action capability tokens and path-borne phone numbers, and exception messages and stacks containing an Arabic name and a phone number. Nothing restricts the export destination: plain `http://` is accepted, there is no region allow-list, and task egress is open to `0.0.0.0/0:443`. **Keep `OTEL_ENABLED` unset in every deployed environment (§10).**

Free text is the systemic gap behind most Medium findings. Names (English and Arabic), clinical wording and anything under an unlisted field name pass through: 53 of 97 tested field-name variants were not redacted, including `patientPhone`, `mobile`, `name`, `medicalNotes`, `guardianName`, `dob`, `iqama` and `passportNumber`. Value-shape scrubbing cannot detect a name or a diagnosis.

### Is there actual evidence of patient or clinic data in logs?

| Data class | Evidence | Status |
|---|---|---|
| **Patient** data (names, phones, clinical text, IDs) in production logs | None found. Count queries for e-mail, Saudi mobile, 10-digit ID and JWT shapes in the app log groups returned 0 matches outside the items below. Arabic text appears in 6 lines, all classified as WhatsApp-template content. | **Not observed**. Mechanism **proven** with canaries (LSA-01, LSA-04, LSA-06). This is not proof of absence: names and clinical text cannot be detected by count queries. |
| **Clinic** data (template text, tenant IDs, business identifiers) | 4 TypeORM `INSERT INTO whatsapp_templates … -- PARAMETERS:` lines with Arabic template text and 9+-digit IDs. 33 `SELECT … customer_segments` lines with a tenant UUID. 2 `ExceptionFilter` lines with Arabic template text. 4 RDS `DETAIL: Key ("tenantId", name, language)=(…)` lines. | **Confirmed**, unmasked, retained 30 days |
| **Staff** PII | 2 lines in `/ziyaratech/production/migrate` with the super-admin e-mail (seed output). 2 RDS `STATEMENT:` lines with an e-mail address in an ad-hoc, non-parameterized `select`. | **Confirmed** |

### Must fix before any further deployment (detail in §9)

1. Stop TypeORM from printing query parameters (LSA-01).
2. Apply and verify the CloudWatch data-protection policy, and know its limits (LSA-02).
3. Make tracing refuse to start in deployed environments unless the endpoint is `https://` on an allow-listed in-region host, and fix the span attribute hooks (LSA-03). Until then, `OTEL_ENABLED` stays unset.
4. Stop logging the raw `originalUrl` in the exception filter (LSA-06). Its query-value and path-parameter leaks are the easiest patient-data path to trigger.

---

## 2. Architecture and data flow (as implemented, verified in code and live config)

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

## 3. Findings

Severity scale: Critical means patient data is confirmed exposed to unauthorized parties, or the exposure is trivially triggerable at scale. High means a proven mechanism for patient/credential data reaching a store without protection, or a confirmed live control gap. Medium means a proven leak that requires a specific code path or input. Low means limited data, a limited audience, or a hygiene issue.

**Totals: 0 Critical · 3 High · 5 Medium · 9 Low.**

### HIGH

#### LSA-01 — TypeORM prints failing SQL and all bound parameters to stdout, bypassing redaction
- **Severity / confidence:** High / High
- **Where:** `src/config/typeorm.config.ts:40-71` (delegate `AdvancedConsoleLogger`), `:238-242` (the logger is always built with at least `['error']`, so `TYPEORM_LOGGING=false` does not turn this off). TypeORM 1.1.2 `logger/AbstractLogger.js:42-60` (`logQueryError` → "query failed" + `parameters`), `:240` (`-- PARAMETERS: ${JSON.stringify(parameters)}`). `platform/PlatformTools.js:192` (`console.log`).
- **Reproduce:** run `canary/http-db-canary.spec.ts` test S6 against a throwaway PostgreSQL. An `INSERT` that violates a unique index makes TypeORM print `query failed: INSERT INTO … -- PARAMETERS: ["<name>","<phone>","<clinical note>","<national id>"]`.
- **Data at risk:** every value bound to a failing statement: patient names, phones, national IDs, notes, appointment fields, e-mails; tokens or hashes if an auth query fails.
- **Leak status:** **Confirmed** (canaries `nameEn`, `nameAr`, `phoneAscii`, `clinicalNote`, `nationalId` and an e-mail all leaked). **Confirmed in production:** 37 lines from 2026-10-09 21:39 to 2026-10-11 19:19 (33 × `customer_segments` SELECT whose only parameter is a tenant UUID, 4 × `whatsapp_templates` INSERT with Arabic template text). No patient-data parameter was observed in production.
- **Impact:** the moment a query touching patient tables fails (unique violation, an exclusion-constraint booking race, a type error, schema drift), the patient row values land in CloudWatch in plain text. There is no JSON structure, no masking, and readers can see every clinic's data. This defeats the whole redaction design.
- **Fix (minimal):** in `MetricsAwareTypeOrmLogger.logQueryError` (and `logQuerySlow`), stop delegating. Emit one structured `db.query.failed` line with the SQL verb, the table, `driverError.code` and `constraint`, and **never** `parameters`. Do not pass the full SQL text either, because ad-hoc literals are possible. Alternatively pass `logging: false`; the exception filter already logs the mapped error.
- **Verifying test:** the S6 "RAW console" cases must report `clean` for all canaries, with an added assertion that no console output contains `PARAMETERS`.

#### LSA-02 — No CloudWatch Logs data-protection (masking) is live in production; monitoring Terraform not applied
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

#### LSA-03 — OpenTelemetry would export client IP, user agent, capability tokens, path PII and exception text; nothing restricts the export destination
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

### MEDIUM

#### LSA-04 — Names, clinical free text and unlisted field names bypass redaction (deny-list design limit)
- **Where:** `src/common/utils/sanitize.util.ts:59-99` (exact-match list), `:116-122`. `structured-logger.ts:241-249`: the message is scrubbed by shape only. Existing call sites interpolate `${err.message}` or `${res.error}` into messages (about 100 sites, for example `whatsapp-inbound-ai.service.ts:943`, `agent-whatsapp-dispatcher.service.ts:80`, `campaign-dispatch.service.ts:260`).
- **Reproduce:** `logger-canary.spec.ts` S1–S4, S7 and S13.
  - **Not redacted** (non-shape values leaked under 53 of 97 keys): `phoneNumber, patientPhone, mobile, mobileNumber, whatsapp, whatsappNumber, wa_id, msisdn, to, emailAddress, patientEmail, name, doctorName, staffName, guardianName, parentName, guardian, medicalNotes, medical_notes, clinicalNotes, diagnoses, icd10, symptom, chiefComplaint, prescription, medicalHistory, iqama, iqamaNumber, passportNumber, idNumber, dob, birthDate, gender, policyNumber, code, verificationCode, message, payload, data, details, description, reason, query, search, q, url, comment, caption, transcript, subject, title, answer, visitReason`.
  - Phone or e-mail values under those keys **were** caught by shape scrubbing (0 phone leaks across all 97 keys).
  - Names (English and Arabic), guardian, doctor, clinic, diagnosis, symptom, medication, history, address and visit reason leaked inline in messages, in error messages and one-level `cause`, in the fatal-handler line, in JSON strings and in nested neutral keys.
- **Leak status:** **Confirmed** (canary). In production: 2 `ExceptionFilter` lines with Arabic template text (clinic data). Patient free text not observed.
- **Impact:** any current or future call site that logs a provider message, an exception message or a neutral-keyed object containing patient text writes it unmasked. CloudWatch masking would not help either: names and clinical text are not detectable by pattern.
- **Fix:** move from deny-list to allow-list for structured fields: only known-safe keys (`*_id`, `status`, `count`, `duration_ms`, …) pass, and everything else is replaced with `[type:len]`. Extend the exact list now (the leaked keys above) as a stop-gap. For messages, have high-risk call sites log `error.type` and a provider error **code** rather than the provider's message text. Add a lint rule against interpolating `err.message` or `res.error` into log templates in modules handling patient data.
- **Verifying test:** S1 must show 0 leaks for the 53 keys (with the allow-list, any unknown key). S3 and S7 must leak no non-shape canary.

#### LSA-05 — Value-shape scrubber gaps
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

#### LSA-06 — Exception filter logs the raw `originalUrl` (path parameters and non-listed query values)
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

#### LSA-07 — `body_shape` keeps numeric values and object keys
- **Where:** `src/common/utils/log-scrubber.util.ts:164-189` (`typeof value === 'number'` → returned as-is; keys are copied verbatim).
- **Reproduce:** S9 "body numeric" and "dynamic KEY". `mobile: 966599000119` (a number) was logged, vitals `83.4`/`151` were logged, and a user-defined key (a symptom text used as a property name) was logged.
- **Leak status:** **Confirmed** (canary).
- **Fix:** log numbers as `number` (keep booleans). Replace keys that do not match `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`, or that are not on the DTO, with `[key]`.
- **Verifying test:** the same S9 cases must be `clean`.

#### LSA-08 — Full client IP linked to user and tenant on security events; the IP is the wrong address for browser traffic
- **Where:** `all-exceptions.filter.ts:209-212` (`formatClientIp(request.ip, 'full')` on every 401/403/429/failed login). `auth.service.ts:394` (login success) and `:895` (refresh-token reuse), both with `user_id` and `tenant_id`. `src/config/trust-proxy.ts:69-84`. `TRUST_PROXY_HOPS=1` is live.
- **Reproduce:** S9-IP. With hops=1 and `X-Forwarded-For: 203.0.113.9, 198.51.100.77`, the security line logged `198.51.100.77` (the last, ALB-appended entry) and the access line logged `198.51.100.0`.
- **Data at risk:** personal data (an IP address) joined to a staff identity and a clinic, retained 30 days, unmasked (IPs are not in the masking set).
- **Leak status:** **Confirmed** by code and test. In production: no `auth.*` event had a full IP in the window (low traffic).
- **Impact:**
  - **Privacy:** an IP plus user plus tenant on every login is more than operations need. The /24 used by the access log would serve brute-force correlation.
  - **Correctness:** browser REST traffic arrives through the Vercel rewrite, so `req.ip` is **Vercel's egress address**, shared by every user (the code says so itself, `trust-proxy.ts:72-74`). The failed-logins-per-IP alarm (`logs.tf:206-235`, not applied) would therefore aggregate unrelated users, and a WAF block on that IP would block everyone. For direct callers (WebSocket, webhooks, API keys) the IP is the real one.
- **Fix:** log a keyed HMAC of the IP (stable for burst detection, not reversible without the key), or the /24, on security events. Keep the full IP only on `auth.refresh.reuse_detected`, if anywhere. Do not apply the IP-keyed alarm until the Vercel edge-token path (`EDGE_PROXY_TOKEN`) supplies the real client address.
- **Verifying test:** S9-IP must show a non-IP value or a /24.

### LOW

#### LSA-09 — Client-chosen `X-Request-ID` is accepted, echoed and logged verbatim, bypassing the digit scrubber
- **Where:** `src/common/middleware/request-context.middleware.ts:10,31-35`; `structured-logger.ts:79-80,333-339` (`ID_KEYS` exemption); `log-context.ts:221` (the context is not sanitized).
- **Reproduce:** S9-RID. `X-Request-ID: 0599000111` and `Zqxcanary.Patientname` were both echoed and logged unchanged. Values over 128 characters were replaced, and CR/LF cannot be sent at all.
- **Impact:** no security decision uses the ID (verified: correlation only). A client can make its own lines carry a chosen string, or reuse another request's ID so that unrelated events correlate during an investigation. The value also flows into job `correlationId`.
- **Leak status:** **Confirmed** (canary). Low impact.
- **Fix:** accept a client ID only from trusted callers (edge token), or always generate one and log the client value separately as `client_request_id` after `scrubText`.
- **Test:** S9-RID must log a server-generated UUID as `request_id`.

#### LSA-10 — Structured fields can overwrite context identity fields
- **Where:** `structured-logger.ts:267-272` (`...currentLogContext(), ...fields`).
- **Reproduce:** S11. `{tenant_id:'spoofed-tenant', user_id:…, request_id:…}` won over the ALS values.
- **Leak status:** **Confirmed**. No user-input path found; risk comes only from internal code. Low.
- **Fix:** add `request_id`/`user_id`/`tenant_id`/`trace_id`/`span_id` to `RESERVED_KEYS` (renamed `data_*`), or spread the context last.
- **Test:** S11 must report the ALS values.

#### LSA-11 — No size cap per record
- **Where:** `structured-logger.ts:326-347` (each string is capped at 10 KB, but the record is not).
- **Reproduce:** S12. A 2,000-element array produced a 225 KB line, close to the 256 KB CloudWatch event limit.
- **Fix:** cap the serialized record (for example 32 KB) and arrays (for example 50 items).
- **Test:** S12 line length ≤ the cap.

#### LSA-12 — CLI processes (migrate/seed) print raw text; production migrate log holds the super-admin e-mail
- **Where:** `src/seed/seed.logger.ts:13-17` (falls back to `console` when no root logger exists, as in the migrate CLI); `src/seed/admin.seed.ts:87`; `src/migrate.ts`.
- **Evidence:** production `/ziyaratech/production/migrate`: 2 lines containing an e-mail address, classified as admin-seed output.
- **Leak status:** **Confirmed** (staff PII).
- **Fix:** in seed and migrate output, log `admin user present` without the address, or call `scrubText`.
- **Test:** grep the migrate container output for `@`.

#### LSA-13 — RDS PostgreSQL server log contains row values and ad-hoc statements
- **Where:** RDS log export (`modules/rds/main.tf:152`). `log_parameter_max_length{,_on_error}=0` correctly suppresses bind parameters, but `DETAIL: Key (…)=(…)` lines and the text of non-parameterized statements are still logged.
- **Evidence (count-only):** 4 `DETAIL: Key ("tenantId", name, language)=(…)` lines (template names, clinic data); 2 `STATEMENT:` lines of an ad-hoc `select` containing an e-mail address; 0 `Failing row contains`.
- **Leak status:** **Confirmed** (clinic and staff data). A patient-table unique violation would put patient values here as well (**Potential**).
- **Fix:** apply the same data-protection policy (LSA-02). Consider `log_error_verbosity = terse` (drops `DETAIL`). Run operator queries parameterized or through a bastion that does not log.
- **Test:** count query `DETAIL:\s+Key \(` returns 0 after a forced unique violation in staging.

#### LSA-14 — Frontend and Vercel logs: weaker scrubber, plus logs outside the backend's control
- **Where:** `Ziyarati-font/app/lib/server-error-log.ts:43-60` (ASCII digits only, no names, no Arabic-Indic digits); no `vercel.json` (default function region). Next.js's own error logging and Vercel request logs (paths and **query strings** of every proxied `/api/*` call) are outside this code.
- **Leak status:** scrubber gaps **Confirmed** by reading the code. Vercel log contents, region and retention are **Not Verified**.
- **Fix:** reuse the backend scrubber patterns. Confirm the Vercel plan's log retention and region. Avoid PII in GET query strings (move searches to POST bodies), which also fixes LSA-06 at the source.

#### LSA-15 — Local observability stack: Loki has no authentication; Alloy mounts the Docker socket; local tracing is fully on
- **Where:**
  - `observability/loki/loki.yaml:4` (`auth_enabled: false`).
  - `observability/docker-compose.yml:66` (`/var/run/docker.sock:ro`; `:ro` does not restrict the Docker API, which is root-equivalent).
  - `observability/docker-compose.app.yml:28-30` (`OTEL_ENABLED: 'true'`, sampler 1 → the LSA-03 data reaches local Tempo for 7 days).
  - Verified safe: all ports bind `127.0.0.1`, Grafana anonymous access and sign-up are off, the password comes from a git-ignored secret file (`.gitignore:108`).
- **Impact:** acceptable on a single developer machine with synthetic data. Unsafe on any shared host, or with a copy of production data.
- **Fix:** document "synthetic data only". If the stack is ever shared: enable Loki multi-tenancy or an authenticating proxy, and use a Docker socket proxy that allows only read endpoints.

#### LSA-16 — Every clinic's logs sit in one log group; reader access cannot be verified
- **Where:** `modules/ecs/main.tf:89-94` (one group per role); `modules/kms/main.tf:24-30` (the root statement delegates to IAM); `modules/github-deploy/main.tf:120-124` (the deploy role reads **migrate** logs only, which is good). No human or ops roles are defined in Terraform.
- **Impact:** anyone with `logs:FilterLogEvents`/`StartQuery` on the group, plus `kms:Decrypt` through IAM, sees all tenants. Tenant isolation in logs depends entirely on IAM, which lives outside Terraform.
- **Leak status:** **Not Verified** (`iam` read access was not attempted; STS from this workstation timed out).
- **Fix:** keep human log access to a small break-glass role, deny `logs:Unmask` to everyone except an audited role, and put both in Terraform.

#### LSA-17 — Git history: no production secrets found by pattern; committed expired session cookies and test keys
- **Evidence:** `history-scan.mjs` over all 470 back-end and 209 front-end commits reports pattern, file and commit only.
  - `scripts/perf/load/session-cookie.txt` (tracked since 2026-08-09) holds JWT access and refresh cookies for a local perf run (claims `sub, tenantId, type, iat, exp`; expired 2026-08-09 and 2026-08-16).
  - `test/fixtures/zt012-tls/*.key` are test TLS keys.
  - `scripts/tap-sandbox/pay.js` holds a placeholder-style `sk_test_` value.
  - Postgres URLs in docs and helpers point to placeholders or `127.0.0.1`.
  - **Correction to the previous implementation report:** `.env.strix` and `app.json` exist only as git-ignored local files and have **no** history in either repo. The earlier statement that `.env.strix` "was committed" is not supported. The files still contain plaintext credentials on disk, so rotating them remains advisable.
- **Fix:** delete `session-cookie.txt` and add `scripts/perf/load/*.txt` to `.gitignore`. Confirm the JWT secret used for that perf run was never a production secret.
- **Limit:** pattern-based. A secret with no recognizable shape would not be found.

---

## 4. Verified-clean (tested; not "secure", only "no leak found by this test")

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

## 5. Sensitive-field placement matrix

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

## 6. Test results

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

## 7. Secrets in git history (values never shown)

See LSA-17. Summary: no production credential pattern found (OpenAI, Tap live, AWS, Meta, Resend, GitHub, Slack, private keys outside test fixtures, credentialed non-local Postgres URLs, or `JWT_*`/`*_SECRET` assignments with real-looking values) in either repo's full history. Present: expired perf-run JWT cookies (`scripts/perf/load/session-cookie.txt`), three test TLS private keys under `test/fixtures/zt012-tls/`, and test-only `sk_test_`/`sk_live_` strings in specs. `.env`, `.env.strix`, `.env.production.local`, `app.json` and `Ziyarati-font/.env.local` are untracked and git-ignored, with no history. The Docker build context excludes `.env*` (`.dockerignore`) and the image copies only `src`, `scripts` and the manifests.

---

## 8. Not verified (needs access this audit did not have, or chose not to use)

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

## 9. Prioritized remediation plan (smallest safe change first)

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

## 10. OpenTelemetry decision

**OpenTelemetry stays disabled (`OTEL_ENABLED` unset) in production and staging** until all of the following hold:
1. LSA-03 fixes 1–5 are implemented, and `otel-canary.cjs` reports **0 of 18** canaries.
2. A collector exists inside the VPC in `eu-central-1` (or the approved residency region), reachable over TLS, and `startTracing` refuses any other endpoint.
3. The subprocessor/egress register lists the trace store, and its retention and access are defined like the log groups'.
4. LSA-01 is fixed, because `trace_id` on log lines would otherwise join raw-parameter lines to spans.

Verified today: no live task definition sets any `OTEL_*` variable; tracing is off.
