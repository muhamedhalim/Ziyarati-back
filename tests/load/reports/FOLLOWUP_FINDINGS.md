# Follow-up findings — out of scope, logged not fixed

Issues noticed while executing the Phase 2 remediation that fall outside the
phase's stated scope. Per the execution rules these are recorded, **not fixed**.

---

## FU-001 — `ApiLogService.stats()` runs three unbounded aggregates over `api_logs`

**Severity:** Medium (admin endpoint; degrades as the table grows)
**Found during:** Phase 2.1
**Affected files:** `src/modules/platform/api-log.service.ts` (`stats()`),
`src/modules/platform/api-log.controller.ts`

**Evidence:** `stats()` issues three separate queries over the tenant's entire
`api_logs` history with no time bound: a `COUNT(*)` + `AVG` + filtered `COUNT`,
then `GROUP BY method`, then `GROUP BY status_code`. There is no `created_at`
predicate on any of them, so cost grows linearly with retained history.
`PLATFORM_API_LOG_RETENTION_DAYS` bounds the table, but at the default retention
and a busy tenant this is still a full scan of that tenant's slice per call.
The supporting index is `(tenant, created_at)`, which the aggregates cannot use
for the `GROUP BY`s.

Not measured under load — the endpoint is not part of any k6 scenario.

**Recommended fix:** require a bounded window (`from`/`to`, defaulting to e.g.
30 days) and serve the three aggregates from one pass; consider a rollup table
if per-key metering needs to stay cheap at scale.

---

## FU-002 — Sampling changes the meaning of `stats().totalRequests` for UI traffic

**Severity:** Low (disclosed, not a defect — a consequence of the Phase 2.1 fix)
**Found during:** Phase 2.1
**Affected files:** `src/modules/platform/api-log.service.ts`,
`src/modules/platform/interceptors/api-logging.interceptor.ts`

**Evidence:** with `PLATFORM_API_LOG_SAMPLE < 1` (new production default 0.1),
`totalRequests`/`byMethod`/`byStatus` for ordinary cookie/JWT traffic become a
sample rather than a census. API-key traffic and all `>= 400` responses are
exempt from sampling, so per-key metering and error counts remain exact.

**Recommended fix:** if a census of UI traffic is ever required, source it from
the Prometheus `http_request_*` series (which covers 100% of requests, including
guard-rejected ones) rather than raising the sample rate. Alternatively surface
the effective sample rate alongside the numbers in the stats payload so a
consumer can tell a sample from a census.

---

## FU-003 — `.env` (tracked) carries live third-party credentials

**Severity:** High — **already scheduled as Phase 3.3**, recorded here so it is
not lost if that phase is deferred.
**Affected files:** `Ziyarati-back/.env` (tracked in git)

**Evidence:** the tracked development `.env` contains populated values for
third-party API credentials. Values deliberately not reproduced here or
anywhere in the reports.

**Recommended fix:** treat as compromised — rotate at the provider first, then
remove from tracked files and purge from history. Deleting the line alone does
not undo exposure. Full handling belongs to Phase 3.3.

---

## FU-004 — Double-booking guard missing from the database (CRITICAL)

**Severity:** Critical — silent data corruption, no client-visible symptom
**Found during:** massive-scale load test (2026-09-02)
**Affected files:** none in code — `src/migrations/1730001100000-AppointmentNoOverlap.ts`
is correct and `src/modules/scheduling/scheduling-integrity.service.ts` already
detects the condition at boot. The defect is in the **databases**.

**Evidence:** `appointments_no_overlap` is recorded as applied in the `migrations`
table of both `ziyarati_perf` and `ziyarati`, and does not exist in either
(`SELECT … FROM pg_constraint WHERE contype='x'` returns 0 rows). Measured
consequence at 500 concurrent bookings of one slot: **495 confirmed appointments
in one doctor's 15-minute window, 122,265 overlapping pairs, HTTP 201 for every
one, 0.00% client-side error rate.** With the constraint installed the identical
run produced exactly 1 winner and 0 overlaps.

