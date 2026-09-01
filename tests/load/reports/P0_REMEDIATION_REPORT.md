# P0 Performance Remediation — `POST /appointments` + connection pool

**Date:** 2026-09-01 · **Scope:** P0 only · **Method:** every "before" number in this
document was re-measured **in the same session, on the same machine, against the same
database, minutes apart** from its "after" counterpart, by reverting the code and
re-running the identical scenario. Nothing is carried over from the earlier audit.

---

## 1. Analysis before any change

### 1.1 What `AppointmentsService.create` did

One `dataSource.transaction()` wrapped **everything**:

| # | Step | Ran on |
|---|---|---|
| 1 | `assertBranch` — branch exists, active, in caller's branch scope | txn |
| 2 | `assertCustomer` | txn |
| 3 | `assertStaffAtBranch` — profile + up to 2 schedule probes | txn |
| 4 | `loadServices` + `resolveBranchPrices` (raw `service_prices`) | txn |
| 5 | `computeWindowAndTotal`, `assertChronological` | pure JS |
| 6 | **`availability.assertBookable({ manager })`** | txn **+ 6 sibling services on their own connections** |
| 7 | `usage.incrementIfWithinLimit` | txn |
| 8 | `Branch.findOne` — *re-read of the same row from step 1*, for `timezone` | txn |
| 9 | `isOnlinePaymentDue` — raw `tenant_settings` | txn |
| 10 | `INSERT appointment` ← **the exclusion constraint fires here** | txn |
| 11–13 | `persistServices`, `writeStatusLog`, `writeHistory` | txn |

**Measured cost of one booking: 49 SQL statements** (`db_queries_total` delta on an idle
API, 5 consecutive samples, all identical).

### 1.2 The actual defect — a self-deadlock, not "the pool is too small"

`AvailabilityService.evaluate` fans out via `Promise.all` to six sibling services —
`SchedulingRefService`, `HolidayService`, `BlockedSlotService`, `StaffTimeOffService`,
`CalendarSlotService`, `StaffScheduleService`. Each holds its own `@InjectRepository`
handle, so **each checks out its own connection from the same pool** — while the booking
transaction is already holding one. Only `findOccupying` and `enforceWorkingHours`
honoured the passed `manager`.

So a booking in flight needs **its transaction's connection *plus* at least one free
connection**. Proven directly rather than inferred:

| `DB_POOL_MAX` | One uncontended booking |
|---|---|
| **1** | **HTTP 500 after 4,045 ms** — `"timeout exceeded when trying to connect"` |
| 2–8 | completes in 55–100 ms |

That error string is the *same one* that accounted for 100% of the 5xx in the original
load test. It follows that **N concurrent bookings deadlock whenever N reaches the pool
size**: every connection is held by a transaction waiting for a connection that can never
be freed. That is precisely the `idle in transaction = 10 (whole pool), active = 1,
longest query 0.00 s` signature recorded at collapse.

This is the same class of defect as **FND-047**, already fixed for `UsageService` by
threading the manager through (see the `connectionTimeoutMillis` comment in
`typeorm.config.ts`). The six services above were missed.

### 1.3 Race safety — why the validation may leave the transaction

The transaction never provided double-booking protection:

- The guarantee is the **`appointments_no_overlap` gist EXCLUDE constraint** (migration
  `1730001100000`) on `("staffId", tstzrange(start_at, end_at, '[)'))`, which fires at
  `INSERT`. That INSERT stays inside the transaction. A race loser still gets SQLSTATE
  `23P01` → `SLOT_ALREADY_BOOKED`.
- Under **READ COMMITTED** (the default) every statement takes a fresh snapshot and takes
  no gap locks, so a `SELECT` issued as the transaction's *first* statement sees exactly
  what the same `SELECT` issued a moment earlier outside it would see. `AvailabilityService`'s
  own docstring states this in three places: the occupancy check *"can never be race-safe
  under READ COMMITTED"*.
- Every other check (branch/customer/staff/service existence, holidays, time off, blocked
  periods, working hours) races only against concurrent **configuration edits**, which the
  transaction locked no more than a plain read does.

The only thing that widens is the interval between "checked" and "inserted" — and the
outcome of losing that race is a 409 either way.

### 1.4 Smallest transaction that preserves atomicity

Quota admission + this booking's four INSERTs. The usage increment must stay with the
INSERTs so a `23P01` rollback still undoes it — that is unchanged.

