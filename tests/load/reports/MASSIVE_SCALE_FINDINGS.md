# Massive-Scale Load Test — Findings

**Date:** 2026-09-02 · **Environment:** local isolated perf lab (`ziyarati_perf`)
**Phase:** measurement-first. Nothing here is fixed in application code; every
entry records what was measured, how, and what it would take to close.

Severity uses the impact if the condition reached production, not the impact in
the lab.

---

## MS-001 — CRITICAL — The double-booking guard is absent from the database while its migration is recorded as applied

**Status:** **RESOLVED 2026-09-02 by P0.1** — see
`P0.1_APPOINTMENT_INTEGRITY_REPORT.md` and `P0.1_MIGRATION_DRIFT_FINDINGS.md`.
Root cause proven: every `TYPEORM_SYNCHRONIZE=true` boot ran TypeORM's
`RdbmsSchemaBuilder.dropOldExclusions()`, which drops any EXCLUDE constraint
absent from entity metadata — so the application itself destroyed the guard on a
correctly-migrated database, leaving the `migrations` row behind. Fixed by
declaring the constraint on the `Appointment` entity (`@Exclusion`) plus an
idempotent repair migration. Re-tested: 500 VUs on one slot → exactly 1 winner,
0 overlapping pairs, 0 5xx. **Production remains unverified — run
`scripts/verify-appointment-guard.sql`.**

**Original status (as found):** measured and reproduced. **Not** an
application-code defect — the migration, the error mapping and a boot-time
detector all exist and are correct. The defect is a *schema drift* that makes
all three inert.

### Evidence

`AppointmentNoOverlap1730001100000` creates the constraint that is the sole
race-safe guarantee against double booking:

```sql
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
EXCLUDE USING gist ("staffId" WITH =, tstzrange("start_at","end_at",'[)') WITH &&)
WHERE (status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL)
```

In both local databases the migration is **recorded as applied** and the
constraint **does not exist**:

| database | `migrations` row present | constraint present |
|---|---|---|
| `ziyarati_perf` (load-test lab) | yes | **no** |
| `ziyarati` (development) | yes | **no** |

```
SELECT conrelid::regclass, conname FROM pg_constraint WHERE contype='x';
-- (0 rows)   <- no exclusion constraint anywhere in the schema
```

The application already detects this. `SchedulingIntegrityService` logged, at
every boot including throughout the 2026-09-01 P0 load campaign:

```
ERROR [SchedulingIntegrityService] MISSING DOUBLE-BOOKING GUARD — the EXCLUSION
constraint "appointments_no_overlap" is not installed on "appointments".
```

### Measured impact

Identical scenario, identical code, identical data — **500 VUs aiming at one
staff member's single 15-minute slot**, run once with the guard absent and once
with it installed:

| | HTTP 5xx | rows created in the contested slot | overlapping active pairs in DB |
|---|---|---|---|
| **guard absent** (as found) | 0 | **495** | **122,265** |
| **guard installed** | 0 | **1** | **0** |

495 confirmed appointments for one doctor at one time. The API returned `201`
for every one of them, so no client, log line or k6 metric showed a problem:
`http_req_failed` was 0.00% in both runs. Only the database can see it.

`122,265 = C(495,2)` — every created row overlaps every other.

### Why the application check does not cover it

`AvailabilityService.assertBookable` is a `SELECT`-then-`INSERT`. Under READ
COMMITTED there are no gap locks, so concurrent requests all read a free slot
and all proceed. The migration's own docstring says exactly this. The 409s the
suite does observe come from requests that arrived *after* an earlier insert had
committed — timing, not a guarantee.

### Correction to the previous phase's record

The P0 remediation report described its contention arm as proving the exclusion
constraint holds under concurrency. It did not: the constraint was not installed
in the database those runs executed against. The P0 *transaction-boundary* change
is unaffected and remains valid — but its race-safety argument rested on a
guarantee that was, in that environment, not present.

### Required action

1. Determine whether **production** has the constraint:
   `SELECT 1 FROM pg_constraint WHERE conname='appointments_no_overlap';`
   Also check staging and every CI/e2e database.