**Recommended fix:** verify production first, then apply the migration's SQL after
clearing any existing overlaps (exclusion constraints have no `NOT VALID` form).
Separately, root-cause how a migration came to be recorded but not applied — the
same drift could affect any other raw-SQL-only migration. Full detail:
`tests/load/reports/MASSIVE_SCALE_FINDINGS.md § MS-001`.

---

## FU-005 — Follow-up actions silently dropped under pool starvation (Medium)

**Severity:** Medium
**Found during:** massive-scale load test (2026-09-02)
**Affected files:** `src/modules/notification/…` event listeners,
`src/modules/appointment/…` reminder scheduling, `WebhookDeliveryService`,
`WorkflowEventListener`

**Evidence:** 245 errors per listener under saturation, all
`timeout exceeded when trying to connect` — each listener needs a database read
before it can enqueue and loses the same 10 s pool race the request path does.
The listener logs and continues, so the appointment commits and returns 201 while
its reminder is never scheduled. Nothing surfaces to the caller.

**Recommended fix:** enqueue from the booking's own transaction via an outbox row
(the payments path already does this) rather than from a listener that must
re-acquire a connection. Detail: `MASSIVE_SCALE_FINDINGS.md § MS-007`.

---

## FU-006 — bcrypt login blocks the event loop; a re-auth herd stalls the API (Medium)

**Severity:** Medium
**Found during:** massive-scale load test (2026-09-02)
**Affected files:** `src/modules/auth/auth.service.ts` (bcrypt cost factor 12)

**Evidence:** a few hundred simultaneous logins held the API at 12–17
iterations/s against a target of 80 for five minutes, while
`nodejs_eventloop_lag_p99_seconds` read 5.11e-7 and PostgreSQL showed one active
connection — the process was not overloaded, it was serialised behind synchronous
bcrypt. Reachable in production whenever a client cohort's 15-minute tokens
expire together, or a deploy invalidates sessions en masse. Measured again in the
30-minute soak: throughput fell from 72-75 it/s to 26 it/s at the scheduled
re-login and was still at a third of steady state six minutes later, because a
login that times out retries on the very next iteration and feeds the herd.
Separately, `nodejs_eventloop_lag_p99_seconds` read 5.11e-7 (its floor) DURING
the stall and only reported the true 8.1 s afterwards - prom-client measures lag
with a timer that cannot run while the loop is blocked, so that alert fires late.

**Recommended fix:** move password hashing off the event loop (worker thread, or
an async hashing binding), and/or jitter access-token lifetime per session so a
cohort does not expire in lockstep. `API_CLUSTER_WORKERS ≥ 2` reduces the impact
proportionally. Detail: `MASSIVE_SCALE_FINDINGS.md § MS-008`.

---

## FU-007 — Readiness probe fails under load and would evict a healthy instance (High)

**Severity:** High — turns degradation into an outage
**Found during:** massive-scale load test (2026-09-02)
**Affected files:** `src/health/health.controller.ts`

**Evidence:** during a sustained soak the API was still serving traffic while
`GET /api/v1/system/health/readiness` returned **503 after 6.1 s** (16.7 s on an
earlier sample); `liveness`, which touches no dependency, still took 2.2 s.
`readiness()` pings the database through the shared `DataSource`, so it queues
behind the same exhausted connection pool as request traffic, exceeds its own
1,500 ms cap, and reports `degraded`. The cap does not bound wall-clock latency
because a saturated event loop also delays the timeout callback.

**Recommended fix:** give the readiness check a dedicated connection outside the
request pool so it reports on the database rather than on pool contention, and
distinguish "dependency down" from "server busy" so a working-but-loaded instance
is not removed from rotation. First, confirm whether production's orchestrator
gates on this endpoint and at what threshold. Detail:
`MASSIVE_SCALE_FINDINGS.md § MS-009`.

---