---

## 2. Files changed

| File | Change | Reason |
|---|---|---|
| `src/modules/appointment/appointment.service.ts` | `create()` split into a validation phase (no transaction) and a write phase (quota + 4 INSERTs). `assertBookable` called without `manager`. | Removes the nested pool acquisition that caused the self-deadlock. |
| ″ | `assertBranch` returns the `Branch` instead of `exists`; the separate `Branch.findOne` timezone read deleted. | The same row was read twice on the same predicate. −1 statement. |
| `src/config/typeorm.config.ts` | Added `statement_timeout` + `idle_in_transaction_session_timeout` to the pool `extra`, role-aware with env overrides. | Backstop so the *next* leaked transaction fails loudly instead of holding a pool slot. |
| `src/modules/appointment/appointment.service.spec.ts` | Updated the `assertBookable` contract assertion; added 2 regression guards. | The transaction boundary is now behaviour under test, not a comment. |
| `.env.example` | Documented the measured pool budget and the new timeout knobs. | Configuration template only. |

**`DB_POOL_MAX` was deliberately NOT raised** — see §5.

---

## 3. Before / After — all measured

### 3.1 Required metric table

| Metric | Before | After | Change |
|---|---|---|---|
| **Appointment p95** (write scenario) | 76.3 ms | **69.3 ms** | −9.2% |
| **Overall p95** @ 8 it/s (baseline) | 56.3 ms | 57.6 ms | +1.3 ms |
| **Overall p95** @ 110 it/s | 11,468 ms | **5,246 ms** | **−54%** |
| **Throughput** peak | 211 req/s | **219 req/s** | +3.8% |
| **Throughput** @ 110 it/s | 182 req/s *(collapsed)* | **219 req/s** | **+20%** |
| **Error rate** (sweep 5→110) | 2.25% | **0.11%** | **−95%** |
| **Error rate** (sweep 110→160) | 24.32% | **0.49%** | **−98%** |
| **5xx** (sweep 5→110) | 615 | **0** | **−100%** |
| **5xx** (sweep 110→160) | 4,304 | **0** | **−100%** |
| **5xx** (30-VU contention) | 90 | **0** | **−100%** |
| **Pool exhaustion** (min pool for 1 booking) | 2 connections | **1** | deadlock removed |
| **idle_in_transaction** (sweep, max / avg) | 10 / 1.19 | **2 / 0.13** | −80% / −89% |
| **idle_in_transaction** (contention, max / avg) | 10 / 6.09 | **0 / 0.00** | **eliminated** |
| **DB connections** (peak active, pool of 10) | 5 | 5 | unchanged |
| **CPU** @ 100 it/s | 87% of one core | 101% of one core | **+14 pts** |
| **First degradation** (p95 > 100 ms) | 100 it/s | 80 it/s | earlier |
| **Failure point** (errors > 1%) | **110 it/s**, then collapse | 120 it/s, **no collapse to 160** | ceiling removed |

### 3.2 Degradation curve, same session, identical rates

| it/s | req/s before | req/s after | p50 before | p50 after | p95 before | p95 after | err before | err after |
|---|---|---|---|---|---|---|---|---|
| 5 | 10 | 10 | 24 | 27 | 48 | 48 | 0.00% | 0.00% |
| 10 | 19 | 22 | 22 | 25 | 41 | 44 | 0.00% | 0.00% |
| 20 | 41 | 42 | 20 | 21 | 39 | 39 | 0.00% | 0.00% |
| 40 | 83 | 81 | 18 | 19 | 37 | 39 | 0.00% | 0.15% |
| 60 | 125 | 125 | 18 | 22 | 40 | 50 | 0.00% | 0.00% |
| 70 | 150 | 147 | 19 | 24 | 45 | 61 | 0.00% | 0.00% |
| 80 | 170 | 172 | 22 | 33 | 69 | 107 | 0.00% | 0.13% |
| 90 | 192 | 196 | 25 | 38 | 75 | 117 | 0.33% | 0.29% |
| 100 | 211 | 211 | 41 | 117 | 161 | 523 | 0.27% | 0.01% |
| **110** | **182** | **219** | 317 | 1,699 | **11,468** | **5,246** | **13.96%** | **0.19%** |

Note the before row at 110: throughput goes **backwards** (211 → 182 req/s) — congestion
collapse. After, it keeps climbing.