2. If absent, clean any overlapping rows (diagnostic query is in the migration)
   and apply the constraint. It cannot be added while conflicts exist —
   exclusion constraints have no `NOT VALID` form.
3. Root-cause the drift: the migration is *recorded* as applied, so this is not
   simply "migrations never ran". Either the schema was built by
   `TYPEORM_SYNCHRONIZE=true` and the `migrations` table was populated
   separately, or the database was cloned from one already in this state.
4. Consider promoting `SchedulingIntegrityService` from log-only to a startup
   failure in production. It is deliberately log-only today, which is defensible
   — but an error line at boot demonstrably did not stop this from persisting
   across an entire performance campaign.

---

## MS-002 — HIGH — Connection-pool starvation is the first hard failure under concurrency, and `pg_stat_activity` cannot see it

**Status:** measured.

Every HTTP 500 in the VU ladder — **8,386 of them** — carries the same cause:

```
{"statusCode":500,"code":"INTERNAL_ERROR","message":"timeout exceeded when trying to connect"}
Error: timeout exceeded when trying to connect
    at Timeout._onTimeout (node_modules/pg-pool/index.js:224:27)
```

That error is emitted *only* by `pg-pool` when a caller has waited longer than
`connectionTimeoutMillis` (10,000 ms) for a pool slot. It cannot be produced any
other way. It is unambiguous proof of pool starvation with a >10 s wait queue.

### Why five previous audit passes concluded the pool was fine

They read `pg_stat_activity.state='active'`, which peaked at **5 of 10** during
this very run. But `state` describes what the *server* is doing, not whether the
*client* has the connection checked out. A connection held by TypeORM between two
statements of the same operation reports as `idle`. `pg_stat_activity` therefore
cannot distinguish "free in the pool" from "checked out and mid-operation", and
is the wrong instrument for this question.

Corroborating: `total` connections sat at exactly **11** (10 pool + 1 monitor) in
every one of 220 samples — the pool was permanently at its ceiling.

### Scope

The lab runs `DB_POOL_MAX=10` (tracked `.env`). The code default is 15 and the
production budget agreed in P0 is `API_DB_POOL_MAX=15`, so production would hit
this later, not never. A pool-sensitivity experiment is recorded in the main
report; raising the pool is deliberately **not** proposed here as a fix, because
the same run shows the API process is CPU-saturated well before the pool
matters (see MS-003).

---

## MS-003 — HIGH — The single API process, not PostgreSQL, is the capacity ceiling

**Status:** measured, with both sides quantified over the same window.

| | CPU seconds consumed | share |
|---|---|---|
| API process (`process_cpu_user_seconds_total` delta) | **590 s** | — |
| PostgreSQL (`sum(total_exec_time)` over 960,012 statements) | **113 s** | 19% of the API's |

Over a ~780 s wall-clock window on a 16-vCPU host: the API burned ~76% of a
single core it cannot exceed (Node is single-threaded), while PostgreSQL used
113 CPU-seconds spread across 8 physical cores — effectively idle.

Event-loop lag p99 reached **4.32 s**. Peak API RSS reached **1.71 GB**, up from
339 MB at rest, and returned to ~240 MB after the run (queue backlog, not a leak).

`API_CLUSTER_WORKERS` exists and is validated but has never been activated
anywhere. Its measured effect is in the main report.

---

## MS-004 — MEDIUM — The per-request principal lookup is the single largest database cost

**Status:** measured, not optimised.

Top statement by total execution time across the whole ladder:

| calls | total | mean | rows returned | rows/call |
|---|---|---|---|---|
| 82,943 | **49,436 ms** (44% of all DB time) | 0.60 ms | 7,653,967 | **92** |

```sql
SELECT "u"."id", "u"."is_active", "u"."email", "u"."full_name", "t"."id" AS "tenantId", ...
```

It runs once per authenticated request (the guard chain re-loads the principal
from the database every time) and returns ~92 rows each call — a join fan-out
across roles and permissions that is then collapsed in JS. Individually cheap;
collectively the largest single line in the database's bill.

Second by call count: `SELECT $2 FROM ONLY "public"."users" x WHERE "id" = $1
FOR KEY SHARE OF x` — **116,110 calls**, Postgres's own foreign-key validation
lock, driven by the `bookedById` / `userId` columns on inserted appointment,
status-log, history and audit rows.