## FU-008 — Two integration suites reported PASSED while testing nothing (High) — FIXED

**Severity:** High — a suite that cannot fail is worse than no suite
**Found during:** P0.3 final validation (2026-09-03)
**Affected files:** `test/integration/workflow-claim.int-spec.ts`,
`test/integration/source-ref-idempotency.int-spec.ts`,
`test/integration/ai-batch.int-spec.ts`

**Evidence.** Three integration specs built their `DataSource` without
`migrationsTransactionMode: 'each'`. Several migrations set
`transaction = false` for `CREATE INDEX CONCURRENTLY`, and TypeORM refuses to
combine a per-migration override with the default global mode `'all'` — so
`runMigrations()` threw:

```
Migrations "CustomerTenantScopedEmail1730019000000", ... "ReadPathIndexes1730086000000"
override the transaction mode, but the global transaction mode is "all"
```

Each spec catches that in `beforeAll`, logs *"integration test skipped (no
DB)"*, and leaves `available = false`. Every guarded test then returns early.
`ai-batch` and `pgvector` have an `expect(available).toBe(true)` assertion and
correctly failed; **`workflow-claim` reported `8 passed` and
`source-ref-idempotency` reported its full suite green, having executed no
assertion at all.** `pgvector.int-spec.ts` had the option all along, with a
comment saying exactly why.

`workflow-claim` is the spec that exists to prove `WorkflowService.claimAction`
is atomic under real concurrency — a guarantee a mocked test explicitly cannot
establish, per its own docstring. It has been proving nothing.

**Fix applied (P0.3).** Added `migrationsTransactionMode: 'each'` to all three,
with a comment explaining the failure mode. All three now run: the integration
suite went from 68 tests / 4 failing / 2 suites vacuous to **65 tests, 7 suites,
all genuinely executing**.

**Recommended follow-up (not done):** give every `*.int-spec.ts` the
`expect(available).toBe(true)` assertion that `ai-batch` and `pgvector` have, so
a future connection problem fails loudly instead of turning the suite green.
Better still, hoist the shared DataSource construction into one helper so the
option cannot be forgotten again.

---

## FU-009 — An always-failing assertion in `ai-batch.int-spec.ts` (Low) — FIXED

**Severity:** Low — a test defect, not an application one
**Found during:** P0.3 final validation (2026-09-03)
**Affected files:** `test/integration/ai-batch.int-spec.ts`

**Evidence.** Once FU-008 made the suite actually run, one case failed:

```
● Data residency › fails closed with AI_COMPLIANCE_ROUTE_UNAVAILABLE for an SSRF base URL
  - Expected: { context: { reason: 'AI_COMPLIANCE_ROUTE_UNAVAILABLE' } }
  + Received: [AppError: AI data residency is required for this tenant but its
               regional deployment is unavailable. ...]
```

**The application is correct.** `AiDataResidencyService` does fail closed, and
sets the reason on `publicContext` (`ai-data-residency.service.ts:161`) — which
its own unit spec asserts correctly (`ai-data-residency.service.spec.ts:91`).
The integration spec asserted `context`, a property `AppError` does not have, so
it would always have failed. It was invisible because of FU-008.

**Fix applied (P0.3):** `context` → `publicContext`, with a comment recording
why the assertion had never been seen to fail.

---

## FU-010 — `npm run test:e2e` never rebuilds the database it asserts against (Low)

**Severity:** Low
**Found during:** P0.3 audit (2026-09-03)
**Affected files:** `package.json`

**Evidence.** `pretest:e2e:integration-platform` exists and runs
`test/setup-e2e-db.js`; there is no `pretest:e2e`. `test/jest-e2e.env.js` points
the suite at `ziyarati_e2e` and forces `TYPEORM_SYNCHRONIZE=false`, but nothing
creates or migrates that database. It is 43/43 today; nothing keeps it there.

**Recommended fix:** add `"pretest:e2e": "npm run build && node
test/setup-e2e-db.js"`, matching the integration-platform script. Detail:
`P0.3_FINDINGS.md § P03-010`.