### 3.3 At the breaking point (110 it/s), server-side

| | Before | After |
|---|---|---|
| CPU | 21.7% of one core | 54.1% |
| SQL statements/s | 157 | **473** |
| event-loop lag p99 (max) | 0.141 s | 0.031 s |
| `idle_in_transaction` avg | **4.79** | 0.35 |
| `idle_in_transaction` max | **10 — the entire pool** | 2 |

Before, the API was **paralysed**: 21.7% CPU, 157 statements/s, half the pool frozen.
After, it is **working**: 54.1% CPU, 473 statements/s — 3× the work.

### 3.4 Race correctness (30 VUs → one slot, 30 s, pool = 10)

| | Before | After |
|---|---|---|
| Created (correct winner) | 1,081 | 1,111 |
| **Clean 409 `SLOT_ALREADY_BOOKED`** | **0** | **2,170** |
| **HTTP 500** | **90** | **0** |

Before, the exclusion constraint's correct behaviour was **completely masked** — clients
got `500 Internal Server Error` instead of an actionable "slot already taken". This
matches the earlier `DB_POOL_MAX=40` experiment (2,228 conflicts / 0 5xx) — but achieved at
**pool = 10**, without spending a single extra connection.

### 3.5 Per-request cost (idle API) — deliberately little changed

| | Before | After |
|---|---|---|
| SQL statements per booking | 49 | 48 |
| Median latency | 108 ms | 104 ms |

The fix changes **where connections are held**, not how much work runs. That is why the
benefit appears only under concurrency.

---

## 4. Regressions

**None.** Verified, not assumed:

| Suite | Result |
|---|---|
| Unit — appointments (5 suites) | **95/95 pass** |
| Unit — full run | 5,839 pass. 22 failures, of which **21 reproduce identically with the change stashed** (`rbac.constants`, `advanced-analytics`, `env.validation`); the 22nd is a wall-clock assertion in `failsafe-throttler-storage` that **passes in isolation** — a flake from running the whole suite in parallel. |
| e2e — `appointment-availability`, `usage-quota-concurrency` | 28 pass / 5 fail — **byte-identical failure list on both builds**, environmental (ad-hoc e2e DB on the perf Postgres, no `pgvector`). |
| Build / typecheck | clean; remaining `tsc` errors are pre-existing in `test/branch-manager-scoping.e2e-spec.ts`. |

### The one real cost, honestly stated

Between **60 and 100 it/s the API uses ~5–15% more CPU** at the same offered load
(13→15, 22→27, 34→36, 48→54, 59→69, 66→79, 76→80, 81→90, 87→101 % of one core), which
raises p95 in that band (69→107 ms at 80 it/s, 161→523 ms at 100 it/s). Cause: each
validation read now performs its own pool acquire/release instead of riding the pinned
transaction connection. Since the API is CPU-bound near saturation (§5), that extra CPU
converts directly into latency.

**At idle it is negligible** — baseline p50 +1.7 ms, p95 +1.3 ms, 0% errors both.
(An apparent +8 ms in a first pass was an artifact of comparing against an archived
baseline from an earlier session; the same-session control removed it.)

**The trade is:** ~10% more CPU below the old collapse point, in exchange for the removal
of the collapse itself — no 5xx anywhere, +20% throughput at 110 it/s, and correct 409s
instead of 500s under contention.

---

## 5. The new bottleneck — **single-process CPU**

Determined from data, not assumed:

- **CPU reaches 101% of one core at 100 it/s.** That is the ceiling.
- **The pool is not the constraint:** peak *active* connections **5 of 10** across every
  after-run; `idle_in_transaction` max 2 (sweep) and **0** (contention).
- Event-loop lag p99 averages 0.025 s — the thread is busy, not blocked.
- Postgres is idle: longest active statement 0.000 s across 1,090 samples.

**Therefore `DB_POOL_MAX` was not raised.** Raising it would buy nothing: the code fix
already delivered what pool=40 delivered. Production sizing was still calculated as
requested:

```
max_connections 100 − superuser_reserved 3            =  97 usable
− 15 operations (psql, pg_dump, monitoring)
−  5 transient migration/boot connections             =  77 for application pools

binding case = rolling deploy (old + new API alive):
  API_CLUSTER_WORKERS × API_DB_POOL_MAX × 2 + WORKER_DB_POOL_MAX ≤ 77

shipped topology (1 API container, cluster=1, 1 worker):
  steady    1×15 + 20 = 35 of 97   (36%)
  rolling   2×15 + 20 = 50 of 97   (52%)
```

