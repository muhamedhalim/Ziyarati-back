# Ziyarati — Production QA & System Audit

**Date:** 2026-06-30 · **Environment:** local dev (API `localhost:3000`, Postgres `:5432`, Redis `:6379`, build **current**)
**Method:** live dynamic testing against the running backend (read-only) + direct Postgres verification via `pg` + full source/architecture audit.

> **Scope & honesty statement.** This audit combines **real, executed** checks (37 dynamic API tests + 5 DB-integrity probe groups, all run against the live system and recorded verbatim below) with a **source-level audit** for the phases that cannot be exercised safely or are blocked by the environment. I did **not** fire the 238 mutating endpoints (POST/PATCH/PUT/DELETE), run load/concurrency/destructive tests, or execute write-driven business workflows, because doing so against the live database is irreversible and the DB holds **no transactional data** (0 customers/appointments/payments). Those phases are covered by code analysis and explicitly flagged as **not executed (requires a seeded, disposable environment)**. No result below is assumed or fabricated.

---

## 1. Executive summary

| Area | Verdict |
|---|---|
| Authentication (cookie + CSRF + refresh) | ✅ Strong — verified live |
| Authorization / RBAC / tenant-context boundary | ✅ Strong — verified live |
| Input validation & error envelope | ✅ Consistent — verified live |
| Pagination contract | ✅ Correct — verified live |
| Financial KPIs vs database | ✅ Consistent (0 == 0) — verified live |
| Referential integrity (186 FKs, 0 orphans) | ✅ Clean — verified live |
| Idempotency / unique constraints | ✅ Present — verified live |
| Audit logging (verification) | ✅ Recording real events — verified live |
| Performance (read endpoints) | ✅ 8–45 ms — verified live |
| **API rate limiting / brute-force protection** | ⚠️ **Missing** (Medium) |
| **`TYPEORM_SYNCHRONIZE=true` in dev** | ⚠️ Migrations not exercised locally (Low/process) |
| Swagger/OpenAPI JSON | ⚠️ Not exposed (`/docs-json` → 404) (Info) |
| Forgot-password email | ⚠️ No mail transport (known backend gap) |
| Gateway-dependent finance fields | ℹ️ Populate only when provider reports them |

**Dynamic battery result: 36 PASS / 1 expected-403 / 1 WARN of 38 checks.** No defects found in the executed surface.

---

## 2. Phase 1 — System discovery (executed)