---

## FU-011 — `.env.production.local` holds concrete high-value secrets but no endpoints (Medium)

**Severity:** Medium — depends entirely on whether the values are live
**Found during:** P0.4 STEP 2 connection-target inventory (2026-09-04)
**Affected files:** `Ziyarati-back/.env.production.local`

**Credential types present** (values were never read, printed or logged — only
key names and lengths):

| credential type | length |
|---|---|
| JWT access signing secret | 64 |
| JWT refresh signing secret | 64 |
| Credentials encryption key | 44 |
| Prometheus metrics token | 64 |

**Risk.** The file is named for production and carries `NODE_ENV=production`,
but has **no `DATABASE_URL`, no Redis URL, no payment or storage endpoint**, and
`FRONTEND_ORIGIN`/`APP_URL` are still `example.com` placeholders. So it is
either (a) an incomplete template whose secrets were generated and never used —
harmless — or (b) a partially-filled file carrying **live** production signing
keys on a developer workstation. Those two cases have very different exposure,
and nothing in the file distinguishes them.

If (b): anyone holding `JWT_ACCESS_SECRET` can mint valid access tokens for any
user, and `CREDENTIALS_ENCRYPTION_KEY` decrypts stored third-party credentials.

**Mitigating.** The file is correctly listed in `.gitignore` and is untracked —
`git ls-files --error-unmatch` does not know it. It has never been committed.

**Required action.** Confirm whether these four values match what the production
deployment actually uses. If they do, rotate them and keep production secrets in
the platform's own secret store rather than in a file on a workstation. If they
do not, delete the file or reduce it to placeholder values so the next reader
does not have to ask.

**Not done here:** P0.4 is read-only and does not touch credentials.

---

## FU-012 — `GET /system/health/readiness`'s 503 body carries no diagnostic detail at all, not even the safe parts (Low)

Discovered while writing `test/health-readiness.e2e-spec.ts` for P0.5. When the
DB or Redis check fails, `HealthController.readiness()` throws
`ServiceUnavailableException({status:'degraded', database:{...}, redis:{...},
schemaGuards:{...}})`. Proven empirically against the real
`AllExceptionsFilter` over real HTTP: the entire object is discarded, not just
the driver message inside it. `fromHttpException()`
(`src/common/errors/error-normalizer.ts`) only ever copies a top-level
`.message` off the thrown response; a plain object with no such key falls
through to Nest's own default, so every 503 from this route renders as the
generic `{"message":"Service Unavailable Exception", ...}` with no
`database`/`redis`/`schemaGuards` key at all.

