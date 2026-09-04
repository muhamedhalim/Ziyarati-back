# Massive-Scale Production Load Test — ZiyaraTech API

**Date:** 2026-09-02 · **Phase:** measurement-first (no application code changed)
**Preceded by:** P0 booking-transaction remediation (2026-09-01), Phase 2.1
logging remediation (2026-09-02)

> Every number in this report came from a k6 run, a Prometheus scrape, a
> `pg_stat_activity` or `pg_stat_statements` query, a `docker stats` sample, or a
> direct read of the source. Anything not measured is written **Not measured**.

---

## 1. Executive summary

### The headline is not a performance number

**A concurrency test found a correctness failure: 495 confirmed appointments
were booked into one doctor's single 15-minute slot, and the API returned `201`
for every one of them.** The `appointments_no_overlap` exclusion constraint —
the only race-safe guarantee against double booking — is **absent from both the
load-test and development databases while its migration is recorded as applied**.
Installing it and re-running the identical test produced exactly **one** winner
and 2,499 clean 409s. Client-side error rate was 0.00% in both runs; nothing
except the database could see the difference.

**Required action before anything else in this report matters: check whether
production has this constraint.** Details, scope and remediation:
`MASSIVE_SCALE_FINDINGS.md § MS-001`.

Every performance run below was executed *with* the constraint installed.

### Measured capacity of the current architecture