Not investigated further this phase; measurement only.

---

## MS-005 — INFORMATIONAL — The load generator and the host TCP stack become the limiting factor above ~2,500 VUs

**Status:** measured. This is an environment limitation, recorded so no
application conclusion is drawn from the top of the ladder.

- k6 container CPU peaked at **1,328% of the 1,600% (16 vCPU) engine budget** —
  the generator was competing with the API for the same cores.
- Host ephemeral port range is **16,384** (49152–65535, `netsh int ipv4 show
  dynamicport tcp`). Sampled mid-run: **11,124 established + 4,699 TIME_WAIT =
  15,823**, within ~500 of exhaustion.
- The failure mode above 2,500 VUs is `dial: i/o timeout` — a *connect* failure,
  not a server response — and it is counted in k6's error rate.

Consequence: the 5,000 and 10,000 VU rows of the ladder describe the lab, not the
application. Full reasoning and the arrival-rate cross-check are in the main
report's Environmental Limitations section.

---

## MS-006 — INFORMATIONAL — Tooling defects found and fixed during this phase

Recorded because each one silently destroyed data before it was caught.

| defect | effect | fix |
|---|---|---|
| `monitor.js` `opt()` treated boolean flags as taking a value | `--redis` returned `--gen`, so every Redis sample ran `docker exec --gen …` and failed; a 13-minute run lost its entire Redis dimension | reject a "value" beginning with `--` |
| `monitor.js` wait-event query grouped by an ordinal whose expression contained `count(*)` | Postgres rejected it; every lock/deadlock sample returned `pg_unreachable` | group by the raw columns |
| `monitor.js` stopped with `kill -TERM` from Git Bash | Windows terminates the process outright, the SIGTERM handler never runs, all samples lost | sentinel stop-file, polled each tick |
| isolation probe counted its own expected 403/404 as failures | injected ~3.5% into `http_req_failed` at every level — the exact number the health classification is read from | `responseCallback: http.expectedStatuses(403, 404)` |
| `helpers/auth.js` `loadTenantContext` issued ~7 serial requests per session | at 100 sessions, `setup()` exceeded k6's 60 s `setupTimeout` and the run died with no results | batch the fan-out; `setupTimeout: '600s'` on every scenario |
| `flows/mixed.js` weights are per iteration, not per request | copying the brief's request-level percentages verbatim would have produced ~6% dashboard traffic instead of 25% | weights divided by requests-per-action; documented in the profile |

| `soak.js` re-logged in every VU on its first iteration | a few hundred bcrypt cost-12 logins in the opening seconds blocked the event loop; the soak ran at 12–17 it/s against a target of 80 for five minutes, while the server itself measured idle | anchor the re-login clock to `setup()`'s `startedAt`; see MS-008 |
| editing a shell script while bash is still executing it | bash reads a script lazily by byte offset, so inserting lines mid-run resumes at the wrong offset — VU-ladder run 2 lost its monitor, pgstat and integrity artifacts | freeze and checksum every script before a campaign starts |
| `progressive-sweep.js` caps `maxVUs` at 600 | above ~200 it/s the generator could not deliver the nominal rate (25% dropped iterations for 2 workers); the apparent throughput decline is not established as server collapse | reported as a bound, not a peak; a second generator host is needed to settle it |

---

## MS-007 — MEDIUM — Under saturation, appointments commit but their reminders, notifications and webhooks are silently dropped

**Status:** measured.

At the highest ladder levels, four event listeners logged **245 errors each**:

```
ERROR [NotificationEventListener] Failed to load notification rules for appointment.created: timeout exceeded when trying to connect
ERROR [ReminderListener]          Failed to schedule reminders for appointment <id>: timeout exceeded when trying to connect
ERROR [WebhookDeliveryService]    Failed to load webhook subscribers for appointment.created (tenant <id>): timeout exceeded when trying to connect
ERROR [WorkflowEventListener]     ... same cause
```

Same root cause as MS-002: each listener needs a database read before it can
enqueue its job, and under pool starvation it loses the same 10-second race the
request path does.