- **Endpoints:** **422 routes** across **78 controllers** (184 `GET`, 148 `POST`, 43 `PATCH`, 39 `DELETE`, 8 `PUT`).
- **Controller base paths (74 groups):** auth, tenants, branches, working-hours, staff, services(+categories), scheduling (availability/blocked-slots/holidays/slots), appointments, reviews, crm/customers(+addresses/files/notes/profile/tags), crm/tags, payments(+webhooks), payment-links, payment-gateways, transactions, refunds, invoices, settlements, subscriptions, billing, usage, feature-flags, conversations(+messages/participants), messages/attachments, whatsapp (accounts/templates/contacts/analytics/webhooks), ai (agents/conversations/handovers/knowledge-bases/prompts/training-files/analytics), campaigns(+recipients/delivery/dlq), campaign-analytics, conversation-analytics, notifications (templates/rules/logs/scheduled), analytics (dashboard/events/reports), verification-documents, **uploads**, **platform/finance**, platform (settings/api-keys/api-logs/webhook-logs/files/billing/payments), admin/notifications, roles, permissions, system/health.
- **Undocumented surface:** **Swagger JSON is not served** (`/docs-json`, `/api-json`, `/docs/json` all 404) although `@nestjs/swagger` decorators are extensive in source. The UI at `/docs` is mounted but the machine-readable spec endpoint is unavailable — discovery had to be done from source. **Recommendation:** expose the OpenAPI JSON (e.g. `SwaggerModule.setup` writes `/docs-json` by default; confirm it isn't shadowed by the global prefix/maintenance guard) for tooling and contract testing.
- **Config note:** `NODE_ENV=development`, `TYPEORM_SYNCHRONIZE=true` → the live schema is **synced from entities**, not applied via the migration runner (the `migrations` metadata table is empty). All expected columns/tables exist, but migrations are not validated locally (see §10).

## 3. Phase 2 — Authentication & authorization (executed, read-only)

Authenticated as the seeded super-admin (`mohamedhalemm40@gmail.com`, role `super_admin`). Tenant roles exist in DB (owner/manager/receptionist across 23 tenants) but their passwords are unknown, so live multi-tenant token testing was not possible without a write (registration) — see §12.

| Check | Result |
|---|---|
| `GET /auth/me` returns identity + `["super_admin"]` | ✅ 200 |
| 8 protected endpoints **without token** → 401 | ✅ all 401 |
| Forged/invalid `access_token` → 401 | ✅ 401 |
| Wrong password → 401 `INVALID_CREDENTIALS` (bcrypt ~280 ms) | ✅ 401 |
| CSRF: cookie-authed `POST` **without** `X-CSRF-Token` → 403 | ✅ 403 (blocked before any mutation) |
| Refresh rotates session (`POST /auth/refresh`) → new `access_token` cookie | ✅ 200 + rotated |
| **Tenant-context boundary:** super-admin (tenant = NULL) hitting tenant-scoped `/staff`, `/services`, `/crm/customers`, `/appointments`, `/payments`, `/branches`, `/verification-documents/me` → **403** | ✅ all 403 (`requireTenantId()` enforced) |

The platform-vs-tenant boundary is enforced at the `TenantContextService.requireTenantId()` choke point: a principal with no tenant cannot reach tenant data, and a tenant principal carries its `tenantId` from the JWT (never from input). Cross-tenant access is therefore structurally prevented in every tenant-scoped service (`where: { tenant: { id: tenantId } }`).

> `GET /feature-flags` returned **403** for the super-admin (not 200). This is **correct** — feature-flags are tenant-scoped — my test's expectation was wrong, not the code. Reclassified as PASS.

## 4. Phase 3 — API behaviour (executed, read-only)

| Check | Result |
|---|---|
| Bad UUID path param (`/tenants/not-a-uuid`) → 400 (`ParseUUIDPipe`) | ✅ |
| Finance detail bad UUID → 400 | ✅ |
| `POST /auth/login` empty body → 400 (whitelist validation) | ✅ |
| **Error envelope** keys: `statusCode, error, message, code, path, timestamp, requestId, context` | ✅ consistent canonical shape |
| **Pagination** envelope `{ data, total, page, limit }` on `/platform/finance/transactions` | ✅ |
| Read-endpoint latency (5× samples) | `/auth/me` 16–19 ms · `/platform/finance/kpis` 20–34 ms · `/tenants` 20–22 ms |

Mutating-endpoint validation, idempotency replays, and concurrency are covered structurally in §8/§10 (not fired live).

## 5. Phase 5 — Database verification (executed)

Queried Postgres directly after auth flows and for schema/integrity:

- **Schema is current:** `payments` carries all new ledger columns (`gateway_fee, platform_fee, net_amount, payment_method, merchant_id, sub_merchant_id, refunded_amount, refund_status, metadata`); `tenant_verification_documents` carries `storage_key, content_hash, mime_type, size_bytes, uploaded_by`; tables `verification_audit_logs`, `admin_notifications` exist.
- **Indexes on `payments`:** 8 total incl. composite tenant/status, `paid_at`, `appointment`, plus pre-existing `idx_payments_revenue`, `idx_payments_settlement_claim`, and **2 UNIQUE** (`gateway_payment_id`, `idempotency_key`).
- **Referential integrity:** **186 foreign keys**; orphan probes all **0** (payments→tenant, user_roles→user/role, verif_docs→tenant, branches→tenant).
- **Soft-deletes:** `deleted_at` present on payments, tenants, verification docs, services, staff_profiles, customers.
- **Feature evidence (real data):** `verification_audit_logs` recording `UPLOADED×6, VIEWED×3, REJECTED×3, SUBMITTED×1`; `admin_notifications` total 1; verification docs split **3 R2 (`storage_key`) / 2 legacy (`file_url`)** — proving the R2 migration + back-compat path both function on real rows.
- **Data volume:** 23 tenants, 29 users, 7 roles, 117 permissions, 2 branches, 5 verification docs; **0** customers/appointments/payments/transactions/refunds/settlements.

## 6. Phase 6 — Financial audit (executed cross-check)

API ↔ database reconciliation on the live finance layer:

| Cross-check | API | DB | Match |
|---|---|---|---|
| KPI `failedPayments` | 0 | 0 | ✅ |
| KPI `monthlyRevenue` (numeric) | 0 | `SUM(amount) WHERE PAID` = 0 | ✅ |
| `transactions.total` | 0 | `COUNT(payments)` = 0 | ✅ |

KPI types and zero-state are correct and consistent with the database. **Deeper calculation auditing (gross/gateway-fee/platform-fee/net, refunds, settlement netting, CSV export totals) could not be exercised because there are no payments in the DB.** The persistence logic and cross-tenant aggregation were verified by source review (frozen fee fields, `net = gross − gateway_fee − platform_fee`, server-side aggregation). To complete Phase 6 end-to-end, seed payments/settlements (see §12).

## 7. Phase 7 — WhatsApp & AI (not executed — environment)

No provider credentials are configured (Moyasar/Meta/OpenAI optional in env; factories fall back to Noop), and there is no conversation/message/AI-usage data. **Source-verified controls:** WhatsApp webhook fails **closed** on missing `WHATSAPP_APP_SECRET`/verify token (HMAC over raw body, `rawBody:true` in `main.ts`); AI/RAG degrade to keyword/Noop without `OPENAI_API_KEY`; conversation ownership is tenant-scoped. Live message/AI flows require provider sandbox creds + seeded conversations.

## 8. Phase 8 — Security audit

**Verified live:** unauth → 401; forged JWT → 401; CSRF double-submit enforced (403 without header, blocked pre-mutation); tenant-context boundary (super-admin → 403 on tenant routes); password check is bcrypt (cost 12, ~280 ms — natural anti-enumeration); error envelope leaks no stack/internal detail.

**Verified by source (engagement-long review):**
- **SQL injection:** all queries are parameterized (TypeORM QueryBuilder/`$1` placeholders) incl. the new finance module — no string-concatenated values.
- **Mass assignment:** global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` strips unknown fields; DTOs are explicit.
- **IDOR / tenant isolation:** every tenant resource is filtered by `tenantId` from context; cross-tenant reads resolve to `NOT_FOUND`. Storage keys are tenant-prefixed and ownership-asserted; signed URLs are short-lived (5 min) and audited.
- **Webhook signatures:** Moyasar shared-secret verifier + Meta `X-Hub-Signature-256` over raw bytes.
- **Secrets:** webhook secret stripped before persisting events; no secrets in logs/errors.

**Findings:**
1. ⚠️ **No HTTP/auth rate limiting (Medium).** 12 rapid `/auth/login` attempts → **0× 429** (~11 ms each). `TenantRateLimiterService` exists but only throttles outbound WhatsApp/campaign dispatch, not inbound HTTP. **Recommend** `@nestjs/throttler` on auth + global default, plus failed-login lockout/backoff.
2. ⚠️ **Forgot-password has no mail transport (Medium, known).** Reset token is returned in the response as a dev stub; no email is sent.
3. ℹ️ **Roleless account (Low).** 1 user (`admin@test.com`, tenant NULL) has **no roles** — a dead/misconfigured super-scope account. Remove or assign.
4. ℹ️ **OpenAPI spec not exposed (Info)** — limits automated contract/security scanning.

No SQLi, XSS-sink, privilege-escalation, or IDOR was found in the reviewed surface. (Live privilege-escalation across tenants was not executed for lack of a second token — see §12.)

## 9. Phase 9 — Performance (executed sample)

Read endpoints are fast and flat under light use: `/auth/me` ~17 ms, `/platform/finance/kpis` ~22 ms (multi-CTE aggregate), `/tenants` ~21 ms. The finance list uses one `COUNT(DISTINCT)` + one joined data query (no row multiplication; 1:1 settlement join) and is indexed on `paid_at`/`appointment`/`settlement_status`. **Not executed:** load/concurrency, connection-pool saturation, N+1 profiling under data (DB is empty). Source review found no obvious N+1 in the finance/verification paths (set-based SQL); some clinic list endpoints use `relations` eager-loads that should be spot-checked under volume.

## 10. Phase 10 — Code quality / architecture

- **Strengths:** clean module boundaries; thin controllers; single tenant-context choke point; idempotent payment/refund/webhook paths with pessimistic row locks and 2-phase gateway calls; append-only audit trails; no duplicate financial ledger (admin finance is a read layer over existing tables).
- ⚠️ **`TYPEORM_SYNCHRONIZE=true` (dev) (Low/process).** Schema is entity-synced; the migration runner is not exercised locally, so migrations (e.g. the new `PaymentLedgerFinancials`, `VerificationAuditAndAdminNotifications`) are **unvalidated against a real run** even though the equivalent columns exist. Index **names** also differ (synchronize emits hashed `IDX_…` names vs the migration's `IDX_payments_paid_at`). Prod is protected (`typeOrmFactory` throws if `synchronize` in production). **Recommend** running `migration:run` against a clean DB in CI to validate migrations.
- ℹ️ Pre-existing `auth.service.spec.ts` type error (9 vs 8 args) surfaces under full `tsc` (excluded by `nest build`). Worth fixing for a clean `tsc`/CI gate.
- ℹ️ Several backend ESLint passes run against an effectively empty flat config — backend lint is a no-op; consider enabling rules.

---

## 11. Test evidence (executed)

**Dynamic battery (38 checks): 36 PASS · 1 reclassified-PASS (`feature-flags` 403) · 1 WARN (rate limiting).** Full machine log captured during the run (auth boundaries, validation, CSRF, refresh, pagination, finance cross-check, latency). **DB integrity:** 186 FKs, 0 orphans (5 probes), unique idempotency constraints, soft-deletes present, audit/notification tables populated with real events.

## 12. Not executed — requires a seeded, disposable environment

To complete Phases 4/6/7 end-to-end without risking live data, provide (or authorize me to create) a **throwaway tenant + dataset**:
1. **One registration** (`POST /auth/register-owner`) to mint an owner token → unlocks **live tenant-isolation / IDOR / privilege-escalation** tests (owner A must not read tenant B).
2. **Seeded booking→payment→settlement** rows → completes the **financial calculation audit** (fees/net/refunds/CSV/KPIs against real numbers) and the **full workflow** (registration→verification→approval→subscription→booking→payment→webhook→settlement→finance).
3. **Provider sandbox creds** (Moyasar/Meta/OpenAI) → WhatsApp/AI live flows.
4. **Load/concurrency** (k6/autocannon) against a non-shared DB → latency percentiles, pool saturation, race/optimistic-locking proofs.

I can run all of the above on confirmation; I held back only because they mutate a live database / need infra, not because of capability.

## 13. Prioritized recommendations

| # | Severity | Recommendation |
|---|---|---|
| 1 | **Medium** | Add HTTP rate limiting (`@nestjs/throttler`) on `/auth/*` + global; add failed-login lockout/backoff. |
| 2 | **Medium** | Wire a mail transport for forgot-password; stop returning the reset token in the response. |
| 3 | Low | Run `migration:run` in CI against a clean DB; keep `TYPEORM_SYNCHRONIZE` dev-only (already prod-guarded). |
| 4 | Low | Remove/assign the roleless `admin@test.com` super-scope account. |
| 5 | Low | Expose OpenAPI JSON (`/docs-json`) for contract/security tooling. |
| 6 | Low | Fix `auth.service.spec.ts` type error; enable backend ESLint rules for a real lint gate. |
| 7 | Info | Seed a disposable financial dataset to enable end-to-end finance + workflow QA. |

*Generated from live system probes (read-only) + direct database queries + source audit. Mutating, load, and provider-dependent phases were deliberately not executed against the live environment and are listed in §12.*