**Consequence.** This closes P04-003 more thoroughly than expected (there was
never a leak reachable over HTTP through this filter — see
`health-readiness.e2e-spec.ts`'s docstring), but it also means an orchestrator
or operator reading the 503 body cannot tell DB-down from Redis-down from
missing-schema-guard. They can currently only get that distinction from the
application log.

**Not fixed here.** P0.5's brief is "don't leak", not "redesign the error
envelope" — and `AllExceptionsFilter` is shared by every route in the app, so
changing what it does with a non-string `HttpException` response is a
broader, public-response-shape change that deserves its own review, not a
side effect of a readiness-integrity phase.

**Possible direction (not evaluated further):** either give `fromHttpException`
a documented convention for exposing an already-public-safe payload (e.g. a
response object that itself provides `.message`, or a small allow-listed set
of top-level keys), or have the readiness route return its degraded body
directly (`res.status(503).json(body)`) instead of throwing, bypassing the
generic filter path for this one route. Either changes an existing public
response shape and should be scoped as its own task if wanted.

---

## FU-013 — `ziyarati_e2e`'s `subscription_usage` table is 100% orphaned (20/20 rows reference a deleted tenant) (Medium)

Discovered during P0.7's tenant-isolation forensics
(`P0.7_TENANT_FK_VERIFICATION.sql` §2, read-only). On `ziyarati_e2e` — the
migration-built database that e2e specs share and that is meant to look like
a clean, freshly-migrated production — **every single `subscription_usage`
row (20 of 20) has a `tenant_id` that names no row in `tenants`.** `ziyarati`
(dev) shows the opposite: 0 orphans out of 207 rows.

**Not the same as the known P03-001 conflict.** That one is a dev-only
`UQ_subscription_usage_tenant_period_unsubscribed` duplicate-key conflict
(189 excess rows, caused by a synchronize boot dropping `subscription_id`),
already logged, already explicitly not repaired (billing decision, RULE 9).
This is a **referential** orphan (points at a tenant that no longer exists),
found on a **different** database (e2e, not dev), with no connection to that
cause.

**Likely mechanism (not confirmed — read-only forensics, no debugging pass
run):** `ziyarati_e2e` is long-lived and shared across many e2e spec files
(not reset between files — `test/setup-e2e-db.js` only rebuilds it on
explicit invocation). The application itself has no tenant-delete code path
at all (`TenantsService` has no `remove`/`delete`/`softDelete`), so these 20
orphans can only be the result of **test-fixture cleanup SQL** deleting
`tenants` rows directly without cascading to `subscription_usage`.

**Consequence.** Any future foreign key on `subscription_usage.tenant_id`
(currently blocked anyway by the column being `character varying`, not
`uuid` — P03-006) would need its **own** orphan-cleanup pass on e2e, on top
of and separate from the type migration and the existing 189-row dev
conflict. Also worth checking whether other e2e-shared tables accumulate the
same kind of orphan from the same cleanup gap — not checked here.

**Required action.** Find which e2e spec(s) delete a tenant without
cascading its `subscription_usage` rows (grep test fixtures for direct
`DELETE FROM tenants` / a `cleanupTenant`-style helper that doesn't include
`subscription_usage` in its FK-safe delete order), and either add the
cascade to that cleanup or accept the accumulation as expected e2e noise —
a decision, not an automatic fix.

**Not done here:** P0.7 is forensic/read-only for this exact reason — no row
was deleted, no survivor was chosen, and `ziyarati_e2e` was left exactly as
found (see `P0.7_TENANT_ISOLATION_MATRIX.md`'s own verification section: all
mutation happened only against disposable, dropped-after clones).

---

## FU-014 — `appointment-availability.e2e-spec.ts`'s "NO schedule configured" test contradicts its own shared fixture (Low — test defect, not a production bug)

**Severity:** Low (one pre-existing e2e test asserts the wrong thing against
the app's own documented, deliberate behaviour; nothing production-facing)
**Found during:** Phase 5 / P1.5, incidentally — the new outbox e2e test
added for MS-007 runs in this same file, so a full-file run surfaced it. No
P1.5 change caused it: reproduced identically on the pre-P1.5 version of the
file (`git stash` verification) and running the single test in isolation.

**Evidence.** `it('allows any hour on a day with NO schedule configured
while the clinic has not opted in', ...)` (line ~331) books Thursday
2031-05-15 for the suite's shared `clinic` fixture and expects `201`.
It gets `409 STAFF_NOT_AVAILABLE` / `OUTSIDE_WORKING_HOURS` instead. Root
cause, confirmed by inspecting `AvailabilityService.evaluate`
(`src/modules/scheduling/availability.service.ts:698-709`):

```
} else if (enforceWhenUndefined || staffHasSchedule) {
  // Nothing configured for THIS day. If the clinic enforces working hours
  // tenant-wide, or if this specific staff member has an explicit
  // working-days schedule configured (on other days), an uncovered day is
  // a working-days violation, not an unconfigured/unrestricted staff
  // member — see `hasAnySchedule`. A staff member with no schedule at all
  // keeps the original unrestricted default.
  outsideAvailability = true;
}
```

This is deliberate, documented behaviour: a staff member who has configured
*any* day is treated as having opted into schedule-driven bookability, so an
uncovered day for that same staff member is a violation — not the
"unconfigured legacy clinic" permissive default. The suite's shared `clinic`
fixture (`createClinic`, line ~144) always seeds exactly one `StaffSchedule`
row for the doctor, on **Wednesday** (`WEDNESDAY = 3`) — so `hasAnySchedule`
is `true` for this staff member tenant-wide, and Thursday (an uncovered day
for a partially-configured staff member) is correctly rejected under the
engine's own rule. The test's name and docstring describe the *other* case —
a staff member with **zero** schedule rows anywhere — which the shared
fixture never actually produces; nothing in this suite exercises that case.

**Not a regression, not new:** confirmed identical failure against the
unmodified file (`git stash` of only this file's P1.5 diff, same isolated
run) — this predates P1.5 and is unrelated to the reminder/outbox work in
this phase.

**Required action (a decision, not made here — out of scope for P1.5):**
either (a) give this specific test its own staff member with zero schedule
rows (mirroring the unit-level `primeValidRefs()` pattern in
`appointment.service.spec.ts`, which already gets this right — "No
staff_schedules rows anywhere → unconfigured legacy clinic"), so it actually
exercises the case its name claims, or (b) decide the per-day fallback rule
itself should be looser and adjust both the code and its docstring together.
Not attempted here: `AvailabilityService`'s working-hours semantics are
unrelated to Reminder/Webhook Loss (MS-007) and changing them is exactly the
kind of broad, unrelated change the phase's scope control rules out.

---

## FU-015 — a non-constant-time comparison of a refresh-token hash, violating the codebase's own FR-039 invariant (**High** — real security-policy violation, pre-existing)

**Severity:** High (auth/session security; caught by the codebase's own
dedicated invariant test, `test/security/config-invariants.spec.ts`, FR-039)
**Found during:** Phase 7 (Final Gate), running the full `test:security`
suite for the first time this campaign.
**Affected file:** `src/modules/auth/auth.service.ts:622`

**Evidence:**

```ts
if (stored.token_hash !== tokenHash) {
  throw new AppError(ErrorCode.INVALID_REFRESH_TOKEN);
}
```

Inside `AuthService`'s refresh-token diagnosis path (reached after
`claimRefreshRow`'s atomic `UPDATE` — see that method's own docstring —
fails to admit the presented token; `stored` is looked up by `id:
payload.jti` alone, so this `!==` is the ONLY check that the presented raw
token's hash actually matches the one issued). A plain string `!==`
short-circuits on the first differing character, which the codebase's own
FR-039 invariant test (`config-invariants.spec.ts` —
`findDirectSecretComparisons()`) exists specifically to catch: comparing a
secret/token/signature identifier with `===`/`!==` anywhere outside
`src/common/utils/constant-time.util.ts` is a violation, full stop. This
exact codebase already has the fix pattern in two places: `constant-time
.util.ts`'s own primitive, and `MetricsAuthGuard.constantTimeEquals` (Node's
`crypto.timingSafeEqual`, used for the `/metrics` scrape bearer token — see
P1.3/P1.4 work this same campaign).

**Confirmed NOT introduced by this remediation campaign (P0-P2, all 7
phases):** `git diff HEAD -- src/modules/auth/auth.service.ts` shows this
exact line is unchanged between `HEAD` and the working tree — every edit
this campaign made to this file (P1.2 — the `bcrypt` import swap, the
targeted `last_login_at` UPDATE, the `activeCandidates`/multiplicity
warning, the access-token TTL jitter) is elsewhere in the file. This is
pre-existing code, never previously caught: the detector's one existing
exemption (`KNOWN_OUT_OF_SCOPE_FINDINGS`, a single reviewed entry at
`auth.service.ts:538`) is for a DIFFERENT, already-reviewed comparison
elsewhere in this same file — line 622 has never been reviewed or exempted,
which is different from "known and accepted."

**Why this matters in practice:** an attacker who can measure response
timing precisely enough (network jitter makes this hard but not
theoretically impossible, especially from a co-located or low-jitter
vantage point) gains a byte-by-byte oracle on the stored `token_hash` for a
GUESSED `jti` — a real, if narrow, side channel on session-hijacking
resistance for a feature (`AUTH-001`'s own docstring) that was specifically
hardened against a DIFFERENT concurrency attack this same year.

**Required action (not done here — out of scope for a Final Gate
verification phase, and a security-relevant code change deserves its own
review, not a drive-by fix during a report-writing pass):** replace the
`!==` with a `timingSafeEqual`-based comparison — the exact
`constantTimeEquals` pattern already in `MetricsAuthGuard`
(`src/metrics/metrics-auth.guard.ts`) is a direct, in-repo template: hash
both operands to a fixed length first if they might differ in length
(`timingSafeEqual` throws on mismatched buffer lengths, and `token_hash`/
`tokenHash` are both fixed-length SHA-256 hex digests here, so they always
match length — worth confirming, not assuming, before wiring in the fix).
Recommend triaging this ahead of any claim of full production readiness,
given its severity and that the fix is small, contained, and has an
in-repo precedent to copy.

---

## FU-016 — 21 genuinely-public routes are missing from the checked-in public-route allow-list (**Medium** — security-policy drift, pre-existing)

**Severity:** Medium (defense-in-depth allow-list tracking, not an active
authorization bypass — every route below is legitimately `@Public()` by
design; the gap is that the allow-list meant to make that a deliberate,
reviewed decision hasn't been kept in sync)
**Found during:** Phase 7 (Final Gate), running the full `test:security`
suite for the first time this campaign.
**Affected file:** `public-routes.allowlist.json` (the checked-in
allow-list), vs. the live route table.

**Evidence:** `test/security/route-authorization.spec.ts` (FR-030) computes
the live set of `@Public()` routes from the real, fully-booted `AppModule`
and diffs it against the checked-in allow-list. 21 routes are public in the
running app but absent from the allow-list:

- `PatientActionController` — `GET/POST /public/appointments/action/:token`
  (+ `/availability`, `/reschedule`, `/cancel`)
- `WaitlistOfferPublicController` — `GET /public/waitlist/offer/:token` (+
  `/accept`, `/decline`)
- `PublicBookingController` — the entire public booking flow: `/session`,
  `/selection`, `/select/clinic`, `/select/branch`, `/services`,
  `/select/service`, `/doctors`, `/select/doctor`, `/availability`,
  `/select/slot`, `/confirm`
- `UnsubscribeController` — `GET/POST /public/unsubscribe/:token`
- `EmailWebhookController` — `POST /public/email/webhooks/resend`

**Confirmed unrelated to this remediation campaign (P0-P2):** none of these
controllers were touched by any of the 7 phases (schema guards,
synchronize, tenant FKs, cluster scaling, bcrypt, DB pool metrics,
readiness, reminders/outbox, booking query count). Every one of these
routes belongs to a feature shipped weeks before this campaign started
(2026-09-02) — patient action links, waitlist offers, and public booking are
all documented in earlier project memory (`project_feature014_phase6
_public_booking.md`, `project_free_access_duration_slider.md`, etc.), dated
2026-08-xx. The allow-list has simply never been updated to match — this is
the first time `test:security`'s full suite has been run during this
campaign, so nothing before now would have caught it either.

**Required action (not done here):** review each of the 21 routes
individually before adding it to the allow-list — the whole point of this
invariant is that "public" is a DELIBERATE decision per route, not a
default. A blind bulk-add would defeat the purpose of the check. Likely
outcome for most of these (patient action links, waitlist offers, public
booking, unsubscribe — all token- or flow-gated rather than authenticated)
is a legitimate, reviewed addition; worth double-checking
`EmailWebhookController`'s `/resend` route specifically, since "resend" as
a public, unauthenticated action is the one entry here that reads as
possibly broader than intended without seeing its own guard logic.