Recommended and documented in `.env.example`: **`API_DB_POOL_MAX=15`** (the existing code
default — **no change**), **`WORKER_DB_POOL_MAX=20`**. Measured peak demand is 5.

Other Postgres consumers were enumerated, not assumed: the only raw `pg` clients in the
repo are in `scripts/verify-migrations.ts` (a CLI); BullMQ uses Redis; the `migrate`
one-shot and the boot-time advisory-lock runner are transient.

The real next lever is **`API_CLUSTER_WORKERS`** (`PERF-INFRA-003`) — already implemented,
production-validated, and never activated. Note each forked process is independently
single-threaded, so connections do **not** scale proportionally; re-solve the inequality
before raising it (at N=4 there is room for only ~7 each, at which point raise
`max_connections` or put PgBouncer in front).

---

## 6. Timeout backstops

| Role | `statement_timeout` | `idle_in_transaction_session_timeout` |
|---|---|---|
| API | 30 s | 60 s |
| Worker | 120 s | 120 s |

Both verified to reach Postgres by setting them to 1 ms and observing
`canceling statement due to statement timeout` and
`terminating connection due to idle-in-transaction timeout`.

- **Calibration:** across **1,090 `pg_stat_activity` samples** spanning every load scenario,
  the longest *active* statement was **0.000 s**. 30 s is ~3 orders of magnitude above
  anything this workload produces.
- **Migrations are structurally exempt**, not exempt by chosen value: they run on separate
  short-lived DataSources (`run-migrations-with-lock.ts`, `config/data-source.ts`), neither
  of which sets `extra`.
- **Cost measured, not assumed:** a control run with both set to `0` gave p50 32.7 / p95
  56.7 ms versus 34.3 / 57.6 with them on — within noise.

---

## 7. Is P0 production-ready?

**The code fix: yes.** It is behaviour-preserving (same API contract, same status codes,
same business rules), covered by new regression tests that pin the transaction boundary,
and it strictly improves correctness under contention (409 instead of 500).

**Two things need an operator decision before this is *finished*, not before it ships:**

1. **`statement_timeout = 30 s` is calibrated on load-test traffic only.** Endpoints this
   suite never exercises — large exports, wide analytics ranges, integration bulk reads —
   were **not measured**. Either confirm none exceeds 30 s, or set
   `API_DB_STATEMENT_TIMEOUT` higher for the first deploy and tighten it once real p99
   statement durations are known.
2. **The mid-range CPU cost is real.** On a production box already running near one core
   at peak, this fix will show up as higher p95 before it shows up as fewer errors. The
   mitigation is `API_CLUSTER_WORKERS`, which is a separate change.

**Not done, by instruction (P1/P2):** the booking path still issues **48 statements** — the
~11-query availability fan-out is now the dominant remaining cost and is the natural next
target. `update()` and `reschedule()` still pass `{ manager }` into `assertBookable` and
therefore retain the same nested-acquisition shape at lower frequency. Untouched as
instructed: CRM search, activity COUNT, `staff/eligible-users`, cluster workers, logging,
WhatsApp, Moyasar webhook.

---

## 8. Safety

No external side effect was possible: the API is a queue **producer only** and no worker
ran; `whatsapp_accounts`, `notification_rules` and `webhook_endpoints` were all verified
empty (0/0/0). Test data fully removed — the database is back to exactly **60,015
appointments, 0 `k6-load-test` rows**.

## 9. Reproducing

```bash
docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/baseline.js
```
```bash
RATES=5,10,20,40,60,70,80,90,100,110 docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/progressive-sweep.js
```
```bash
RATE=12 DURATION=90s CONTEND_VUS=30 CONTEND_START=100s docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/appointments-write.js
```
```bash
TEST_PASSWORD=... node tests/load/helpers/trace-create.js
```

Raw artifacts: `sweep-BEFORE-control.json`, `sweep-after-lowrates.json`,
`sweep-after-highrates.json`, `write-BEFORE-control.json`, `appointments-write.json`,
`baseline-BEFORE-control.json`, `baseline-AFTER-control.json`, and the matching
`monitor-*.json` server-side samples.