The listeners are written to log and continue rather than fail the request —
which is the right call for a booking — but the consequence is a **silent
partial success**: the appointment is created and returned `201`, and its
reminder is never scheduled. Nothing surfaces to the user, the clinic, or any
dashboard. In this lab all four downstreams are empty so nothing was actually
lost; in production a patient would simply not receive their reminder.

**245 occurrences per listener**, against 9,746 appointments created in VU ladder
run 1 — so on the order of **2.5% of that run's bookings lost their follow-up
actions**. Two caveats on that ratio, stated rather than buried: the API error
log covering it also includes the preceding dry-run and contention runs, so 245
is a slight over-count for the ladder alone; and the failures are concentrated in
the saturated levels, so the rate *at saturation* is higher than 2.5% while the
rate at healthy load is zero. The order of magnitude is what matters — it is not
a rounding error, and it is invisible to the caller.

**Recommended direction (not implemented):** these are exactly the operations
that should be enqueued from the request's own already-held transaction (an
outbox row) rather than by a listener that has to re-acquire a connection. The
codebase already has an outbox pattern in the payments path. Not investigated
further this phase.

---

## MS-008 — MEDIUM — bcrypt login blocks the single event loop; a re-authentication herd stalls the whole API

**Status:** measured, accidentally, and worth keeping.

`soak.js` forced every VU to re-authenticate on its *first* iteration even though
`setup()` had already handed it a valid session (`!vuSession || …`). With
`preAllocatedVUs = RATE × 3`, a `RATE=80` soak therefore opened with a few
hundred simultaneous logins.

**Measured effect:** the soak delivered **12–17 iterations/s against a target of
80 for its first five minutes**, with 400 of 400 VUs occupied — while the API's
own `nodejs_eventloop_lag_p99_seconds` read **5.11e-7** and `pg_stat_activity`
showed **one** active connection. The server was not overloaded in any
conventional sense. It was *serialised*: `AuthService` hashes with **bcrypt at
cost factor 12** (~430 ms of pure CPU per login, by design), and bcrypt runs
synchronously on the event loop. Several hundred of those back to back is minutes
of a completely blocked single-threaded process, during which every other request
in the system waits.

### The storm is self-sustaining, not a blip

Measured again during the fixed 30-minute soak, where re-login is scheduled once
at the 10-minute mark and staggered across 60 s:

| soak elapsed | achieved iterations/s | event-loop lag p99 |
|---|---|---|
| 3–10 min (steady state) | **72–75** | 0.024–0.030 s |
| 10–13 min (re-login window) | **25.8** | **5.11e-7** ← see below |
| 13–16 min | **27.4** | **8.095 s** |

Four hundred logins is roughly 172 s of blocking bcrypt, yet throughput was still
at a third of steady state **ten minutes later**. The reason is a feedback loop:
a login that times out never updates its "last authenticated" timestamp, so the
re-login condition stays true and that VU retries on its *next* iteration — and
every one after it. The herd feeds itself.

**Quantified directly.** Sampling `pg_stat_statements` for the login lookup 20
minutes into the soak — ten minutes after the herd began — gave a **sustained
2 logins/second**. At the suite's own measured ~430 ms of bcrypt per login, that
is:

```
2 logins/s × 0.43 s of CPU each = 0.86 cores
```

**86% of the one core the API has, consumed by authentication alone**, against a
workload that had been running comfortably at 72–75 it/s an hour earlier. This is
not a subtle effect: two logins per second is enough to take most of a
single-process deployment away from serving requests.

### The metric that should catch it is blind while it is happening

`nodejs_eventloop_lag_p99_seconds` read **5.11e-7** — effectively zero — during
the stall, and only reported the true **8.095 s** minutes afterwards. prom-client
measures lag by scheduling a timer and observing its delay; while the loop is
blocked, that sampler cannot run either, so the histogram receives no samples and
reports its floor. **An event-loop-lag alert will not fire during the exact
incident it exists to detect** — it fires late, after the loop frees up. Alerting
on request latency or on a synthetic probe's success rate covers this; event-loop
lag alone does not.

### Why this matters beyond the test harness

The same shape is reachable in production:

- access tokens live **15 minutes**, so a population of clients that started
  together tends to expire together;
- a deploy, a Redis flush, or any event that invalidates sessions en masse
  produces exactly this pattern;