| | single process (today's default) | 2 workers | 4 workers |
|---|---|---|---|
| **maximum sustainable load** (all SLOs met, 0 5xx) | **80 it/s = 112 req/s** | **100 it/s = 138 req/s** | **100 it/s = 142 req/s** |
| peak throughput before quality collapses | 124 req/s | ≥244 req/s | ≥317 req/s (ceiling not found) |
| PostgreSQL connections used | 10 | 20 | 40 |
| API processes / resident memory | 1 / 785 MB | 3 / 995 MB | 5 / 1.95 GB |
| **healthy concurrent users** (3 s think time) | **200** (76 req/s; 250 is the first level over budget) | Not measured | Not measured |

**Stated as a capacity plan: one API process serves ~112 req/s within the
repository's own latency SLOs, and is healthy at 100 concurrent active users.**

**Throughput and concurrency are separate ceilings and must not be converted
into one another.** At 500 VUs the ladder achieved 120 req/s — essentially the
same throughput as the sweep's healthy 112 req/s — yet p95 was 4,814 ms against
472 ms. Same work done per second, ten times the latency, because 500 requests
were in flight instead of ~40 (Little's Law: `W = L / λ`). Deriving "concurrent
users" from a throughput figure would silently discard that, so it is not done
here: the concurrency numbers come from the VU ladder and the throughput numbers
from the arrival-rate sweep, and only the single-process configuration was run on
both. The gap the coarse ladder left between 100 and 500 was closed with a
dedicated bisection at 150 / 200 / 250 / 300 / 400 VUs: **200 concurrent users is
the last healthy level** (p95 206 ms, 0 5xx) and **250 is the first over budget**
(p95 505 ms). Concurrency for the 2- and 4-worker configurations was **not**
measured — those were compared by arrival rate only.

### What prevents it from scaling further, in order

1. **A single Node event loop.** Over one 13-minute run the API burned **590 CPU
   seconds** against PostgreSQL's **113** — 5.2× the database's cost, inside the
   one core a Node process cannot exceed. Event-loop lag p99 reached 4.32 s.
   Every endpoint class breaches its SLO *simultaneously* at 100 it/s, which is
   the signature of a shared queue rather than any slow endpoint.
2. **The connection pool, secondarily.** All 8,386 HTTP 500s in the VU ladder
   were pg-pool's `connectionTimeoutMillis` — a >10 s wait for a pool slot. Five
   previous audits missed this because `pg_stat_activity.state='active'` peaked
   at 5 of 10; that field cannot see a connection checked out but idle between
   statements.
3. **Nothing else.** PostgreSQL was effectively idle (longest active statement
   0.000 s in 220 samples, zero deadlocks, zero ungranted locks). Redis stayed at
   ~6 MB with zero growth and peaked at 917 ops/s with no blocked clients. (The
   job queue stayed empty, but that is because this lab has reminders disabled,
   not because the queue absorbed the load — see §14.)

### Does process-level scaling actually work?

Yes, and the controlled experiment separates CPU from the pool. Comparing
**1 process with 30 connections** against **2 processes with 20**: more
connections on one process buys **+13%**; fewer connections on two processes buys
**+33%**. CPU parallelism dominates. `API_CLUSTER_WORKERS` is built, validated,
and **still not activated anywhere**.

Its costs are real and measured: **+17% CPU per request** and **2.5× memory** at
4 workers, and at the P0-agreed production pool of 15 per process, **4 workers is
not rolling-deploy safe** against `max_connections=100` (2 × 60 + 20 = 140 > 97
usable). Two workers is (2 × 30 + 20 = 80).

### Behaviour under stress

- **Burst recovery is excellent up to 1,000 concurrent users** — p95 returns to
  ~140 ms within 30 s of load being removed, even after a burst that ran at 15 s
  p95. At 2,500 it no longer recovers inside 30 s.
- **Data integrity held everywhere the guard was installed**: 0 duplicate
  bookings, 0 orphans, 0 partial commits across ~10,000 concurrent creations,
  0 deadlocks, and **0 tenant-isolation violations in 10,139 in-flight
  cross-tenant probes**.
- **A same-tenant hotspot costs ~20% of tail latency** at identical throughput,
  with row-lock waiting appearing only in the skewed run.
- **No drift over 31 minutes.** A 30-minute soak at the sustainable rate ended
  with **less** memory than it started (RSS −222 MB, heap −22 MB) across 108,363
  requests, zero queue growth, zero deadlocks and zero Redis growth. The soak
  nonetheless **FAILED** its latency and error thresholds — but on a discrete
  incident (the re-authentication herd at minute 10), not on the gradual
  degradation a soak exists to detect. Both halves of that are reported.
- **Under saturation, ~2.5% of bookings silently lost their reminders,
  notifications and webhooks** — the listeners could not get a pool connection,
  logged, and continued. The booking succeeds; the follow-up never happens
  (`MS-007`) — the ratio is approximate; see that finding.
- **The readiness probe fails under the load it exists to survive.** While the
  API was still serving, `/system/health/readiness` returned **503 after 6.1 s**
  because it pings the database through the same exhausted pool as request
  traffic. An orchestrator gating on it would remove or restart a working
  instance and cascade the load onto its siblings (`MS-009`).
- **A re-authentication herd is self-sustaining and costs most of the CPU.** A
  sustained **2 logins/second** consumed ~86% of the single core (bcrypt cost 12,
  ~430 ms each, synchronous on the event loop), holding throughput at a third of
  steady state for the rest of the soak (`MS-008`).

### What this report does not establish

The load generator ran on the same 16-vCPU host and peaked at **1,328%** of it.
Above ~2,500 VUs the dominant failure is `dial: i/o timeout` — a TCP connect that
never completed — and the host's 16,384 ephemeral ports were measured at 19,164
concurrent sockets. **The 5,000 and 10,000-VU rows describe the lab, not the
application.** The 4-worker throughput ceiling was never reached: at 300 it/s it
was still climbing with zero 5xx while the generator could only deliver 87% of
nominal. Full disclosure in §18.

---

## 2. Test environment

| | |
|---|---|
| Host | Windows 11 Pro 26200, 2 × Intel Xeon Gold 5222 @ 3.80 GHz — **8 physical cores / 16 logical**, 190.6 GB RAM |
| Docker engine | 16 vCPU, 100.5 GB, overlayfs |
| API | `node dist/src/main`, single process unless stated, `NODE_ENV=test` |
| Database | PostgreSQL 18.4 in Docker, `max_connections=100`, `shared_buffers=128MB`, no CPU/memory limit on the container |
| Redis | Redis 7 in Docker, no limit |
| Worker process | **not running** — this is the structural guarantee that no external send can occur |
| Load generator | k6 v2.2.0 in Docker on the **same host**, reaching the API through `host.docker.internal` |
| API pool | `DB_POOL_MAX=10` (tracked `.env`); code default is 15, P0's production budget is `API_DB_POOL_MAX=15` |
| Logging | `TYPEORM_LOGGING=false`, `PLATFORM_API_LOG_ENABLED=false` (Phase 2.1 also defaults both off under `NODE_ENV=test`) |

The generator sharing the host with the system under test is the single largest
methodological limitation of this campaign and is quantified in §18.

---

## 3. Dataset size

| table | rows |
|---|---|
| tenants | 52 (50 perf + 1 RTL fixture + 1 guest-discovery) |
| users | 381 |
| appointments | 60,015 (seeded) |
| customers | 15,012 |
| branches | 126 |
| staff_profiles | 376 |
| staff_schedules | 2,632 |
| services | 416 |
| working_hours | 882 |
| audit_logs | 66,183 |
| **database size** | **211 MB** at rest |

**Loggable tenants were raised from 5 to 50** for this phase. The perf seed gives
real credentials to only the first five tenants; every other tenant's users carry
a different hash whose plaintext this suite does not hold, so what was called a
"multi-tenant" run had been a 5-tenant run. `data/fixture.sql` §8 promotes one
Clinic Owner and one Receptionist per tenant by copying the *existing* hash from
`perf.owner.t0` — no plaintext is read or introduced — and renaming them onto the
pattern `helpers/auth.js` already generates. Result: **100 sessions across 50
tenants**.

---

## 4. Workload distribution

### The unit problem, stated once

`flows/mixed.js` weights are per **iteration**; an iteration is one user action
and issues **1–6 HTTP requests**. The brief's percentages are request shares.
Copying them straight into the weight table would have produced ~6% dashboard
traffic instead of 25%, because a dashboard page view is a 6-request batch for an
owner and a 3-request batch for a receptionist while an availability check is one
request. Weights below are therefore `target_share ÷ requests_per_action`.

### `prod-mix` — the profile used for this campaign

| action | weight | requests / iteration | resulting request share | brief's target |
|---|---|---|---|---|
| availability windows | 40 | 1 | 21.1% | 20% |
| appointment create | 30 | 1 | 15.8% | 15% |
| dashboard page view | 11 | 6 owner / 3 receptionist (avg 4.5) | 26.1% | 25% |
| appointments list + detail + filtered | 9 | 3 / 5 / 1 | 12.1% | 10% |
| CRM search + list | 20 | 1 | 10.6% | 10% |
| staff page view | 5 | 2 | 5.3% | 5% |
| notification poll | 10 | 1 | 5.3% | 5% (auth/session) |
| analytics — staff performance | 10 | 1, **owner-only** | 2.6% | 5% |
| activity log | 1 | 5 (or 1 when searched), **owner-only** | 1.0% | 5% (misc) |

Two deliberate departures from the brief's numbers, both forced by the actual
API rather than chosen:

- **Analytics lands at 2.6%, not 5%.** `/analytics/performance/staff` requires
  `analytics.reports.read`, which owners hold and receptionists do not. Sessions
  are a 50/50 owner/receptionist split, so the effective share is half the
  nominal weight. Weighting it up to reach 5% would mean owners issuing analytics
  reports at twice the rate a real owner does.
- **Activity log lands at 1%.** Same permission split (`audit.read`), and
  receptionists never open that page in the product at all.

Validation: designed 1.39 requests/iteration, **measured 1.52** (122,470 requests
÷ 80,331 iterations, ladder run 1). The gap is the tenant-isolation probe (one
extra request every 20 iterations) plus `appointment-detail` falling back to a
list page view before any id has been cached.

### The other profile, and why both matter

`flows/mixed.js` also carries the pre-existing `default` profile, derived from
the frontend's own request-assertion tests. It books **~2.5× less often** than
`prod-mix` (writes ~6% combined) on the grounds that a receptionist books a
handful of appointments an hour while viewing hundreds of pages.

`prod-mix` is the brief's stress-weighted model and is what the ladder and sweep
below use. `default` is the honest model of today's product. Where they diverge,
`prod-mix` is the more pessimistic of the two — a capacity figure derived from it
is a floor, not a best case.

---

## 5. VU / RPS ladder

Two ladders were run because they answer different questions, and a capacity
statement that uses only one of them is misleading:

| | VU ladder (`vu-ladder.js`) | arrival-rate sweep (`progressive-sweep.js`) |
|---|---|---|
| what is fixed | number of concurrent users | offered load, in actions/second |
| answers | what a user experiences when N of them are on the system | how much work the system can absorb |
| load is | closed-loop — a saturated server slows the offered load down | open-loop — offered load is held regardless |
| used here for | the concurrency envelope and burst recovery | the capacity number and the first degradation point |

**A VU is only a user if it thinks.** These runs use `THINK_MS=3000`: one action
every ~3 s plus latency, so offered action rate ≈ `VUs / (3 + latency)`. With no
think time a VU is an infinite-speed robot; 100 of them already exceed this
system's capacity, and a 100→10,000 ladder would report "saturated" at every rung
while measuring nothing but queue depth. A `THINK_MS=0` control is run
explicitly so that difference is measured rather than asserted.

Full per-level tables, variance across two runs, and the HEALTHY / DEGRADED /
SATURATED / FAILED classification: **MASSIVE_SCALE_CAPACITY_MATRIX.md § 2**.

Headline: **HEALTHY at 100 concurrent users; DEGRADED at 500; SATURATED at
1,000; FAILED at 5,000.** Burst recovery is complete within 30 s up to and
including 1,000 users, and no longer complete at 2,500.

---

## 6. Results per load level

Every load level, both instruments, is tabulated in
**MASSIVE_SCALE_CAPACITY_MATRIX.md**:

| what | where |
|---|---|
| VU ladder, both runs, per-level, with variance | § 2 |
| arrival-rate sweep, single process, per-endpoint against SLO | § 3.1 |
| worker comparison, 1 / 2 / 4, plus the pool-30 control | § 3.2, § 3.3 |
| high-rate sweeps for 2 and 4 workers | § 3.4 |
| where the generator rather than the application limited the run | § 3.5 |
| same-tenant hotspot vs even spread | § 4 |
| think-time control | § 5 |
| throughput vs concurrency — two different ceilings | § 6 |
| 30-minute soak | § 7 |
| concurrency bisection, 150–400 VUs | § 8 |

---

## 7. Capacity envelope

| | value | measured how |
|---|---|---|
| **Maximum sustainable load** (all repo SLOs met, 0 5xx, 0 pool timeouts) | **80 it/s = 112 req/s** | arrival-rate sweep, per-endpoint p95 against `config/thresholds.js` |
| **Maximum sustainable concurrent users** | **200** at 3 s think time (p95 206 ms, 76 req/s, 0 5xx) | VU ladder + bisection at 150/200/250/300/400 |
| **First concurrency level over budget** | **250** (p95 505 ms, past the 300 ms `cached_read` budget) | same |
| **Closed-loop throughput ceiling** | ~102 req/s (300 VUs → 99, 400 VUs → 102) | same |
| **Peak throughput** (quality already gone) | **124 req/s** | throughput flat across 100 and 120 it/s |
| **Recommended operating point** | **≤ 60 it/s = 83 req/s** | p95 132 ms leaves ~2.3× headroom to the knee at 80 |

**These are two ceilings, not one.** 400 VUs achieved 102 req/s — below the
sustainable 112 — while its p95 was 4,035 ms against 472 ms, because ~400
requests were in flight rather than ~40. Throughput measures how much work gets done; concurrency
measures how deep the queue is while it happens. A capacity plan needs both, and
neither can be computed from the other.

With `API_CLUSTER_WORKERS=2`: sustainable **100 it/s = 138 req/s**, peak
≥ 244 req/s. With 4: sustainable **100 it/s = 142 req/s**, peak ≥ 317 req/s and
not reached.

The gap between "sustainable" and "peak" is narrow and the transition is sharp —
see §8. This system does not degrade gracefully; it works, and then it queues.

---

## 8. First degradation point

**Between 80 and 100 iterations/second (112 → 122 req/s), single process.**

| endpoint | SLO | 60 it/s | **80 it/s** | 100 it/s |
|---|---|---|---|---|
| `dashboard` | 300 ms | 57 ms | 130 ms | **2,059 ms** |
| `appointments:list` | 800 ms | 60 ms | 171 ms | **2,996 ms** |
| `staff:list` | 800 ms | 79 ms | 266 ms | **4,917 ms** |
| `activity:list` | 800 ms | 29 ms | 109 ms | **2,028 ms** |
| `crm:search:term` | 1,200 ms | 42 ms | 136 ms | **2,942 ms** |
| `availability:windows` | 1,200 ms | 84 ms | 484 ms | **8,557 ms** |
| `appointments:create` | 1,500 ms | 195 ms | 908 ms | **13,901 ms** |

**All seven classes breach at the same step.** No endpoint degrades before the
others, and the ratios between them barely move (availability stays ~4× the
dashboard at every rate). That is the signature of a single shared queue, not of
any individual slow query — and it is why endpoint-level optimisation is ranked
below process-level scaling in §19.

The two endpoints closest to their budget at the last clean step are
`appointments:create` (908 of 1,500 ms — 61% consumed) and
`availability:windows` (484 of 1,200 ms — 40%). Those are the write path and the
engine inside it, so the booking flow is what runs out of headroom first.

Errors begin **later** than latency degradation: 0.00% at 80 it/s, 0.24% at 100,
0.86% at 120. Latency is the leading indicator here; error rate is a lagging one.
An alert on error rate alone would fire roughly one full step after the user
experience has already collapsed.

---

## 9. Saturation point

**Single process: 100 iterations/second ≈ 122 req/s.**

Saturation is defined here as the point where offered load stops converting into
throughput. It is visible three independent ways in the same sweep, which is why
it is stated as a fact rather than a reading of the latency curve:

| offered it/s | achieved req/s | p95 | what changed |
|---|---|---|---|
| 80 | 112 | 472 ms | last step where offered load still converts |
| 100 | **122** | 11,307 ms | **+25% offered load → +9% throughput, +24× latency** |
| 120 | **124** | 14,379 ms | **+20% more offered load → +1.6% throughput** |

1. **Throughput flattens.** 122 → 124 req/s across a 20% increase in offered
   load. Additional work is queued, not served.
2. **Latency explodes at the same step.** p95 472 ms → 11,307 ms. All seven
   endpoint classes cross their SLO simultaneously (§8).
3. **The generator starts being held.** `dropped_iterations` reaches 1,809 (8% of
   scheduled work), concentrated at 100 and 120 it/s — k6's VUs are occupied by
   responses the server has not returned. This is a *consequence* of server
   saturation, and it also means offered load at those steps was below nominal,
   so the plateau is not an artefact of asking for too little.

By concurrency, the same point falls between **500 and 1,000 concurrent users**
at 3 s think time: the VU ladder shows 120 → 134 req/s for a doubling of users,
with p99 crossing the 10 s pool-wait threshold at 1,000 and pool-starvation 5xx
beginning there.

With `API_CLUSTER_WORKERS=2` saturation moves to **≥ 220 it/s ≈ 244 req/s**; with
4 workers it was not reached at 300 it/s (317 req/s, still climbing).

**What saturates:** the single Node event loop. Over the ladder window the API
consumed 590 CPU-seconds against PostgreSQL's 113, with event-loop lag p99 at
4.32 s, `pg_stat_activity.active` never above 5 of 10, and the longest active
statement 0.000 s in 220 samples. The simultaneity of the SLO breaches across
unrelated endpoints is the corroborating signature: a shared queue, not a slow
query.

---

## 10. Breaking point

"Breaking" is used strictly: sustained 5xx, connection exhaustion, runaway
latency, unbounded queue growth, memory exhaustion, or a data-integrity
violation. Each is reported separately because they occur at different loads.

### By failure mode

| failure mode | where it first occurs | evidence |
|---|---|---|
| **Data-integrity violation** | **immediately, at any concurrency, when the double-booking guard is missing** | 495 appointments in one slot at 500 VUs; 122,265 overlapping pairs. Load-independent — it is a schema defect, not a capacity one (§15, MS-001) |
| **Connection-pool exhaustion (5xx)** | **~1,000 concurrent users** | 8,386 HTTP 500s, all `pg-pool connectionTimeoutMillis`. Structurally impossible below the level whose p99 crosses 10 s, which is 1,000 (p99 15–17 s); 500 VUs has p99 5.4 s and produced none |
| **Runaway latency** | **1,000 concurrent users** | p95 15.1 s, p99 16.4 s — 19× the loosest SLO in the repository |
| **Error rate > 1%** | **2,500 concurrent users** | 1.45% / 1.35% across two runs |
| **Failure to recover from a burst** | **2,500 concurrent users** | recovery-probe p95 jumps from ~140 ms to 4.3–5.0 s and does not return within 30 s |
| **Silent loss of follow-up actions** | at pool exhaustion | 245 errors each from the reminder, notification, webhook and workflow listeners — ~2.5% of bookings kept their appointment and lost their reminder (MS-007) |
| **Sustained mass failure** | **5,000 concurrent users** | 16.7–17.1% error rate, p95 pinned at the 60 s client timeout |
| **Memory exhaustion** | **not reached** | API RSS peaked at 1.71 GB from a 339 MB base and returned to ~240 MB afterwards. Queue backlog, not a leak |
| **Unbounded queue growth** | **not reached** | BullMQ `wait` 0, `active` 0, `delayed` 15 throughout |
| **Deadlocks** | **not reached** | `pg_stat_database.deadlocks` delta 0 in every run, including 500-VU single-slot contention |
| **PostgreSQL saturation** | **not reached** | active connections peaked at 5–9 of 10–40; longest active statement 0.000 s across 220 samples |

### The single number, if one is wanted

**The application breaks at ~1,000 concurrent users (≈134 req/s offered) on a
single process**, where connection-pool exhaustion starts returning 5xx and
latency passes 15 s. It is already unusable well before that: SLOs are breached
at 500 users and throughput has stopped growing at 1,000.

### What was NOT established

The 5,000 and 10,000-VU levels are **environment-bound, not application-bound**.
Above ~2,500 VUs the dominant failure is `dial: i/o timeout` — a TCP connect that
never completed — against a host with 16,384 ephemeral ports measured at 19,164
concurrent sockets, while the load generator was taking up to 1,328% of the
16-vCPU engine. Those rows describe the lab (§18).

Likewise, **the 4-worker breaking point was never found**: at 300 it/s it was
still climbing at 317 req/s with **zero 5xx**, nine active database connections
of forty, and no deadlocks, while the generator could deliver only ~87% of the
nominal rate. The application was not failing; the lab ran out of ability to
offer load. Settling it needs a generator on a separate machine.

---

## 11. API worker comparison (`API_CLUSTER_WORKERS`)

### Connection budget, calculated before each configuration was run

`API_CLUSTER_WORKERS` forks N copies of the API entrypoint, **each with its own
independent pool**, so total API connections are `N × API_DB_POOL_MAX`. This
was verified against `pg_stat_activity` for every configuration rather than
assumed.

**Lab** — PostgreSQL `max_connections = 100`, `superuser_reserved_connections = 3`
→ 97 usable. Pool per worker = 10 (tracked `.env`). Worker process not running.

| workers | API connections | monitor | total | headroom of 97 |
|---|---|---|---|---|
| 1 | 10 | 1 | 11 | 86 |
| 2 | 20 | 1 | 21 | 76 |
| 4 | 40 | 1 | 41 | 56 |

All three fit comfortably. The lab is therefore a valid place to measure
*whether* worker scaling helps, but **not** a valid place to conclude it is safe
in production, because production's pool is larger:

**Production** — using the budget agreed in the P0 phase
(`API_DB_POOL_MAX=15`, `WORKER_DB_POOL_MAX=20`) against the same
`max_connections=100` → 97 usable:

| workers | API steady | + worker process | steady total | rolling deploy (2 API generations live) | verdict |
|---|---|---|---|---|---|
| 1 | 15 | 20 | 35 | 50 | safe |
| 2 | 30 | 20 | 50 | **80** (82% of 97) | safe, tight |
| 4 | 60 | 20 | 80 | **140** | **exceeds 97 — not rolling-deploy safe** |

To make 4 workers rolling-deploy safe without raising `max_connections`,
`API_DB_POOL_MAX` would have to drop to ≤ 9 (2 × 4 × 9 + 20 = 92). The
cluster bootstrap already warns above `workers × poolMax > 50`, which 4 × 15 = 60
triggers.

**Migrations, schedules and queues are safe to fork** — verified by reading the
code, not assumed:

- BullMQ `@Processor` classes exist only in `WorkerModule` (`worker.ts`); the API
  entrypoint never consumes jobs, so forking it N times cannot duplicate job
  processing.
- Repeatable/cron jobs are registered only by `ScheduleRegistrarService`, itself
  only instantiated by `WorkerModule` — unreachable from this entrypoint — and
  BullMQ deduplicates repeatables by `{name, repeat}` key regardless.
- Migrations run behind a Postgres advisory lock
  (`run-migrations-with-lock.ts`), which serialises every process root and every
  replica of each.
- `OnApplicationBootstrap` schema bootstraps issue only
  `IF NOT EXISTS` / `CREATE OR REPLACE` DDL inside per-statement try/catch.
- Socket.IO already uses a Redis-backed adapter; payment idempotency is a
  database unique constraint, not in-process state.
- **Graceful shutdown**: the primary forwards SIGTERM/SIGINT and waits up to
  25 s for workers to exit before force-killing, with a crash-loop guard
  (4 unexpected exits per worker per 60 s stops respawning).

### Measured results

Identical sweep (`prod-mix`, 20→120 it/s, 45 s steps), API restarted between
configurations, nothing else changed. Full tables:
**MASSIVE_SCALE_CAPACITY_MATRIX.md § 3.2–3.4**.

| | 1 worker (today) | 2 workers | 4 workers |
|---|---|---|---|
| max sustainable (all SLOs met) | 80 it/s = **112 req/s** | 100 it/s = **138 req/s** | 100 it/s = **142 req/s** |
| p95 at 100 it/s | **11,307 ms** | 552 ms | **243 ms** |
| peak throughput reached | 124 req/s | ≥ 244 req/s | ≥ 317 req/s (**ceiling not found**) |
| PostgreSQL connections used | 10 | 20 | 40 |
| API CPU ms per request | 11.7 | 12.9 | **13.7 (+17%)** |
| API resident memory | 785 MB | 995 MB | **1.95 GB (2.5×)** |
| 5xx | 0 | 0 | 0 |
| deadlocks / ungranted locks | 0 / 0 | 0 / 0 | 0 / 0 |

**Answer to "real horizontal scaling, or a new DB bottleneck?" — real scaling, no
DB bottleneck.** The controlled discriminator is `1 process + 30 connections`
against `2 processes + 20 connections`: the single process has *more* connections
and still loses, 140 req/s against 165. More connections buy +13%; more processes
buy +33%. PostgreSQL never became the constraint in any configuration —
`pg_stat_activity.active` peaked at 5, 6 and 9 against pools of 10, 20 and 40,
with zero deadlocks and zero ungranted locks throughout.

Diminishing returns are visible and worth stating plainly: **going 1→2 workers
buys +33%; going 2→4 buys only +3% more at the rates the lab could offer**, while
costing another 20 connections and another gigabyte of memory. The 4-worker
ceiling was never reached (§18.2), so 4 workers may well be worth more than these
numbers show — but on the evidence actually collected, **2 is the configuration
with a demonstrated return and a rolling-deploy-safe connection budget.**

Graceful shutdown, scheduled jobs, queue consumption and migrations were all
verified safe under forking by reading the code (above); nothing was assumed.

---

## 12. Database behaviour

### The database was never the constraint

Measured over the same 13-minute window (VU ladder run 1):

| | value |
|---|---|
| PostgreSQL total execution time, all statements | **112,673 ms** across **960,012** statements |
| API process CPU (`process_cpu_user_seconds_total` delta) | **590 s** |
| ratio | the API burned **5.2× the CPU PostgreSQL did** |
| wall clock | ~780 s |

PostgreSQL's 113 seconds were spread across 8 physical cores; the API's 590 s had
to fit inside the one core a Node process can use. `pg_stat_activity.active`
peaked at **5** and `longest_active_s` was **0.000 s** in every one of 220
samples — no statement was ever slow.

*Strictly, `total_exec_time` is wall-clock time inside the server, not CPU time.
On this dataset the two are close: the database is 211 MB against 128 MB of
shared buffers plus the OS page cache, so there is essentially no IO wait to
inflate it. Even taking the figure as an upper bound on CPU, the conclusion is
unchanged — the ratio would only move further in the API's direction.*

### Connections

`total` sat at exactly **11** in every sample: the 10-connection pool plus the
monitor's own psql session. `idle_in_transaction` peaked at **6**,
`waiting_on_lock` at **1**, `pg_stat_database.deadlocks` delta **0**, ungranted
locks max **0**.

**`pg_stat_activity` cannot detect this system's pool starvation.** A connection
checked out by TypeORM but between two statements of one operation reports as
`idle`, so `state='active'` describes server work, not pool occupancy. The same
run produced 8,386 HTTP 500s whose every stack ends at
`pg-pool/index.js:224` — `connectionTimeoutMillis` exceeded, which is emitted
only after a caller has waited 10 s for a pool slot. See MS-002.

### Top statements by total execution time

| total | calls | mean | rows | rows/call | statement |
|---|---|---|---|---|---|
| **49,436 ms** | 82,943 | 0.60 ms | 7,653,967 | **92** | principal + tenant lookup (`SELECT "u"."id", … "t"."id" AS "tenantId"`) |
| 7,975 ms | 3,676 | 2.17 ms | 865,961 | 236 | `UserRole` hydration |
| 4,420 ms | 23,072 | 0.19 ms | 69,216 | 3 | `staff_schedules` load (availability engine) |
| 3,590 ms | 9,746 | 0.37 ms | 9,746 | 1 | `INSERT INTO appointments` |
| 3,387 ms | 23,141 | 0.15 ms | 8,888 | — | appointment overlap read (availability engine) |
| 3,307 ms | 23,138 | 0.14 ms | 23,138 | 1 | `working_hours` load |
| 3,055 ms | 4,116 | 0.74 ms | 11,810 | 3 | CRM customer list (`SELECT DISTINCT` pagination) |
| 2,947 ms | 9,746 | 0.30 ms | 0 | — | `INSERT INTO subscription_usage` (quota admission) |
| 2,607 ms | 9,432 | 0.28 ms | 9,432 | 1 | `INSERT INTO audit_logs` |
| 1,817 ms | 1,580 | 1.15 ms | 1,580 | 1 | appointments `COUNT(DISTINCT …)` for pagination |

### Top statements by call count

| calls | total | mean | statement |
|---|---|---|---|
| **116,110** | 1,488 ms | 0.01 ms | `SELECT $2 FROM ONLY "public"."users" x WHERE "id" = $1 FOR KEY SHARE OF x` — Postgres's own foreign-key validation lock |
| 82,943 | 49,436 ms | 0.60 ms | principal + tenant lookup |
| 33,068 | 1,119 ms | 0.03 ms | `StaffProfile` load |
| 33,068 | 854 ms | 0.03 ms | `StaffProfile` DISTINCT pagination |
| 29,908 | 690 ms | 0.02 ms | `FeatureFlag` |
| 29,907 | 1,262 ms | 0.04 ms | `FeatureDefinition` (657,954 rows returned — 22 per call) |
| 29,906 | 159 ms | 0.01 ms | `FeaturePlan` |
| 23,517 | 1,009 ms | 0.04 ms | `Branch` load |
| 23,145 | 183 ms | 0.01 ms | holidays (availability engine) |

Nothing here is individually slow — the slowest mean in the whole table is
2.17 ms. The pattern is **volume**: **7.8 statements per HTTP request**
(960,012 statements ÷ 122,470 requests) under `prod-mix`, against the 4.4 the
earlier campaign measured under the read-heavier `default` profile. The
difference is the write share — `prod-mix` books ~2.5x more often, and a booking
is four inserts plus a quota update plus the availability engine.

What makes the total large is not any one query but what every authenticated
request pays before reaching its handler: the guard chain's principal reload
(92 rows), and three separate feature-flag lookups (`FeatureFlag`,
`FeatureDefinition`, `FeaturePlan` — ~29,900 calls each, one set per request).

No optimisation is proposed in this phase — see §19 for the ranked list.

---

## 13. Redis behaviour

Redis was never close to being a constraint at any load level measured.

Sampled every ~2 s throughout each run (116, 113 and 49 samples for the runs
below):

| | 1 worker sweep | 4 worker sweep | hotspot (1 worker) |
|---|---|---|---|
| `used_memory` peak | 6.1 MB | 6.2 MB | 6.0 MB |
| `used_memory` growth over the run | **0 MB** | 0 MB | 0 MB |
| `connected_clients` peak | 10 | **31** | 9 |
| `blocked_clients` peak | **0** | **0** | **0** |
| `instantaneous_ops_per_sec` peak | 683 | 917 | 725 |
| BullMQ `wait` / `active` peak | 0 / 0 | 0 / 0 | 0 / 0 |
| BullMQ `delayed` peak | 15 | 15 | 15 |

Redis carries three things in the API path: the throttler bucket (lifted to 1e6
by `NODE_ENV=test`, so effectively inert here), the 60-second dashboard/analytics
cache with a single-flight lease, and BullMQ job production. None of them moved
the needle — memory did not grow at all, no client ever blocked, and ~900 ops/s
is trivial for Redis.

**One clustering cost worth noting**: `connected_clients` goes from 10 to **31**
between 1 and 4 API workers. Each forked process opens its own ioredis
connections (cache, throttler, BullMQ producer, and the Socket.IO adapter's
pub/sub pair), so Redis connection count scales with worker count much as the
PostgreSQL pool does. Well within limits here, but it belongs in the same budget
conversation.

The round-trip probe is reported only as a trend: it wraps `docker exec`, whose
own startup dominates the measurement, so it cannot be read as Redis latency.

**Caveat, stated rather than glossed:** because `NODE_ENV=test` lifts the rate
limiter, this campaign did **not** exercise the throttler's Redis path at
production settings (300 req/60 s keyed on `(handler, req.ip)`). Under a real
production configuration every request performs an additional Redis round trip
and — with `trust proxy` unset — every request behind a shared proxy IP lands in
one bucket. **Not measured** this phase.

---

## 14. Worker behaviour

No worker process ran at any point, deliberately (Appendix A). What is measured is
therefore **queue production**, not consumption:

| | value |
|---|---|
| `*:wait` (ready jobs) | 0 throughout |
| `*:active` | 0 throughout |
| `*:delayed` (scheduled reminders) | grew to 15 and stayed there |

**Do not read this as "job production is bounded".** The reason ~9,700 bookings
produced almost no jobs is that this lab cannot produce them:
`ReminderSchedulerService` returns early unless the tenant has
`reminders_enabled` **and** a non-empty `reminder_lead_minutes` **and** a
configured template — and in this database **0 of 51 tenants have reminders
enabled and there are 0 notification templates**. The 15 delayed entries are
leftovers, not this load's output.

**Queue behaviour under a realistic booking load is therefore Not measured.** A
clinic with reminders configured would enqueue one delayed job per lead time per
booking — at the sustainable rate that is roughly 17 bookings/s x however many
lead times are configured. Whether Redis and the worker absorb that is an open
question this campaign did not answer, and it should be answered before the
queue is assumed safe at capacity.

**Worker throughput is Not measured** in this campaign. The most recent figure on
record is from the earlier performance phase: 182.1 jobs/sec unsplit
(`WORKER_ROLE=all`) versus 132.1 jobs/sec split (`critical`+`dispatch`) — i.e.
splitting made it slower, and peak DB connections were 7 of 15 in both. Running a
worker here would have created exactly the external-send risk Appendix A exists to
exclude.

Under load, the API's event listeners **failed to enqueue** at the highest
levels: 245 errors each from `NotificationEventListener`, `ReminderListener`,
`WebhookDeliveryService` and `WorkflowEventListener`, all reading
`Failed to load … : timeout exceeded when trying to connect` — the same pool
starvation as MS-002. These listeners each need a database read before they can
enqueue, and they lost the same race for a pool slot the request path did. They
log and continue rather than failing the request, so the appointment was still
created; the reminder simply was not scheduled. That is a **silent partial
failure under saturation** worth noting: the booking succeeds, the reminder
never happens, and nothing surfaces to the user.

---

## 15. Appointment contention results

**This is the most consequential result of the campaign.** It is placed early
because it changes what the other numbers mean.

### Setup

500 VUs, one shared session (therefore one tenant), all aiming at **one staff
member's single 15-minute slot**, for 30 s. Preceded by a 20 s throughput arm at
5 it/s booking scattered slots. Identical configuration both times; the only
difference is whether the `appointments_no_overlap` exclusion constraint exists
in the database.

### Result

| | attempts | HTTP 201 in the contested slot | HTTP 409 | HTTP 5xx | overlapping active pairs in DB |
|---|---|---|---|---|---|
| **guard absent** (the state the lab and the dev DB were found in) | ~1,490 | **495** | 990 | 0 | **122,265** |
| **guard installed** | ~2,500 | **1** | 2,499 | 0 | **0** |

`122,265 = C(495,2)` — every one of the 495 rows overlaps every other. All 495
were returned to the client as `201 Created`. `http_req_failed` was **0.00%** in
both runs; `business_check_failed` was 0.00% in both. No client-side signal
distinguished the two runs at all.

Verification query on the guarded run:

```
SELECT count(*) FROM appointments WHERE notes='k6-load-test'
  AND start_at = '2027-10-07 05:00:00+00';   -- the contested slot
 -> 1

SELECT count(*) AS k6_rows, count(DISTINCT ("staffId", start_at)) FROM appointments
 WHERE notes='k6-load-test';
 -> 102 rows, 102 distinct (staff, slot) pairs
```

### Against the brief's checklist

| requirement | guard installed | guard absent |
|---|---|---|
| exactly the expected number of successful bookings | **1 — pass** | 495 — **fail** |
| remaining attempts receive 409 | 2,499 — pass | 990 only — fail |
| zero unexpected HTTP 500 | 0 — pass | 0 — pass |
| zero duplicate appointments | 0 — pass | 122,265 pairs — **fail** |
| exclusion constraint remains effective | pass | **constraint does not exist** |
| no deadlocks | `pg_stat_database.deadlocks` delta 0 — pass | 0 — pass |
| no idle-in-transaction exhaustion | max 6 of 10, no timeouts — pass | pass |

Root cause, scope and required action: **MASSIVE_SCALE_FINDINGS.md § MS-001.**

All subsequent runs in this report were executed **with the constraint
installed**, so the ladder, sweep, hotspot and soak numbers describe the system
as designed rather than the system as found.

---

## 16. Data-integrity verification

`data/integrity-check.sql` (read-only) ran automatically after **every**
scenario, before any cleanup. Results across the whole campaign, with the
constraint installed:

| check | expected | observed |
|---|---|---|
| overlapping active appointment pairs (whole table) | 0 | **0** |
| overlapping pairs among rows this suite created | 0 | **0** |
| `appointments_no_overlap` installed | 1 row | present |
| created rows whose branch belongs to another tenant | 0 | **0** |
| created rows whose customer belongs to another tenant | 0 | **0** |
| created rows whose staff belongs to another tenant | 0 | **0** |
| orphaned `appointment_services` / `_status_logs` / `_history` | 0 | **0** |
| created appointments missing their status log | 0 | **0** |
| created appointments missing their history row | 0 | **0** |
| created appointments with a NULL tenant/branch/customer/staff | 0 | **0** |
| status values other than `CONFIRMED` / `IN_PROGRESS` | 0 | **0** |
| deadlocks (`pg_stat_database` delta) | 0 | **0** |
| external-side-effect tables (Appendix A) | 0 | **0** |

Rows checked: 9,746 in ladder run 1, 596 and 102 in the two contention runs,
10,172 during the soak, 452 in the quota-delta run. The database was restored to
its exact starting state afterwards — **60,015 appointments, 0 rows carrying the
suite marker** — and the final integrity pass over the restored database returned
zero on every check.

### The quota counter, measured properly

Comparing cumulative counter values against surviving rows is meaningless — the
counter is a monotonic per-month total incremented inside the booking
transaction, while `cleanup.sql` deletes rows between scenarios without
decrementing it, so it legitimately carries every earlier run. The defect worth
looking for is the *opposite*: a counter that **lags** the row count, which would
mean a booking escaped the quota gate.

Measured with a clean before/after delta around one controlled write run
(10 it/s for 45 s, then 60 VUs contending for one slot):

| | before | after | delta |
|---|---|---|---|
| `sum(subscription_usage.appointments_used)` | 94,023 | 94,475 | **+452** |
| `count(*) FROM appointments` | 76,585 | 77,037 | **+452** |
| appointments k6 reported creating | — | — | **452** |

**Exact three-way match.** Every committed booking incremented the quota counter
exactly once, and no increment survived a booking that did not commit — including
across 2,170 constraint conflicts in the contention arm, every one of which had
to roll back its own increment with it. The quota admission inside the P0
transaction boundary is correct under contention.

The transaction boundary introduced by the P0 remediation holds under this load:
every committed appointment has its status-log and history rows, and no partial
commit was observed in ~10,000 concurrent creations.

**In-flight tenant isolation**, asserted during the run rather than only
afterwards: each VU periodically requested an appointment id belonging to a
*different* tenant using its own credentials. **10,139 probes, 0 violations** —
every one answered 403 or 404. The remaining ~11% of probes returned neither
because the request never completed at the saturated levels (`dial: i/o timeout`),
which is why the count of *violations* rather than the denial rate is the
assertion.

---

## 17. Resource bottlenecks, ranked

| rank | resource | evidence | headroom at the sustainable point |
|---|---|---|---|
| **1** | **Node event loop (single-threaded CPU)** | 590 API CPU-seconds vs PostgreSQL's 113 over the same window; event-loop lag p99 4.32 s; all 7 endpoint classes breach their SLO at the *same* step; 2 processes buy +33% while 3× the connections buy +13% | none — this is the binding constraint |
| **2** | **PostgreSQL connection pool (10)** | all 8,386 HTTP 500s are pg-pool `connectionTimeoutMillis`; pool total pinned at 10 in every one of 220 samples; pool 30 vs 10 on one process = +13% throughput and p95 11.3 s → 4.8 s at 100 it/s | binding only *after* the event loop has already queued |
| **3** | **Host transport (ephemeral ports / accept backlog)** | `dial: i/o timeout` dominates above ~2,500 VUs; 19,164 concurrent sockets against a 16,384 port range | lab-specific; partly an application property (a blocked event loop cannot `accept()`) — not separated, see §18.2 |
| **4** | **Per-tenant row lock** | hotspot run is the only one showing `waiting_on_lock` > 0; costs ~20% of p95 at identical throughput | ~20% of tail latency when one clinic dominates |
| **5** | **Memory** | API RSS 339 MB at rest → 1.71 GB under a 10,000-VU queue, returning to ~240 MB afterwards; 1.95 GB across 5 processes at 4 workers. **No leak**: over a 31-minute soak and 108,363 requests, RSS fell 222 MB and heap fell 22 MB | not a constraint on a 190 GB host; would matter in a small container |
| — | **PostgreSQL CPU / IO** | longest active statement 0.000 s across 220 samples; `active` peaked 5–9 of 10–40; 0 deadlocks; 0 ungranted locks | **not a bottleneck at any measured load** |
| — | **Redis** | 6.0-6.2 MB with zero growth, 917 ops/s peak, 0 blocked clients ever; client count scales 10 -> 31 with worker count | **not a bottleneck at any measured load** |
| — | **Job queue** | `wait` 0, `active` 0, `delayed` 15 | **Not measured** — 0 of 51 tenants have reminders enabled and there are 0 templates, so this load produced almost no jobs (§14) |

---

## 18. Environmental limitations

Stated before the capacity numbers so they are read with the right scepticism.
None of these is an application property.

### 18.1 The load generator shares the host with the system under test

k6 runs in Docker on the same 16-vCPU engine as the API and PostgreSQL.
Measured generator CPU (`docker stats`, ceiling 1,600% = 16 saturated vCPU):

| moment | generator CPU |
|---|---|
| peak during the run | **1,328%** (≈ 13.3 cores) |
| during the 2,500-VU level | ~1,000% |
| typical mid-run | 20–430% |

The API needs one core it cannot share and cannot exceed. At the top of the
ladder the generator was demanding most of the machine, so **the 5,000 and
10,000-VU levels are not clean application measurements**. The generator was
**not** memory-bound (16–18 GB of 93 GB) and never dropped meaningful work
(`dropped_iterations` 106 and 98, ≈0.1% of iterations), so below 2,500 VUs it was
keeping up with what it was asked to offer.

### 18.2 The host TCP stack is a hard ceiling well below 10,000 users

| | |
|---|---|
| Windows dynamic port range | **16,384** (49152–65535) |
| peak concurrent host sockets during a ladder run | **19,164** (established + TIME_WAIT) |
| sampled mid-run at ~5,000 VUs | 11,124 established (5,533 of them server-side on :3001) + 4,699 TIME_WAIT |

Above ~2,500 VUs the dominant failure is `dial: i/o timeout` — the TCP connect
never completed, so the API never saw the request. That is a transport failure,
counted in k6's error rate but not attributable to the application.

**What is not separated:** two mechanisms can produce that symptom here and this
campaign did not distinguish them —

1. host ephemeral-port / Docker NAT pressure (evidence above), and
2. the API's own accept backlog overflowing, because a single-threaded Node
   process with **event-loop lag at 4.32 s** cannot call `accept()` fast enough.

Mechanism (2) *is* an application property. Separating them would need a
generator on a second machine. **Not measured.**

### 18.3 Consequences for what may be concluded

| load level | conclusions that are safe | conclusions that are not |
|---|---|---|
| ≤ 1,000 VUs | everything: latency, throughput, errors, recovery, resource attribution | — |
| 2,500 VUs | direction and rough magnitude | precise error rate |
| ≥ 5,000 VUs | that the application is already far past saturation (independently established at 1,000) | any specific throughput, latency or error figure |

The arrival-rate sweep is the instrument the capacity numbers come from, because
it holds offered load fixed at rates the generator can deliver comfortably.

### 18.4 Other limitations, disclosed

- **PostgreSQL is at stock configuration**: `shared_buffers=128MB`,
  `max_connections=100`, no container CPU or memory limit. Not production-tuned.
- **The rate limiter was disabled** (`NODE_ENV=test` lifts it to 1e6). Production
  runs 300 req/60 s keyed on `(handler, req.ip)` with `trust proxy` unset. Every
  request therefore costs one more Redis round trip in production than it did
  here, and requests behind a shared proxy IP share one bucket. **Not measured.**
- **The dataset is small** — 211 MB, 60,015 appointments, 15,012 customers. Query
  plans that are index-friendly here may not be at 10× the data.
- **No frontend and no TLS** in the path. Production adds a Next.js rewrite and
  TLS termination, both of which add latency this campaign did not measure.
- **The worker process never ran**, by design (Appendix A). Production runs it against
  the same database, adding its own pool.
- **VU-ladder run 2 lost its server-side artifacts.** `run-scenario.sh` was
  edited while bash was still reading it — bash reads a script lazily by byte
  offset, so the post-k6 steps executed at the wrong offset. The k6-side results
  are intact and are what the variance analysis uses; run 2's `monitor.json`,
  `pgstat-*` and `integrity.txt` do not exist. Run 1 has the complete set. Scripts
  were checksummed and frozen before the campaign that followed.
- **Under `API_CLUSTER_WORKERS > 1`, `/api/v1/metrics` is one worker's view.**
  The OS load-balances the listening port, so a Prometheus scrape returns
  whichever worker answered. `db_queries_total` for the 2-worker sweep read
  155,327 against the 1-worker sweep's 359,442 — not because the cluster issued
  fewer queries, but because the scrape saw half of them. Deployment-wide CPU and
  memory in this report come from the OS process table
  (`helpers/api-cpu-snapshot.ps1`), not from `/metrics`. Per-worker event-loop
  lag and heap under clustering are therefore **Not measured** as totals.

---

## 19. Recommended next remediation priorities

Ranked by measured impact per unit of risk. **None of these was implemented in
this phase** — it was measurement-first by instruction.

### P0 — Correctness, not performance

**1. Verify and restore `appointments_no_overlap` in every environment.**
The only thing preventing 495-way double bookings, and it is absent from both
local databases while recorded as applied. One query answers whether production
is affected. Full detail: `MASSIVE_SCALE_FINDINGS.md § MS-001`.
*Impact: prevents silent data corruption. Risk: the ALTER fails if overlapping
rows already exist, which is itself the finding.*

**2. Root-cause the migration drift.** A migration recorded as applied but not
applied is a class of defect, not one instance. Until the cause is known, any
raw-SQL-only migration (indexes, constraints, triggers, functions — none of
which TypeORM can express in entity metadata) may be missing in the same way.
*Impact: unknown until measured — that is the point.*

### P1 — Capacity, highest measured return

**3. Activate `API_CLUSTER_WORKERS=2`.** Measured **+33% sustainable throughput**
(112 → 138 req/s) and p95 at 100 it/s from 11,307 ms to 552 ms. The code is
built, reviewed and validated; it has simply never been switched on. Costs
+17% CPU per request and ~210 MB extra resident memory. At the P0-agreed
production pool of 15, two workers is rolling-deploy safe (80 of 97 usable
connections); **four is not** (140) without lowering `API_DB_POOL_MAX` to ≤ 9.
*Impact: the single largest measured win available. Risk: low — process isolation
was verified against migrations, schedulers, queues and the Socket.IO adapter.*

**4. Fix the readiness probe before raising capacity.** It pings the database
through the same pool the traffic has exhausted, so it answers 503 while the API
is still serving — an orchestrator gating on it would evict or restart a working
instance and push its load onto siblings already in the same state. Confirm first
whether production actually gates on this endpoint (`MS-009`).
*Impact: prevents a degradation from becoming an outage. Risk: low — the change
is a dedicated connection for the probe, not a behaviour change.*

**5. Take bcrypt off the event loop, or at minimum jitter token lifetimes.** A
sustained 2 logins/second consumed ~86% of the single core, and the herd is
self-sustaining because failed re-auths retry immediately (MS-008). Reachable
in production whenever a client cohort expires together or a deploy invalidates
sessions.
*Impact: removes a self-inflicted outage mode that needs no unusual traffic at
all. Risk: moderate — touches the auth hot path, needs its own verification.*

**6. Alert on latency, not error rate.** At the first degradation step the error
rate was 0.24% while p95 went from 472 ms to 11,307 ms. An error-rate alert fires
a full load step after the user experience has already collapsed.
*Impact: detection, not capacity. Risk: none.*

### P2 — Reduce per-request CPU (the actual constraint)

**7. Cache the per-request principal lookup.** 82,943 calls, **44% of all
database time**, ~92 rows per call from a role/permission join fan-out, re-run on
every authenticated request. Also the three feature-flag lookups
(`FeatureFlag` / `FeatureDefinition` / `FeaturePlan`, ~29,900 calls each).
*Impact: unmeasured, but it is the largest single line in the database's bill and
the JSON collapse of 92 rows is API CPU — the constraint. Needs its own
before/after measurement.*

**8. Enqueue follow-up actions from the booking transaction (outbox), not from
listeners that re-acquire a connection.** Under saturation ~2.5% of bookings
silently lost their reminders, notifications and webhooks (`MS-007`). The
payments path already uses an outbox.
*Impact: correctness under load. Risk: moderate — touches the event fan-out.*

### P3 — Only after the above, and only with fresh measurement

**9. Reconsider `API_DB_POOL_MAX`.** Pool 30 on a single process bought +13%,
against +33% for a second process. Worth revisiting *after* clustering is live,
because the right pool size for 2 processes is a different question — and the
connection budget must be recalculated against the worker process and rolling
deploys, not just steady state.

**10. Endpoint-level query work is explicitly NOT recommended yet.** All seven
endpoint classes breach their SLO at the same load step, with their ratios to
each other unchanged. That is a shared-queue signature: optimising any single
endpoint moves the knee by roughly its share of total CPU, which for the biggest
of them is a few percent. Process-level scaling moves it by 33%.

### Deliberately not recommended

- **Do not raise `DB_POOL_MAX` to mask CPU saturation.** Measured: +13% for a 3×
  pool, against +33% for a second process, while consuming connection budget the
  worker and rolling deploys also need.
- **Do not treat the 5,000/10,000-VU results as application limits.** They are
  the lab's transport ceiling (§18).
- **Do not quote a VU number without its think time.** 100 VUs at 3 s think time
  is a healthy system; 100 VUs at 0 s think time saturates it completely.

---

## 20. Exact reproduction commands

`TEST_PASSWORD` lives in the host environment only. It is written to no file,
log, report or k6 output.

### One-time setup

```bash
docker start ziyarati-perfaudit-postgres ziyarati-perfaudit-redis
```

`pg_stat_statements` is not in the stock image's `shared_preload_libraries`;
without it there is no top-SQL table at all:

```bash
for s in "shared_preload_libraries='pg_stat_statements'" "pg_stat_statements.max=10000" "pg_stat_statements.track='all'" "track_io_timing='on'"; do
  docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -c "ALTER SYSTEM SET $s;"
done
docker restart ziyarati-perfaudit-postgres
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

Fixture, cleanup and integrity scripts into the container:

```bash
for f in fixture cleanup integrity-check; do docker cp "tests/load/data/$f.sql" "ziyarati-perfaudit-postgres:/tmp/$f.sql"; done
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/fixture.sql
```

**Install the double-booking guard before any contention run** (see §15 — the lab
was found without it):

```bash
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -c "CREATE EXTENSION IF NOT EXISTS btree_gist; ALTER TABLE \"appointments\" ADD CONSTRAINT \"appointments_no_overlap\" EXCLUDE USING gist (\"staffId\" WITH =, tstzrange(\"start_at\", \"end_at\", '[)') WITH &&) WHERE (status NOT IN ('CANCELLED','NO_SHOW') AND deleted_at IS NULL);"
```

Confirm at boot — the API prints one of two lines and they are unmissable:

```bash
powershell -File tests/load/start-api.ps1
grep -iE "Double-booking guard|MISSING DOUBLE" tests/load/reports/api.log tests/load/reports/api.log.err
```

### The runs

```bash
TEST_PASSWORD='...' tests/load/helpers/run-scenario.sh ladder-run1 vu-ladder.js \
  TEST_TENANTS=50 MIX_PROFILE=prod-mix LEVELS=100,500,1000,2500,5000,10000 \
  RAMP=30s HOLD=60s GAP=30s THINK_MS=3000
```

```bash
TEST_PASSWORD='...' tests/load/helpers/run-scenario.sh contention-guard appointments-write.js \
  TEST_TENANTS=50 RATE=5 DURATION=20s CONTEND_START=30s CONTEND_VUS=500
```

```bash
TEST_PASSWORD='...' tests/load/helpers/run-scenario.sh sweep-w1 progressive-sweep.js \
  TEST_TENANTS=50 MIX_PROFILE=prod-mix RATES=20,30,40,50,60,80,100,120 STEP_DURATION=45s
```

Cluster-worker comparison — restart the API between configurations, nothing else
changes:

```bash
powershell -File tests/load/start-api.ps1 -Workers 2
```

Between every scenario:

```bash
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -f /tmp/cleanup.sql
```

Artifacts per run: `tests/load/reports/massive/<tag>.{k6.log,monitor.json,monitor.log,pgstat-bytime.txt,pgstat-bycalls.txt,integrity.txt,cpu.txt}`
plus the scenario's own JSON at `tests/load/reports/<tag>.json`.

---

## Appendix A — Environment safety — verified before and after every scenario

The suite performs real writes. Safety here is **structural**, not configured:
the API process is a queue *producer only*; every outbound send — WhatsApp,
email, webhooks, workflow actions — happens in the separate worker process, and
no worker was running at any point during this campaign. WhatsApp in particular
cannot be disabled by environment variable (`MetaWhatsappProvider` is the sole
registered provider and its `supports()` is hardcoded `true`), so "no worker"
plus "no `whatsapp_accounts` rows" is the guarantee.

Verified before the campaign and re-verified by `data/integrity-check.sql` §7
after **every** scenario:

| table | rows, every check |
|---|---|
| `notification_rules` | 0 |
| `webhook_endpoints` | 0 |
| `workflows` | 0 |
| `whatsapp_accounts` with a non-empty token | 0 |
| `scheduled_notifications` created in the last 2 h | 0 |
| `payments` created in the last 2 h | 0 |
| `payment_links` created in the last 2 h | 0 |

Additional controls, all defence-in-depth on top of the above:

- Dedicated database `ziyarati_perf` on an isolated container (port 5434), never
  the development or production database.
- `start-api.ps1` blanks `OPENAI_API_KEY`, `RESEND_API_KEY` and
  `MOYASAR_SECRET_KEY`, sets `EMAIL_ENABLED=false` and `PAYMENT_PROVIDER=noop`,
  forcing every provider factory down its Noop branch.
- `QUEUE_ENV_PREFIX=loadtest` namespaces every BullMQ key so nothing this run
  enqueues could be consumed by a real worker.
- Routes deliberately excluded from every scenario: the Moyasar webhook (it
  fails **open** outside production and can mark payments PAID), WhatsApp
  webhooks, patient-action token routes, `forgot-password`, `register-owner`
  (both send real email) and `POST /ai/orchestrator/message` (real token spend).
- Every row the suite creates carries `notes='k6-load-test'`;
  `data/cleanup.sql` removes exactly those and can never touch the 60,015 seeded
  appointments. Cleanup was run between every scenario.
- No production credential was used. Test-account passwords come from the host
  environment only and appear in no file, log, report or k6 output.

The BullMQ backlog the runs *did* create is visible and bounded: `*:delayed`
reached 15 entries (appointment reminders) with `*:wait` and `*:active` at 0 —
jobs accumulated in Redis with nothing to consume them, exactly as intended.

---

## Appendix B — Benchmark methodology

Same machine, same database, same dataset, same code revision, same scenario,
same duration, same ramp pattern for every comparison in this report. Specific
controls applied:

- **The dataset is restored between scenarios.** Write scenarios book real
  appointments, and because the list endpoint orders by `start_at DESC` those
  far-future rows sort ahead of the seeded data — a later read scenario would be
  reading a different dataset. `cleanup.sql` ran between every run.
- **`pg_stat_statements` is reset immediately before each run**, so a run's
  top-SQL table is that run's statements and not a carry-over from the previous
  one.
- **The monitor starts before k6 and stops with it**, covering ramp-up and drain
  rather than only steady state.
- **Comparisons never cross sessions.** The P0 phase established this the hard
  way: an apparent +8 ms regression turned out to be an archived baseline from a
  different session, and the real delta was +1.7 ms. Every before/after pair here
  was produced in this session, back to back.
- **Important scenarios were run at least twice.** The full VU ladder was run
  twice under identical configuration; both runs are reported and the variance is
  stated rather than averaged away.
- **Warm-up, and where it was missing.** The ladders were warm: the API had
  already served the smoke and contention runs before any reported level began.
  The *sweeps*, however, restart the API per configuration and their first step
  is therefore cold — visible in the 4-worker high-rate run, whose 120 it/s step
  measured p95 6,232 ms against 5,586 ms at the *higher* 150 it/s step and
  1,962 ms at the same rate in the warm sweep. Four processes means four sets of
  cold caches and un-warmed JIT paid at once. That row is treated as an anomaly
  rather than a data point (capacity matrix § 3.4), and a dedicated warm-up step
  is the obvious fix for any repeat run.
- **Step ordering matters near the knee.** A sweep step inherits the previous
  step's backlog: 120 it/s measured p95 4,737 ms when it followed a 100 it/s step
  that was already queueing, and 1,319 ms as the first step of its own run. The
  5 s inter-step gap does not always drain the queue.

### Generator-side vs server-side failures — the distinction used throughout

| symptom | side | meaning |
|---|---|---|
| `dropped_iterations` | **generator** | k6 could not start work it had scheduled; offered load was *below* target. Not a server failure — the opposite. |
| `dial: i/o timeout` | **transport** | the TCP connect never completed. On this host that is ephemeral-port exhaustion or Docker NAT, not the application refusing work. Counted in k6's `http_req_failed`. |
| HTTP 5xx | **server** | the application accepted the request and failed it. Every 5xx in this campaign was pg-pool's `connectionTimeoutMillis`. |
| HTTP 409 on booking | **server, and correct** | `SLOT_ALREADY_BOOKED` / `STAFF_NOT_AVAILABLE`. Counted separately from failures. |
| HTTP 403/404 on the isolation probe | **server, and correct** | the probe's expected outcome; excluded from `http_req_failed` via `responseCallback`. |

A level whose errors are dominated by `dial: i/o timeout` is **not** reported as
an application failure. §18 states where that line falls.
