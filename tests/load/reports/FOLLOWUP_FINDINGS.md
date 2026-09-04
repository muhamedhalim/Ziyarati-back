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