- with `API_CLUSTER_WORKERS` unset there is **one** event loop to block.

The API does not need to be under load for this to bite — in the measurement
above it was essentially idle apart from the logins.

### Mitigations worth considering (none implemented)

- **Run bcrypt off the event loop** — a worker thread, or an async hashing
  binding. This is the root fix: nothing else stops one CPU-bound operation from
  stalling every other request in the process.
- **`API_CLUSTER_WORKERS ≥ 2`** divides the impact by the worker count — another
  argument for P1 in the report's §19, and the cheapest partial mitigation
  available today.
- **Jitter access-token lifetime per session** so a cohort that authenticated
  together does not expire in lockstep.
- **Back off failed re-authentication.** The self-sustaining part of this is a
  client-side retry loop with no backoff. Whatever the server does, a client that
  retries a failed login on its very next action will keep a struggling auth path
  struggling.

### A note on where this was found

This surfaced because a *test harness* had the same bug a client can have. That
is the useful part: the harness was not doing anything exotic — it re-authenticated
when its token was stale and retried when that failed, which is what a normal
client does. The blast radius came entirely from the server side.

### Fixed in the harness

`soak.js` now anchors the re-login clock to `data.startedAt` from `setup()`, so
the first re-authentication happens one full `RELOGIN_AFTER_MS` into the run,
staggered by the existing per-VU jitter. After the fix the same soak reached
72–74 it/s within three minutes.

---

## MS-009 — HIGH — The readiness probe fails under the load it is meant to survive, and would get a healthy instance killed

**Status:** measured, incidentally, during the 30-minute soak.

While the API was still serving traffic — degraded but alive, returning correct
responses — the orchestrator probe answered:

```
GET /api/v1/system/health/readiness   ->  503  after 6.1 s  (and 16.7 s on an earlier sample)
GET /api/v1/system/health/liveness    ->  200  after 2.2 s
```

Body: `ServiceUnavailableException` from `HealthController.readiness`.

### Why

`readiness()` runs `pingDb()` → `this.dataSource.query('SELECT 1')` on the
**shared** `DataSource`, so it queues for a connection from the same pool the
request traffic has exhausted (MS-002). It is capped at
`READINESS_TIMEOUT_MS = 1500`, so it does exactly what it was written to do:
gives up quickly and reports `degraded`.

Two compounding effects make it worse than that design intended:

1. **The pool the probe depends on is the thing that is saturated.** The probe is
   not measuring an outage; it is measuring queueing that it is itself queued
   behind.
2. **The 1.5 s cap does not bound the wall-clock response.** The probe took 6.1 s
   and 16.7 s, because a saturated event loop delays the timeout callback too.
   `liveness`, which touches nothing, still took 2.2 s.

### Why it matters in production

This is the classic degradation-to-outage amplifier. A load balancer or
Kubernetes readiness gate sees 503 and removes the instance; its traffic moves to
its siblings, which are under the same load, which fail their probes, and so on.
A single-instance deployment is removed from service entirely while it is still
capable of serving — and if the probe is wired to *liveness*-style restarts, the
process is killed and every in-flight request with it.

### Not measured

Whether production's orchestrator actually gates on this endpoint, and with what
failure threshold. That determines whether this is a latent risk or an active
one, and it is the first thing to check.

### Recommended direction (not implemented)

- Give the readiness check its **own** small dedicated connection (or a
  `pg` client outside the request pool) so it reports on the *database*, not on
  pool contention.
- Distinguish "dependency down" from "server busy". A saturated-but-working
  instance should stay in rotation, or shed load deliberately — not be removed
  by a probe that cannot tell the difference.
- Whatever the fix, verify it against this exact scenario: the probe must give a
  *correct* answer at 80 it/s with a 10-connection pool, which today it does not.

| `docker exec` without `MSYS_NO_PATHCONV=1` inside an orchestration script | Git Bash rewrote the in-container path `/tmp/cleanup.sql` to a Windows path, so the cleanup silently did nothing — and `>/dev/null 2>&1` hid the error. 16,570 rows survived a cleanup that reported success | the README already warns about this; the lesson is not to swallow stderr on a step whose failure is invisible |
